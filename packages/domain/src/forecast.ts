/**
 * HM-010 24-hour load forecast (FR-BOTL-05): expected slot demand for the next 24 hours against capacity at
 * `max_count` and against pool sizes, with an uncertainty band and the history it rests on.
 *
 * - **Demand** is running plus executor-queued task instances, as HM-012 defines it: a try wants a slot from its
 *   queued time (else its start) to its end. Ready (`scheduled`) time is not included: Airflow 2.11 does not
 *   record it. Kubernetes-executor tasks are not told apart (DCAM stores no queue per try).
 * - **Run profiles.** For each DAG, its finished scheduled runs (`run_id` prefix `scheduled__`, Airflow's
 *   `DagRunType.SCHEDULED`) that start inside the history read: demand per minute since the run's first queued
 *   try, cut at 24 h. p10, p50 and p90 are taken per minute across runs, a finished run counting as zero.
 * - **Planned runs** are the cron times of unpaused DAGs (`cronTimesBetween`, UTC: DCAM does not collect DAG time
 *   zones). Runs planned before now that are still within their profile add the rest of it.
 * - **Baseline** (unscheduled demand): mean demand per UTC hour of week from manual and other non-scheduled runs
 *   and from DAGs without a cron schedule (timedelta, asset, `None`); an hour of week never observed falls back to
 *   the same hour of the day, and an hour never observed at all is `null`. It is added to p10, p50 and p90 alike.
 * - **Band.** Summing per-DAG percentiles treats the DAGs as moving together, so the band is wider than for
 *   independent DAGs. It is a forecast, an estimate: method `HM-010/run-profiles`.
 * - **Confidence.** A DAG needs ≥ 14 days of history (now − its first try in the read, never before the
 *   environment's history start); otherwise its contribution is low confidence (HM-010 quality).
 * - **Saturation windows** are stretches of ≥ 15 minutes with p50 above the worker slots at `max_count`, the
 *   REC-SCHED-03 condition read as one stretch; risk windows use p90. With `worker_concurrency` unknown (HM-032)
 *   capacity is unknown and neither is evaluated.
 *
 * @implements HM-010, FR-BOTL-05, NFR-DATA-03
 */
import { limitKnown, type DagMeta, type EnvironmentConfig } from './model';
import type { TaskTry } from './occupancy';
import { cronTimesBetween } from './schedule';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
export const FORECAST_HORIZON_MINUTES = 1_440;
/** History the forecast reads (HM-010 needs ≥ 14 days per DAG; more runs steady the percentiles). */
export const FORECAST_HISTORY_DAYS = 28;
export const MIN_FORECAST_HISTORY_DAYS = 14;
/** REC-SCHED-03: "for ≥ 15 min in the next 24 h". */
export const SATURATION_MIN_MINUTES = 15;
const MAX_PROFILE_MINUTES = 1_440;
const TOP_WINDOW_DAGS = 5;
/** Airflow 2 names scheduler-created runs `scheduled__<logical date>` (`DagRunType.SCHEDULED`). */
const SCHEDULED_PREFIX = 'scheduled__';

/** A try with the fields demand needs; `StoredTaskTry` satisfies it. */
export interface DemandTry extends TaskTry {
  readonly queuedAt: number | null;
}

export interface RunProfile {
  /** Runs profiled. */
  readonly runs: number;
  /** Demand per minute since run start, in slots. */
  readonly p10: Float64Array;
  readonly p50: Float64Array;
  readonly p90: Float64Array;
  /** Per pool: p50 pool-slot demand (`pool_slots` per try) per minute since run start. */
  readonly pools: ReadonlyMap<string, Float64Array>;
}

export interface ProfileOptions {
  /** Start of the history read: runs that start before it may have lost their first tries. */
  readonly readFrom: number;
}

const demandStart = (t: DemandTry) =>
  t.startAt === null ? null : t.queuedAt === null ? t.startAt : Math.min(t.queuedAt, t.startAt);

