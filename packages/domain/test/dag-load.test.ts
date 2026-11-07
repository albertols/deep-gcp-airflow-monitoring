import { describe, expect, it } from 'vitest';
import { dagLoadByHour, type TaskTry } from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 0, 0, 0);
const MIN = 60_000;
const H = 60 * MIN;

const run = (dagId: string, start: number, end: number | null, poolSlots = 1): TaskTry => ({
  dagId,
  taskId: 'load',
  runId: 'scheduled__2026-11-05T00:00:00+00:00',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots,
  startAt: start,
  endAt: end,
});

const hours = (cells: Record<number, number>, fill: number | null = 0) =>
  Array.from({ length: 24 }, (_, h) => cells[h] ?? fill);

describe('dagLoadByHour (FR-DAGX-06)', () => {
  it('FR-DAGX-06: mean executor slots per UTC hour of day over the days of history, top N by slot-seconds', () => {
    const tries = [
      // 01:00–02:30 on day one, with pool_slots 3: still one executor slot.
      run('acme_orders_daily', T0 + H, T0 + 2.5 * H, 3),
      // 23:30 on day one to 00:30 on day two.
      run('acme_billing_hourly', T0 + 23.5 * H, T0 + 24.5 * H),
      run('acme_tiny', T0 + 5 * H, T0 + 5 * H + MIN),
    ];
    const load = dagLoadByHour(tries, { from: T0, to: T0 + 48 * H, now: T0 + 48 * H, top: 2 });
    expect(load.coveredHours).toEqual(hours({}, 2));
    expect(load.dagCount).toBe(3);
    expect(load.totalExecutorSlotSeconds).toBe(151 * 60);
    expect(load.dags).toEqual([
      {
        dagId: 'acme_orders_daily',
        executorSlotSeconds: 90 * 60,
        share: 90 / 151,
        hours: hours({ 1: 0.5, 2: 0.25 }),
      },
      {
        dagId: 'acme_billing_hourly',
        executorSlotSeconds: 60 * 60,
        share: 60 / 151,
        hours: hours({ 0: 0.25, 23: 0.25 }),
      },
    ]);
  });

  it('FR-DAGX-06 / NFR-DATA-03: hours of day without history are null, not zero; running tries end now', () => {
    const now = T0 + 48 * H;
    const load = dagLoadByHour(
      [run('acme_orders_daily', T0 + 37 * H, T0 + 38 * H), run('acme_billing_hourly', now - 30 * MIN, null)],
      { from: T0, to: now, now, historyFrom: T0 + 36 * H, top: 10 },
    );
    expect(load.coveredHours).toEqual(hours({}, 0).map((_, h) => (h >= 12 ? 1 : 0)));
    const orders = load.dags.find((d) => d.dagId === 'acme_orders_daily');
    expect(orders?.hours).toEqual(hours({}, null).map((_, h) => (h < 12 ? null : h === 13 ? 1 : 0)));
    expect(load.dags.find((d) => d.dagId === 'acme_billing_hourly')?.hours[23]).toBe(0.5);

    const none = dagLoadByHour([], { from: T0, to: now, now, historyFrom: null, top: 10 });
    expect(none).toEqual({ coveredHours: hours({}, 0), totalExecutorSlotSeconds: 0, dagCount: 0, dags: [] });
  });

  it('FR-DAGX-06: tries are clipped to the range; tries that never started are left out', () => {
    const load = dagLoadByHour(
      [run('acme_orders_daily', T0 - H, T0 + 30 * MIN), { ...run('acme_never', T0, T0 + H), startAt: null }],
      { from: T0, to: T0 + 24 * H, now: T0 + 24 * H, top: 10 },
    );
    expect(load.dags).toEqual([
      { dagId: 'acme_orders_daily', executorSlotSeconds: 1800, share: 1, hours: hours({ 0: 0.5 }) },
    ]);
  });
});
