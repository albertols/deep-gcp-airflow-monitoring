import { describe, expect, it } from 'vitest';
import type { AlertEvent, AlertRule } from '@dcam/contracts';
import { firingPeriods, formatTime, meanTimeToResolve, sortRules } from '../src/pages/alerts/model';

const H = 3_600_000;
const FROM = Date.UTC(2026, 10, 4, 12);
const TO = FROM + 24 * H;
const at = (h: number) => new Date(FROM + h * H).toISOString();
const ev = (rule_id: string, kind: AlertEvent['kind'], h: number, env_id = 'acme-prod'): AlertEvent => ({
  id: `${env_id}/${rule_id}/${kind}/${h}`,
  rule_id,
  env_id,
  severity: 'warning',
  kind,
  at: at(h),
  value: 1,
});
const rule = (id: string, state: AlertRule['state'], over: Partial<AlertRule> = {}): AlertRule => ({
  id,
  name: id,
  env_id: 'acme-prod',
  severity: 'warning',
  state,
  condition: '',
  for_seconds: 0,
  threshold: null,
  value: null,
  unit: '',
  since: null,
  summary: '',
  runbook: null,
  export_cloud_monitoring: 'no',
  fired_count_24h: 0,
  ...over,
});

describe('alerts presentation model (spec §16.7)', () => {
  it('FR-ALRT-06: firing periods pair fired with resolved per rule and environment', () => {
    const periods = firingPeriods(
      [
        ev('AL-15', 'fired', 2),
        ev('AL-15', 'resolved', 3),
        ev('AL-15', 'fired', 20),
        ev('AL-05', 'fired', 2, 'acme-test'),
      ],
      [],
      FROM,
      TO,
    );
    expect(periods.map((p) => [p.ruleId, p.envId, p.start, p.end, p.open])).toEqual([
      ['AL-15', 'acme-prod', FROM + 2 * H, FROM + 3 * H, false],
      ['AL-05', 'acme-test', FROM + 2 * H, TO, true],
      ['AL-15', 'acme-prod', FROM + 20 * H, TO, true],
    ]);
  });

  it('FR-ALRT-06: a resolution without a firing in the window started before it; a firing rule without events is shown', () => {
    const periods = firingPeriods(
      [ev('AL-06', 'resolved', 1)],
      [rule('AL-19', 'firing', { since: at(-30) }), rule('AL-06', 'resolved')],
      FROM,
      TO,
    );
    expect(periods.map((p) => [p.ruleId, p.start, p.end, p.open])).toEqual([
      ['AL-06', FROM, FROM + H, false],
      ['AL-19', FROM, TO, true],
    ]);
  });

  it('§16.7: mean time to resolve covers alerts that resolved; still-firing ones are left out', () => {
    expect(
      meanTimeToResolve([
        ev('A', 'fired', 0),
        ev('A', 'resolved', 1),
        ev('B', 'fired', 2),
        ev('B', 'resolved', 5),
      ]),
    ).toEqual({
      seconds: 2 * 3_600,
      count: 2,
    });
    expect(meanTimeToResolve([ev('A', 'fired', 0)])).toEqual({ seconds: null, count: 0 });
  });

  it('FR-ALRT-01: sorts firing, then pending, then the rest, by severity within a state', () => {
    const sorted = sortRules([
      rule('AL-01', 'unknown'),
      rule('AL-02', 'inactive', { severity: 'critical' }),
      rule('AL-03', 'firing', { severity: 'info' }),
      rule('AL-04', 'pending'),
      rule('AL-05', 'firing', { severity: 'critical' }),
      rule('AL-06', 'resolved'),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['AL-05', 'AL-03', 'AL-04', 'AL-06', 'AL-02', 'AL-01']);
  });

  it('§12.7: times read in UTC, with the date when it is not the reference day', () => {
    expect(formatTime('2026-11-05T11:40:00.000Z', '2026-11-05T12:00:00.000Z')).toBe('11:40 UTC');
    expect(formatTime('2026-11-04T23:05:00.000Z', '2026-11-05T12:00:00.000Z')).toBe('4 Nov 23:05 UTC');
  });
});