/** Adds `weight × share of each minute held` for `[a, b)` ms since run start; returns the last minute touched. */
function addInterval(buf: Float64Array, a: number, b: number, weight: number): number {
  const end = Math.min(b, MAX_PROFILE_MINUTES * MIN);
  let last = -1;
  for (let k = Math.floor(a / MIN); k * MIN < end; k++) {
    const overlap = Math.min(end, (k + 1) * MIN) - Math.max(a, k * MIN);
    if (overlap <= 0) continue;
    buf[k] = (buf[k] as number) + (weight * overlap) / MIN;
    last = k;
  }
  return last;
}

/** Moves the non-zero minutes `0..last` of `buf` into `offsets` and clears them. */
function collect(buf: Float64Array, last: number, offsets: number[][]) {
  for (let k = 0; k <= last; k++) {
    const v = buf[k] as number;
    if (v === 0) continue;
    (offsets[k] ??= []).push(v);
    buf[k] = 0;
  }
}

/** Type-7 percentiles per minute over `n` runs, the runs without a value at that minute counting as zero. */
function percentiles(offsets: readonly (number[] | undefined)[], n: number, ps: readonly number[]) {
  const out = ps.map(() => new Float64Array(offsets.length));
  offsets.forEach((values, k) => {
    if (!values) return;
    values.sort((a, b) => a - b);
    const zeros = n - values.length;
    const at = (i: number) => (i < zeros ? 0 : (values[i - zeros] as number));
    ps.forEach((p, j) => {
      const rank = p * (n - 1);
      const lo = Math.floor(rank);
      const a = at(lo);
      (out[j] as Float64Array)[k] = a + (at(Math.ceil(rank)) - a) * (rank - lo);
    });
  });
  return out;
}

function profileOf(runs: Iterable<readonly DemandTry[]>, readFrom: number): RunProfile | null {
  const buf = new Float64Array(MAX_PROFILE_MINUTES);
  const poolBufs = new Map<string, { buf: Float64Array; last: number }>();
  const offsets: number[][] = [];
  const poolOffsets = new Map<string, number[][]>();
  let n = 0;
  for (const tries of runs) {
    let start = Infinity;
    let running = false;
    for (const t of tries) {
      if (t.endAt === null) running = true;
      const a = demandStart(t);
      if (a !== null && a < start) start = a;
    }
    if (running || !Number.isFinite(start) || start < readFrom) continue;
    let last = -1;
    for (const t of tries) {
      const a = demandStart(t);
      if (a === null || t.endAt === null || t.endAt <= a) continue;
      last = Math.max(last, addInterval(buf, a - start, t.endAt - start, 1));
      let pool = poolBufs.get(t.pool);
      if (!pool) poolBufs.set(t.pool, (pool = { buf: new Float64Array(MAX_PROFILE_MINUTES), last: -1 }));
      pool.last = Math.max(pool.last, addInterval(pool.buf, a - start, t.endAt - start, t.poolSlots));
    }
    if (last < 0) continue;
    n++;
    collect(buf, last, offsets);
    for (const [name, pool] of poolBufs) {
      if (pool.last < 0) continue;
      let list = poolOffsets.get(name);
      if (!list) poolOffsets.set(name, (list = []));
      collect(pool.buf, pool.last, list);
      pool.last = -1;
    }
  }
  if (n === 0) return null;
  const [p10, p50, p90] = percentiles(offsets, n, [0.1, 0.5, 0.9]) as [
    Float64Array,
    Float64Array,
    Float64Array,
  ];
  const pools = new Map<string, Float64Array>();
  for (const [name, list] of poolOffsets) pools.set(name, percentiles(list, n, [0.5])[0] as Float64Array);
  return { runs: n, p10, p50, p90, pools };
}

