import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_LIMIT,
  dagRunProfiles,
  loadForecast,
  type DagMeta,
  type DemandTry,
  type EnvironmentConfig,
} from '../src/index';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Thursday 5 November 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 5, 12, 0);
const READ_FROM = NOW - 28 * DAY;
const HISTORY_FROM = NOW - 20 * DAY;
/** UTC midnight `d` days before NOW's day. */
const day = (d: number) => Date.UTC(2026, 10, 5 - d);

const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 30,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 10,
  minWorkers: 1,
  maxWorkers: 2,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'etl', slots: 4 },
  ],
};

const dag = (dagId: string, schedule: string, paused = false): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme'],
  tags: [],
  team: 'acme',
  schedule,
  maxActiveTasks: 16,
  maxActiveRuns: 16,
  catchup: false,
  paused,
});

let task = 0;
const tryOf = (
  dagId: string,
  runId: string,
  queuedAt: number,
  endAt: number | null,
  p: Partial<DemandTry> = {},
): DemandTry => ({
  dagId,
  runId,
  taskId: `task_${task++}`,
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  queuedAt,
  startAt: queuedAt,
  endAt,
  ...p,
});
const times = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * - acme_batch_nightly (`30 1 * * *`, pool etl): 20 scheduled runs, 24 or 26 tries each from 01:30 to 02:00, plus
 *   one manual run (baseline). History 19.4 days: normal confidence. p10 24, p50 25, p90 26 for 30 minutes.
 * - acme_orders_hourly (`0 * * * *`): three days of hourly runs, one try for 10 minutes: low confidence.
 * - acme_adhoc (`None`): every day 14:00–15:00, one try: unscheduled demand (baseline).
 * - acme_paused: paused, ignored. acme_new (`15 3 * * *`): planned, no history.
 */
function history(): { dags: DagMeta[]; tries: DemandTry[] } {
  const tries: DemandTry[] = [];
  for (const d of times(20)) {
    const start = day(d) + 90 * MIN;
    const runId = `scheduled__${new Date(start - DAY).toISOString()}`;
    for (const i of times(d % 2 === 0 ? 24 : 26))
      tries.push(
        tryOf('acme_batch_nightly', runId, start, start + 30 * MIN, { pool: 'etl', taskId: `rebuild_${i}` }),
      );
  }
  // A manual run on Thursday 29 October, 15:00–15:30, two tries: unscheduled demand of a cron DAG.
  const manual = Date.UTC(2026, 9, 29, 15, 0);
  for (const i of times(2))
    tries.push(
      tryOf('acme_batch_nightly', 'manual__2026-10-29T15:00:00+00:00', manual, manual + 30 * MIN, {
        taskId: `backfill_${i}`,
      }),
    );
  for (let t = NOW - 3 * DAY; t < NOW; t += H)
    tries.push(tryOf('acme_orders_hourly', `scheduled__${new Date(t - H).toISOString()}`, t, t + 10 * MIN));
  for (const d of times(19).map((i) => i + 1)) {
    const start = day(d) + 14 * H;
    tries.push(tryOf('acme_adhoc', `manual__${new Date(start).toISOString()}`, start, start + H));
  }
  tries.push(tryOf('acme_paused', 'scheduled__x', NOW - 2 * H, NOW - H));
  return {
    dags: [
      dag('acme_batch_nightly', '30 1 * * *'),
      dag('acme_orders_hourly', '0 * * * *'),
      dag('acme_adhoc', 'None'),
      dag('acme_paused', '0 * * * *', true),
      dag('acme_new', '15 3 * * *'),
    ],
    tries,
  };
}

const forecast = (over: Partial<Parameters<typeof loadForecast>[0]> = {}) => {
  const { dags, tries } = history();
  return loadForecast({
    config,
    dags,
    tries,
    now: NOW,
    historyReadFrom: READ_FROM,
    historyFrom: HISTORY_FROM,
    stepMinutes: 5,
    ...over,
  });
};
/** Index of a forecast step from its UTC time on 5 or 6 November. */
const step = (dayOfMonth: number, hour: number, minute = 0) =>
  (Date.UTC(2026, 10, dayOfMonth, hour, minute) - NOW) / (5 * MIN);

