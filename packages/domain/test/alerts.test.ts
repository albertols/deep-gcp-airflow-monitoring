import { describe, expect, it } from 'vitest';
import { breaches, evaluateAlert, type AlertCondition, type ConditionPoint } from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
const MIN = 60_000;
/** AL-05 shape (spec §16.1): ≥ 10 for 15 min, clear after 10 min, keep state on no data. */
const atLeastTen: AlertCondition = {
  comparator: '>=',
  threshold: 10,
  forMs: 15 * MIN,
  clearForMs: 10 * MIN,
  noData: 'keep_state',
};
/** One evaluation per minute from T0, one value per minute. */
const series = (
  values: ReadonlyArray<number | null>,
  extra: Partial<ConditionPoint> = {},
): ConditionPoint[] => values.map((value, i) => ({ at: T0 + i * MIN, value, ...extra }));
const repeat = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

describe('alert state machine (spec §16.2)', () => {
  it('FR-ALRT-01: compares the value with the threshold using the rule comparator', () => {
    expect(breaches({ comparator: '>=', threshold: 10 }, 10)).toBe(true);
    expect(breaches({ comparator: '>', threshold: 10 }, 10)).toBe(false);
    expect(breaches({ comparator: '<', threshold: 0.9 }, 0.89)).toBe(true);
    expect(breaches({ comparator: '<=', threshold: 0.9 }, 0.91)).toBe(false);
  });

  it('FR-ALRT-01: a condition true for less than `for` is pending, never firing', () => {
    const r = evaluateAlert(atLeastTen, series([...repeat(3, 0), ...repeat(10, 12)]));
    expect(r.state).toBe('pending');
    expect(r.since).toBe(T0 + 3 * MIN);
    expect(r.value).toBe(12);
    expect(r.firedCount).toBe(0);
    expect(r.events).toEqual([]);
  });

  it('FR-ALRT-01: fires once the condition has held for `for`, and exactly once while it holds', () => {
    const r = evaluateAlert(atLeastTen, series([0, ...repeat(16, 12), ...repeat(40, 30), 11]));
    expect(r.state).toBe('firing');
    expect(r.since).toBe(T0 + 16 * MIN);
    expect(r.firedCount).toBe(1);
    expect(r.events).toEqual([{ kind: 'fired', at: T0 + 16 * MIN, value: 12 }]);
  });

  it('FR-ALRT-01: a pending alert whose condition clears before `for` returns to inactive without an event', () => {
    const r = evaluateAlert(atLeastTen, series([...repeat(10, 12), 0, 0]));
    expect(r.state).toBe('inactive');
    expect(r.since).toBeNull();
    expect(r.events).toEqual([]);
  });

  it('FR-ALRT-01: hysteresis: a firing alert resolves only after the condition is false for `clearFor`', () => {
    const dip = evaluateAlert(atLeastTen, series([...repeat(16, 12), ...repeat(9, 0), 12]));
    expect(dip.state).toBe('firing');
    expect(dip.events).toHaveLength(1);

    const cleared = evaluateAlert(atLeastTen, series([...repeat(16, 12), ...repeat(11, 0)]));
    expect(cleared.state).toBe('resolved');
    expect(cleared.since).toBe(T0 + 26 * MIN);
    expect(cleared.events).toEqual([
      { kind: 'fired', at: T0 + 15 * MIN, value: 12 },
      { kind: 'resolved', at: T0 + 26 * MIN, value: 0 },
    ]);
  });

  it('FR-ALRT-01: a resolved alert fires again on a new breach that holds for `for`', () => {
    const r = evaluateAlert(atLeastTen, series([...repeat(16, 12), ...repeat(11, 0), ...repeat(16, 20)]));
    expect(r.state).toBe('firing');
    expect(r.firedCount).toBe(2);
    expect(r.events.map((e) => e.kind)).toEqual(['fired', 'resolved', 'fired']);
  });

  it('FR-ALRT-01: `for` 0 fires on the first breaching evaluation; `clearFor` 0 resolves on the first clear one', () => {
    const instant: AlertCondition = { ...atLeastTen, forMs: 0, clearForMs: 0 };
    const r = evaluateAlert(instant, series([0, 12, 0]));
    expect(r.events).toEqual([
      { kind: 'fired', at: T0 + MIN, value: 12 },
      { kind: 'resolved', at: T0 + 2 * MIN, value: 0 },
    ]);
  });

  it('FR-ALRT-01: a combined condition breaches only when its gate also holds (workers at max)', () => {
    const points = series(repeat(20, 50)).map((p, i) => ({ ...p, gate: i >= 10 }));
    const r = evaluateAlert(atLeastTen, points);
    expect(r.state).toBe('pending');
    expect(r.since).toBe(T0 + 10 * MIN);
  });

  it('§16.2: a stale source moves the alert to unknown; DCAM never resolves on data it does not have', () => {
    const stale: ConditionPoint[] = repeat(20, 0).map((_, i) => ({
      at: T0 + (16 + i) * MIN,
      value: null,
      stale: true,
    }));
    const firing = series(repeat(16, 12));
    const r = evaluateAlert(atLeastTen, [...firing, ...stale]);
    expect(r.state).toBe('unknown');
    expect(r.since).toBe(T0 + 16 * MIN);
    expect(r.value).toBeNull();
    expect(r.events.map((e) => e.kind)).toEqual(['fired']);

    const back = evaluateAlert(atLeastTen, [...firing, ...stale, { at: T0 + 36 * MIN, value: 15 }]);
    expect(back.state).toBe('firing');
    expect(back.since).toBe(T0 + 15 * MIN);
    expect(back.firedCount).toBe(1);
  });

  it('§16.2: a pending alert restarts its `for` timer after a stale gap', () => {
    const points = [
      ...series(repeat(10, 12)),
      { at: T0 + 10 * MIN, value: null, stale: true },
      ...series(repeat(10, 12)).map((p) => ({ ...p, at: p.at + 11 * MIN })),
    ];
    const r = evaluateAlert(atLeastTen, points);
    expect(r.state).toBe('pending');
    expect(r.since).toBe(T0 + 11 * MIN);
  });

  it('§16.1 noData: `ok` treats a missing value as clear, `alerting` as a breach, `keep_state` holds', () => {
    const values = [...repeat(16, 12), ...repeat(11, null)];
    expect(evaluateAlert({ ...atLeastTen, noData: 'ok' }, series(values)).state).toBe('resolved');
    expect(evaluateAlert({ ...atLeastTen, noData: 'keep_state' }, series(values)).state).toBe('firing');
    const absent = evaluateAlert({ ...atLeastTen, noData: 'alerting' }, series(repeat(16, null)));
    expect(absent.state).toBe('firing');
    expect(absent.events).toEqual([{ kind: 'fired', at: T0 + 15 * MIN, value: null }]);
  });

  it('FR-ALRT-06: reports events and fire counts only from the window start; earlier points warm the state up', () => {
    const points = series([...repeat(16, 12), ...repeat(11, 0), ...repeat(16, 20)]);
    const r = evaluateAlert(atLeastTen, points, { from: T0 + 20 * MIN });
    expect(r.firedCount).toBe(1);
    expect(r.events.map((e) => e.kind)).toEqual(['resolved', 'fired']);
  });

  it('§16.2: an alert with no evaluations is unknown', () => {
    const r = evaluateAlert(atLeastTen, []);
    expect(r).toEqual({ state: 'unknown', since: null, value: null, firedCount: 0, events: [] });
  });
});