/** HM-010: run occupancy profiles of every DAG with a finished scheduled run in the history read. */
export function dagRunProfiles(tries: readonly DemandTry[], opts: ProfileOptions): Map<string, RunProfile> {
  const byDag = new Map<string, Map<string, DemandTry[]>>();
  for (const t of tries) {
    if (!t.runId.startsWith(SCHEDULED_PREFIX)) continue;
    let runs = byDag.get(t.dagId);
    if (!runs) byDag.set(t.dagId, (runs = new Map<string, DemandTry[]>()));
    const run = runs.get(t.runId);
    if (run) run.push(t);
    else runs.set(t.runId, [t]);
  }
  const out = new Map<string, RunProfile>();
  for (const [dagId, runs] of byDag) {
    const profile = profileOf(runs.values(), opts.readFrom);
    if (profile) out.set(dagId, profile);
  }
  return out;
}

export interface ForecastInput {
  readonly config: EnvironmentConfig;
  readonly dags: readonly DagMeta[];
  /** Task tries of the history read, any order. */
  readonly tries: readonly DemandTry[];
  /** The forecast covers the 24 hours from the minute of `now`. */
  readonly now: number;
  /** Start of the history read ({@link FORECAST_HISTORY_DAYS} before now). */
  readonly historyReadFrom: number;
  /** Where the environment's task history starts (`null`: none); absent means it covers the read. */
  readonly historyFrom?: number | null;
  /** Minutes per series step (default 5); each step holds the highest minute in it. */
  readonly stepMinutes?: number;
}

export interface ForecastStep {
  readonly start: number;
  /** Demand in slots: the highest minute of the step; `null` without history. */
  readonly p10: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  /** The baseline's part (unscheduled demand), included in the three above; `null` where never observed. */
  readonly baseline: number | null;
}

export interface WindowContribution {
  readonly dagId: string;
  /** Slot-minutes the DAG's planned runs add in the window (p50; p90 for risk windows). */
  readonly slotMinutes: number;
  /** Share of the window's forecast slot-minutes, baseline included. */
  readonly share: number;
  readonly lowConfidence: boolean;
}

export interface SaturationWindow {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly minutes: number;
  /** Highest forecast demand in the window, slots. */
  readonly peak: number;
  readonly capacity: number;
  /** At least half of the window's run-profile demand comes from low-confidence DAGs. */
  readonly lowConfidence: boolean;
  readonly topDags: readonly WindowContribution[];
}

export interface SaturationCheck {
  readonly evaluated: boolean;
  readonly reason: string | null;
  readonly windows: readonly SaturationWindow[];
}

export interface DagForecast {
  readonly dagId: string;
  readonly schedule: string;
  /** Cron times in the 24 hours ahead. */
  readonly plannedRuns: number;
  readonly runsProfiled: number;
  /** `null` without a try in the history read. */
  readonly historyDays: number | null;
  readonly lowConfidence: boolean;
  /** p50 slot-minutes its runs add in the 24 hours; `null` without a profile (unknown, not zero). */
  readonly slotMinutes: number | null;
  /** Highest p50 demand of one of its runs, slots. */
  readonly peakP50: number | null;
}

export interface PoolForecast {
  readonly name: string;
  readonly slots: number;
  /** Highest p50 pool-slot demand of scheduled runs; `null` without history. */
  readonly peakP50: number | null;
  readonly peakAt: number | null;
  /** Minutes with p50 pool-slot demand above the pool's slots. */
  readonly minutesOver: number | null;
  /** Highest p50 per 15 minutes (96 entries). */
  readonly series: readonly (number | null)[];
}

export type BaselineMethod = 'hour-of-week' | 'hour-of-day' | 'none';