describe('dagRunProfiles (HM-010)', () => {
  it('HM-010: p10, p50 and p90 per minute since run start across runs; finished runs count as zero', () => {
    const tries = [10, 20, 30, 40].map((minutes, i) => {
      const start = NOW - (i + 1) * DAY;
      return tryOf('acme_orders_daily', `scheduled__${i}`, start, start + minutes * MIN);
    });
    const profile = dagRunProfiles(tries, { readFrom: READ_FROM }).get('acme_orders_daily');
    expect(profile?.runs).toBe(4);
    const at = (k: number) => [profile?.p10[k], profile?.p50[k], profile?.p90[k]];
    expect(at(5)).toEqual([1, 1, 1]);
    // Values [0, 1, 1, 1], type-7 percentiles: p10 at rank 0.3.
    expect(at(15)[0]).toBeCloseTo(0.3, 9);
    expect(at(15).slice(1)).toEqual([1, 1]);
    expect(at(25)).toEqual([0, 0.5, 1]);
    expect(at(35)[2]).toBeCloseTo(0.7, 9);
    expect(at(35).slice(0, 2)).toEqual([0, 0]);
    expect(profile?.p50.length).toBe(40);
  });

  it('HM-010: a run starts at its first queued try; minutes are split by the share of the minute held', () => {
    const start = NOW - DAY + 30_000;
    const tries = [
      tryOf('acme_orders_daily', 'scheduled__a', start, start + MIN),
      tryOf('acme_orders_daily', 'scheduled__a', start + 90_000, start + 150_000, {
        startAt: start + 100_000,
      }),
    ];
    const profile = dagRunProfiles(tries, { readFrom: READ_FROM }).get('acme_orders_daily');
    expect([...(profile?.p50 ?? [])]).toEqual([1, 0.5, 0.5]);
  });

  it('HM-010: only finished scheduled runs that start inside the history read are profiled', () => {
    const start = NOW - 2 * H;
    const tries = [
      tryOf('acme_orders_daily', 'scheduled__running', start, null),
      tryOf('acme_orders_daily', 'scheduled__running', start, start + MIN),
      tryOf('acme_orders_daily', 'manual__2026-11-05T10:00:00+00:00', start, start + MIN),
      tryOf('acme_orders_daily', 'scheduled__old', READ_FROM - MIN, READ_FROM + 10 * MIN),
    ];
    expect(dagRunProfiles(tries, { readFrom: READ_FROM }).get('acme_orders_daily')).toBeUndefined();
  });

  it('HM-010: pool demand is profiled per pool with pool_slots (p50)', () => {
    const start = NOW - DAY;
    const tries = [
      tryOf('acme_orders_daily', 'scheduled__a', start, start + MIN, { pool: 'etl', poolSlots: 3 }),
      tryOf('acme_orders_daily', 'scheduled__a', start, start + MIN),
    ];
    const profile = dagRunProfiles(tries, { readFrom: READ_FROM }).get('acme_orders_daily');
    expect([...(profile?.p50 ?? [])]).toEqual([2]);
    expect([...(profile?.pools.get('etl') ?? [])]).toEqual([3]);
    expect([...(profile?.pools.get('default_pool') ?? [])]).toEqual([1]);
  });
});