export interface LoadForecast {
  readonly from: number;
  readonly to: number;
  readonly stepMinutes: number;
  readonly evaluated: boolean;
  readonly reason: string | null;
  readonly series: readonly ForecastStep[];
  readonly capacity: { readonly workerSlotsAtMax: number | null; readonly parallelism: number | null };
  readonly saturation: SaturationCheck;
  readonly risk: SaturationCheck;
  /** Unpaused cron DAGs with a planned run or a running one, by p50 slot-minutes (unknown last). */
  readonly dags: readonly DagForecast[];
  readonly plannedRuns: number;
  readonly runsProfiled: number;
  /** DAGs with planned runs and no profiled run: their demand is unknown. */
  readonly dagsWithoutHistory: number;
  /** Unpaused DAGs without a cron schedule: their demand is in the baseline. */
  readonly unscheduledDags: number;
  readonly historyFrom: number | null;
  readonly historyDays: number;
  /** Share of the run-profile p50 slot-minutes from low-confidence DAGs; `null` without any. */
  readonly lowConfidenceShare: number | null;
  readonly baseline: {
    readonly method: BaselineMethod;
    readonly slotMinutes: number;
    readonly weeks: number;
  };
  readonly pools: readonly PoolForecast[];
}

const NO_HISTORY =
  'DCAM has no task history for this environment yet, so there are no past runs to forecast from. The forecast starts after the first collection cycles.';
const NO_CONCURRENCY =
  'worker_concurrency is not known (no override in the Composer configuration), so the worker slots at max_count are unknown (HM-032).';

const hourOfDay = (t: number) => Math.floor((((t % DAY) + DAY) % DAY) / HOUR);
const hourOfWeek = (t: number) => Math.floor((((t % WEEK) + WEEK) % WEEK) / HOUR);

/** Adds the ms of `[a, b)` per absolute hour from `hourFrom` to `bins`. */
function spreadHours(bins: Float64Array, hourFrom: number, a: number, b: number, weight: number) {
  for (let t = a; t < b;) {
    const h = Math.floor((t - hourFrom) / HOUR);
    const next = Math.min(b, hourFrom + (h + 1) * HOUR);
    if (h >= 0 && h < bins.length) bins[h] = (bins[h] as number) + weight * (next - t);
    t = next;
  }
}

interface Baseline {
  readonly values: (number | null)[];
  readonly method: BaselineMethod;
}

function baselineOf(
  tries: readonly DemandTry[],
  coveredFrom: number,
  now: number,
  start: number,
  minutes: number,
): Baseline {
  const hourFrom = Math.floor(coveredFrom / HOUR) * HOUR;
  const hours = Math.max(0, Math.ceil((now - hourFrom) / HOUR));
  const demand = new Float64Array(hours);
  const covered = new Float64Array(hours);
  spreadHours(covered, hourFrom, coveredFrom, now, 1);
  for (const t of tries) {
    const a = demandStart(t);
    if (a === null) continue;
    const from = Math.max(a, coveredFrom);
    const to = Math.min(t.endAt ?? now, now);
    if (to > from) spreadHours(demand, hourFrom, from, to, 1);
  }
  const week = { demand: new Float64Array(168), covered: new Float64Array(168) };
  const day = { demand: new Float64Array(24), covered: new Float64Array(24) };
  for (let h = 0; h < hours; h++) {
    const t = hourFrom + h * HOUR;
    const w = hourOfWeek(t);
    const d = hourOfDay(t);
    week.demand[w] = (week.demand[w] as number) + (demand[h] as number);
    week.covered[w] = (week.covered[w] as number) + (covered[h] as number);
    day.demand[d] = (day.demand[d] as number) + (demand[h] as number);
    day.covered[d] = (day.covered[d] as number) + (covered[h] as number);
  }
  let weakest = 0;
  const values = Array.from({ length: minutes }, (_, i) => {
    const t = start + i * MIN;
    const w = hourOfWeek(t);
    if ((week.covered[w] as number) > 0) return (week.demand[w] as number) / (week.covered[w] as number);
    const d = hourOfDay(t);
    if ((day.covered[d] as number) > 0) {
      weakest = Math.max(weakest, 1);
      return (day.demand[d] as number) / (day.covered[d] as number);
    }
    weakest = 2;
    return null;
  });
  return { values, method: (['hour-of-week', 'hour-of-day', 'none'] as const)[weakest] as BaselineMethod };
}

/** Stretches of ≥ {@link SATURATION_MIN_MINUTES} minutes with `demand[i] > capacity`, as `[start, end)` indices. */
function stretchesAbove(demand: Float64Array, capacity: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open = -1;
  for (let i = 0; i <= demand.length; i++) {
    const above = i < demand.length && (demand[i] as number) > capacity;
    if (above && open < 0) open = i;
    if (!above && open >= 0) {
      if (i - open >= SATURATION_MIN_MINUTES) out.push([open, i]);
      open = -1;
    }
  }
  return out;
}

interface Placed {
  readonly meta: DagMeta;
  readonly profile: RunProfile;
  /** Minute offsets of its planned starts from the forecast start (negative: before now). */
  readonly starts: readonly number[];
  readonly lowConfidence: boolean;
  readonly prefix50: Float64Array;
  readonly prefix90: Float64Array;
}

const prefixOf = (xs: Float64Array) => {
  const out = new Float64Array(xs.length + 1);
  for (let k = 0; k < xs.length; k++) out[k + 1] = (out[k] as number) + (xs[k] as number);
  return out;
};

/** Slot-minutes `d` adds in minutes `[a, b)` of the forecast. */
function within(d: Placed, prefix: Float64Array, a: number, b: number): number {
  const length = prefix.length - 1;
  let sum = 0;
  for (const o of d.starts) {
    const lo = Math.max(0, a - o);
    const hi = Math.min(length, b - o);
    if (hi > lo) sum += (prefix[hi] as number) - (prefix[lo] as number);
  }
  return sum;
}