describe('loadForecast (HM-010, FR-BOTL-05)', () => {
  it('HM-010: each planned run adds its DAG’s profile at its planned start (p10, p50, p90)', () => {
    const f = forecast();
    expect(f.evaluated).toBe(true);
    expect(f.from).toBe(NOW);
    expect(f.to).toBe(NOW + DAY);
    expect(f.series).toHaveLength(288);
    // 01:30–02:00 on 6 November: the nightly batch (24, 25, 26) and nothing else.
    expect(f.series[step(6, 1, 30)]).toEqual({
      start: Date.UTC(2026, 10, 6, 1, 30),
      p10: 24,
      p50: 25,
      p90: 26,
      baseline: 0,
    });
    expect(f.series[step(6, 1, 55)]?.p50).toBe(25);
    expect(f.series[step(6, 2, 0)]?.p50).toBe(1);
    // An hourly run: one slot for its first 10 minutes.
    expect(f.series[step(5, 13, 5)]?.p50).toBe(1);
    expect(f.series[step(5, 13, 10)]?.p50).toBe(0);
    expect(f.plannedRuns).toBe(1 + 24 + 1);
    expect(f.runsProfiled).toBe(20 + 72);
  });

  it('HM-010: the hour-of-week baseline adds unscheduled demand: manual runs and DAGs without cron', () => {
    const f = forecast();
    // Thursday 14:15 (the hourly run ended at 14:10): acme_adhoc ran in both covered weeks (22 and 29 October): one slot.
    expect(f.series[step(5, 14, 15)]).toMatchObject({ p10: 1, p50: 1, p90: 1, baseline: 1 });
    // Thursday 15:00: the manual run held two slots for 30 of the 120 covered minutes.
    expect(f.series[step(5, 15, 0)]?.baseline).toBe(0.5);
    expect(f.baseline).toEqual({ method: 'hour-of-week', slotMinutes: 90, weeks: 20 / 7 });
    expect(f.unscheduledDags).toBe(1);
  });

  it('FR-BOTL-05: saturation windows are p50 above capacity at max_count for ≥ 15 minutes; risk windows use p90', () => {
    const f = forecast();
    expect(f.capacity).toEqual({ workerSlotsAtMax: 20, parallelism: 30 });
    const window = {
      start: Date.UTC(2026, 10, 6, 1, 30),
      end: Date.UTC(2026, 10, 6, 2, 0),
      minutes: 30,
      capacity: 20,
      lowConfidence: false,
      topDags: [{ dagId: 'acme_batch_nightly', slotMinutes: 750, share: 1, lowConfidence: false }],
    };
    expect(f.saturation).toEqual({ evaluated: true, reason: null, windows: [{ ...window, peak: 25 }] });
    expect(f.risk.windows).toEqual([
      { ...window, peak: 26, topDags: [{ ...window.topDags[0], slotMinutes: 780 }] },
    ]);
  });

  it('HM-010: under 14 days of history a DAG’s contribution is low confidence; no history is not zero', () => {
    const f = forecast();
    const byId = new Map(f.dags.map((d) => [d.dagId, d]));
    expect(byId.get('acme_batch_nightly')).toMatchObject({
      plannedRuns: 1,
      runsProfiled: 20,
      lowConfidence: false,
      slotMinutes: 750,
      peakP50: 25,
    });
    expect(byId.get('acme_batch_nightly')?.historyDays).toBeCloseTo(19 + 10.5 / 24, 9);
    expect(byId.get('acme_orders_hourly')).toMatchObject({
      plannedRuns: 24,
      runsProfiled: 72,
      historyDays: 3,
      lowConfidence: true,
      slotMinutes: 240,
    });
    expect(byId.get('acme_new')).toMatchObject({
      plannedRuns: 1,
      runsProfiled: 0,
      historyDays: null,
      lowConfidence: true,
      slotMinutes: null,
      peakP50: null,
    });
    expect(byId.has('acme_paused')).toBe(false);
    expect(f.dags[0]?.dagId).toBe('acme_batch_nightly');
    expect(f.dagsWithoutHistory).toBe(1);
    expect(f.lowConfidenceShare).toBeCloseTo(240 / 990, 9);
    expect(f.historyDays).toBe(20);
  });

  it('HM-010: pool demand from scheduled runs is compared with pool sizes', () => {
    const f = forecast();
    const etl = f.pools.find((p) => p.name === 'etl');
    expect(etl).toMatchObject({
      slots: 4,
      peakP50: 25,
      peakAt: Date.UTC(2026, 10, 6, 1, 30),
      minutesOver: 30,
    });
    expect(etl?.series).toHaveLength(96);
    expect(etl?.series[(Date.UTC(2026, 10, 6, 1, 30) - NOW) / (15 * MIN)]).toBe(25);
    expect(f.pools.find((p) => p.name === 'default_pool')).toMatchObject({ peakP50: 1, minutesOver: 0 });
  });

  it('HM-010: a run planned before now still adds the rest of its profile', () => {
    const start = Date.UTC(2026, 10, 4, 11, 0);
    const tries = times(3).map(() => tryOf('acme_ml_daily', 'scheduled__y', start, start + 2 * H));
    const f = loadForecast({
      config,
      dags: [dag('acme_ml_daily', '0 11 * * *')],
      tries,
      now: NOW,
      historyReadFrom: READ_FROM,
      historyFrom: start,
      stepMinutes: 5,
    });
    // Today's 11:00 run is an hour in: three slots until 13:00; tomorrow's 11:00 run from 11:00.
    expect(f.series[0]?.p50).toBe(3);
    expect(f.series[step(5, 12, 55)]?.p50).toBe(3);
    expect(f.series[step(5, 13, 0)]?.p50).toBe(0);
    expect(f.series[step(6, 11, 0)]?.p50).toBe(3);
    expect(f.dags[0]?.slotMinutes).toBe(3 * 60 + 3 * 60);
  });

  it('HM-010: an hour of week never observed falls back to the same hour of the day', () => {
    const start = NOW - 22 * H;
    const f = loadForecast({
      config,
      dags: [dag('acme_adhoc', 'None')],
      tries: [tryOf('acme_adhoc', 'manual__a', start, start + H)],
      now: NOW,
      historyReadFrom: READ_FROM,
      historyFrom: NOW - DAY,
      stepMinutes: 5,
    });
    expect(f.baseline.method).toBe('hour-of-day');
    expect(f.series[step(5, 14, 0)]?.baseline).toBe(1);
    expect(f.series[step(5, 15, 0)]?.baseline).toBe(0);
  });

  it('HM-032 / NFR-DATA-03: unknown worker_concurrency leaves saturation not evaluated; no history, no forecast', () => {
    const unknown = forecast({
      config: { ...config, workerConcurrency: UNKNOWN_LIMIT, limitSources: { workerConcurrency: 'unknown' } },
    });
    expect(unknown.capacity.workerSlotsAtMax).toBeNull();
    expect(unknown.saturation.evaluated).toBe(false);
    expect(unknown.saturation.reason).toMatch(/worker_concurrency/);
    expect(unknown.saturation.windows).toEqual([]);

    const none = forecast({ tries: [], historyFrom: null });
    expect(none.evaluated).toBe(false);
    expect(none.reason).toMatch(/history/);
    expect(none.series.every((s) => s.p50 === null && s.baseline === null)).toBe(true);
    expect(none.saturation.evaluated).toBe(false);
    expect(none.dagsWithoutHistory).toBe(3);
  });
});