export function loadForecast(input: ForecastInput): LoadForecast {
  const { config, now } = input;
  const N = FORECAST_HORIZON_MINUTES;
  const stepMinutes = input.stepMinutes ?? 5;
  const start = Math.floor(now / MIN) * MIN;
  const end = start + N * MIN;
  const history = input.historyFrom === undefined ? input.historyReadFrom : input.historyFrom;
  const coveredFrom = history === null ? null : Math.max(history, input.historyReadFrom);
  const evaluated = coveredFrom !== null && coveredFrom < now;
  const historyDays = evaluated ? (now - coveredFrom) / DAY : 0;

  // DAG classes: unpaused cron DAGs are forecast from their runs; other unpaused DAGs feed the baseline.
  const cron = new Map<string, DagMeta>();
  const unscheduled = new Set<string>();
  for (const d of input.dags) {
    if (d.paused) continue;
    if (cronTimesBetween(d.schedule, 0, 0) === null) unscheduled.add(d.dagId);
    else cron.set(d.dagId, d);
  }
  const firstSeen = new Map<string, number>();
  const scheduledTries: DemandTry[] = [];
  const baselineTries: DemandTry[] = [];
  for (const t of input.tries) {
    const forecast = cron.has(t.dagId);
    if (!forecast && !unscheduled.has(t.dagId)) continue;
    const a = demandStart(t);
    if (a !== null && a < (firstSeen.get(t.dagId) ?? Infinity)) firstSeen.set(t.dagId, a);
    if (forecast && t.runId.startsWith(SCHEDULED_PREFIX)) scheduledTries.push(t);
    else baselineTries.push(t);
  }
  const profiles = dagRunProfiles(scheduledTries, { readFrom: input.historyReadFrom });
  const dagHistoryDays = (dagId: string) => {
    const seen = firstSeen.get(dagId);
    if (seen === undefined) return null;
    return (now - Math.max(seen, coveredFrom ?? seen)) / DAY;
  };

  const p10 = new Float64Array(N);
  const p50 = new Float64Array(N);
  const p90 = new Float64Array(N);
  const poolSeries = new Map(config.pools.map((p) => [p.name, new Float64Array(N)]));
  const placed: Placed[] = [];
  const dags: DagForecast[] = [];
  let plannedRuns = 0;
  let runsProfiled = 0;
  let dagsWithoutHistory = 0;
  for (const meta of cron.values()) {
    const profile = profiles.get(meta.dagId);
    const length = profile?.p50.length ?? 0;
    const times = cronTimesBetween(meta.schedule, start - Math.max(0, length - 1) * MIN, end) ?? [];
    const ahead = times.filter((t) => t >= start).length;
    plannedRuns += ahead;
    const days = dagHistoryDays(meta.dagId);
    const lowConfidence = days === null || days < MIN_FORECAST_HISTORY_DAYS;
    if (!profile || !evaluated) {
      if (ahead > 0) {
        dagsWithoutHistory++;
        dags.push({
          dagId: meta.dagId,
          schedule: meta.schedule,
          plannedRuns: ahead,
          runsProfiled: profile?.runs ?? 0,
          historyDays: days,
          lowConfidence,
          slotMinutes: null,
          peakP50: null,
        });
      }
      continue;
    }
    runsProfiled += profile.runs;
    const starts = times.map((t) => Math.round((t - start) / MIN));
    let slotMinutes = 0;
    for (const o of starts) {
      for (let k = Math.max(0, -o), last = Math.min(length, N - o); k < last; k++) {
        const i = o + k;
        p10[i] = (p10[i] as number) + (profile.p10[k] as number);
        p50[i] = (p50[i] as number) + (profile.p50[k] as number);
        p90[i] = (p90[i] as number) + (profile.p90[k] as number);
        slotMinutes += profile.p50[k] as number;
      }
      for (const [name, pool] of profile.pools) {
        const series = poolSeries.get(name);
        if (!series) continue;
        for (let k = Math.max(0, -o), last = Math.min(pool.length, N - o); k < last; k++)
          series[o + k] = (series[o + k] as number) + (pool[k] as number);
      }
    }
    if (ahead === 0 && slotMinutes === 0) continue;
    placed.push({
      meta,
      profile,
      starts,
      lowConfidence,
      prefix50: prefixOf(profile.p50),
      prefix90: prefixOf(profile.p90),
    });
    dags.push({
      dagId: meta.dagId,
      schedule: meta.schedule,
      plannedRuns: ahead,
      runsProfiled: profile.runs,
      historyDays: days,
      lowConfidence,
      slotMinutes,
      peakP50: profile.p50.reduce((m, v) => Math.max(m, v), 0),
    });
  }

  const baseline: Baseline = evaluated
    ? baselineOf(baselineTries, coveredFrom, now, start, N)
    : { values: new Array<number | null>(N).fill(null), method: 'none' };
  const total = (bands: Float64Array) => bands.map((v, i) => v + (baseline.values[i] ?? 0));
  const t10 = total(p10);
  const t50 = total(p50);
  const t90 = total(p90);

  const workerSlotsAtMax = limitKnown(config, 'workerConcurrency')
    ? config.maxWorkers * config.workerConcurrency
    : null;
  const parallelism = limitKnown(config, 'parallelism') ? config.parallelism * config.schedulers : null;
  const check = (demand: Float64Array, prefix: (d: Placed) => Float64Array): SaturationCheck => {
    if (!evaluated) return { evaluated: false, reason: NO_HISTORY, windows: [] };
    if (workerSlotsAtMax === null) return { evaluated: false, reason: NO_CONCURRENCY, windows: [] };
    const windows = stretchesAbove(demand, workerSlotsAtMax).map(([a, b]): SaturationWindow => {
      let windowTotal = 0;
      let peak = 0;
      for (let i = a; i < b; i++) {
        windowTotal += demand[i] as number;
        peak = Math.max(peak, demand[i] as number);
      }
      let low = 0;
      let runs = 0;
      const contributions = placed
        .map((d) => ({ d, slotMinutes: within(d, prefix(d), a, b) }))
        .filter((c) => c.slotMinutes > 0);
      for (const c of contributions) {
        runs += c.slotMinutes;
        if (c.d.lowConfidence) low += c.slotMinutes;
      }
      return {
        start: start + a * MIN,
        end: start + b * MIN,
        minutes: b - a,
        peak,
        capacity: workerSlotsAtMax,
        lowConfidence: runs > 0 ? low / runs >= 0.5 : historyDays < MIN_FORECAST_HISTORY_DAYS,
        topDags: contributions
          .sort((x, y) => y.slotMinutes - x.slotMinutes || (x.d.meta.dagId < y.d.meta.dagId ? -1 : 1))
          .slice(0, TOP_WINDOW_DAGS)
          .map((c) => ({
            dagId: c.d.meta.dagId,
            slotMinutes: c.slotMinutes,
            share: windowTotal > 0 ? c.slotMinutes / windowTotal : 0,
            lowConfidence: c.d.lowConfidence,
          })),
      };
    });
    return { evaluated: true, reason: null, windows };
  };

  const stepMax = (xs: ArrayLike<number | null>, from: number, to: number): number | null => {
    let m: number | null = null;
    for (let i = from; i < to; i++) {
      const v = xs[i] ?? null;
      if (v !== null && (m === null || v > m)) m = v;
    }
    return m;
  };
  const series: ForecastStep[] = [];
  for (let i = 0; i < N; i += stepMinutes) {
    const j = Math.min(N, i + stepMinutes);
    series.push({
      start: start + i * MIN,
      p10: evaluated ? stepMax(t10, i, j) : null,
      p50: evaluated ? stepMax(t50, i, j) : null,
      p90: evaluated ? stepMax(t90, i, j) : null,
      baseline: stepMax(baseline.values, i, j),
    });
  }

  let runMinutes = 0;
  let lowMinutes = 0;
  for (const d of dags) {
    if (d.slotMinutes === null) continue;
    runMinutes += d.slotMinutes;
    if (d.lowConfidence) lowMinutes += d.slotMinutes;
  }
  const order = (a: DagForecast, b: DagForecast) =>
    (b.slotMinutes ?? -1) - (a.slotMinutes ?? -1) || (a.dagId < b.dagId ? -1 : a.dagId > b.dagId ? 1 : 0);

  return {
    from: start,
    to: end,
    stepMinutes,
    evaluated,
    reason: evaluated ? null : NO_HISTORY,
    series,
    capacity: { workerSlotsAtMax, parallelism },
    saturation: check(t50, (d) => d.prefix50),
    risk: check(t90, (d) => d.prefix90),
    dags: dags.sort(order),
    plannedRuns,
    runsProfiled,
    dagsWithoutHistory,
    unscheduledDags: unscheduled.size,
    historyFrom: evaluated ? coveredFrom : null,
    historyDays,
    lowConfidenceShare: runMinutes > 0 ? lowMinutes / runMinutes : null,
    baseline: {
      method: baseline.method,
      slotMinutes: baseline.values.reduce<number>((s, v) => s + (v ?? 0), 0),
      weeks: historyDays / 7,
    },
    pools: config.pools.map((p): PoolForecast => {
      const s = poolSeries.get(p.name) as Float64Array;
      let peak = 0;
      let peakAt = start;
      let over = 0;
      s.forEach((v, i) => {
        if (v > peak) [peak, peakAt] = [v, start + i * MIN];
        if (v > p.slots) over++;
      });
      return {
        name: p.name,
        slots: p.slots,
        peakP50: evaluated ? peak : null,
        peakAt: evaluated && peak > 0 ? peakAt : null,
        minutesOver: evaluated ? over : null,
        series: Array.from({ length: Math.ceil(N / 15) }, (_, q) =>
          evaluated ? stepMax(s, q * 15, Math.min(N, q * 15 + 15)) : null,
        ),
      };
    }),
  };
}
