/**
 * HM-017 noisy-neighbour effect (FR-BOTL-06, spec L1133): how much a DAG's running load is *associated
 * with* longer queue waits (HM-001) of other DAGs. Association, not causation: the result never says more.
 *
 * Method, per candidate DAG D, over the analysed window (DCAM uses the selected range, not 28 days):
 *
 * 1. Executor slots per minute = workers × `worker_concurrency` ({@link slotsPerMinute}). D is *active* in a
 *    minute when its executor slot-seconds in it are ≥ 10 % of the slots × 60 s, *inactive* when no try of D
 *    runs in it; other minutes, and minutes without known slots, are not compared.
 * 2. Every other DAG's try with a queue wait (`start − queued`) belongs to the minute it was queued.
 * 3. Minutes are matched by hour of week: only strata with both active and inactive tries count, and the
 *    inactive tries are re-weighted to the active tries' mix of strata.
 * 4. Effect = median wait (active) − weighted median wait (inactive). A seeded bootstrap (1,000 resamples
 *    by default) gives the 95 % interval; it resamples at most 1,000 tries per group, so the interval is
 *    conservative for larger groups. Only the highest-ranked DAGs get an interval.
 * 5. D qualifies with ≥ 60 active minutes and ≥ 200 affected tries (and, DCAM's choice, ≥ 200 control
 *    tries). Ranking: effect × affected tries, the associated extra waiting in task-time.
 *
 * Pure: no clock, no I/O; the PRNG is seeded from the DAG ID, so results are reproducible.
 *
 * @implements HM-017, FR-BOTL-06
 */
import { limitKnown, type EnvironmentConfig, type LiveSnapshot, type WorkerSample } from './model';
import type { TaskTry } from './occupancy';
import { percentile } from './stats';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 1970-01-01 was a Thursday: hours from a Monday 00:00 UTC are epoch hours + 72. */
const EPOCH_HOUR_OF_WEEK = 72;

/** A try with the timestamps HM-017 needs. `StoredTaskTry` from the ports is structurally compatible. */
export interface NeighbourTry extends TaskTry {
  readonly queuedAt: number | null;
}

export interface NoisyNeighbourInput {
  readonly tries: readonly NeighbourTry[];
  /** Executor slots per minute from `from` ({@link slotsPerMinute}); `null` where unknown. */
  readonly slots: readonly (number | null)[];
  readonly from: number;
  readonly to: number;
  /** Injected clock: the end of tries that are still running. */
  readonly now: number;
}

export interface NoisyNeighbourOptions {
  /** Share of the executor slots D must hold in a minute to be active (spec: 10 %). */
  readonly activeShare?: number;
  readonly minActiveMinutes?: number;
  readonly minAffectedTries?: number;
  readonly minControlTries?: number;
  readonly resamples?: number;
  /** Most tries per group the bootstrap resamples. */
  readonly maxBootstrapSample?: number;
  /** DAGs returned (and bootstrapped), highest ranked first. */
  readonly limit?: number;
  readonly maxOverlapWindows?: number;
}

export const HM017_DEFAULTS = {
  activeShare: 0.1,
  minActiveMinutes: 60,
  minAffectedTries: 200,
  minControlTries: 200,
  resamples: 1_000,
  maxBootstrapSample: 1_000,
  limit: 10,
  maxOverlapWindows: 5,
} as const satisfies Required<NoisyNeighbourOptions>;

export type NeighbourConfidence = 'high' | 'medium' | 'low';

export interface NoisyNeighbour {
  readonly dagId: string;
  /** Minutes D held ≥ the active share of the executor slots. */
  readonly activeMinutes: number;
  /** Other DAGs' tries queued in D's active minutes, in matched strata. */
  readonly affectedTries: number;
  /** Other DAGs' tries queued in D's inactive minutes, in matched strata. */
  readonly controlTries: number;
  /** Affected tries in matched strata ÷ all other DAGs' tries queued in D's active minutes, 0–1. */
  readonly matchedShare: number;
  readonly medianActiveMs: number;
  readonly medianInactiveMs: number;
  /** Difference in median queue wait, ms; positive means longer waits while D was active. */
  readonly effectMs: number;
  /** Bootstrap 95 % interval of the effect, ms. */
  readonly ci: { readonly lowMs: number; readonly highMs: number } | null;
  /** DCAM's rule: high when the interval excludes 0 and ≥ 80 % of tries matched; medium when it excludes 0. */
  readonly confidence: NeighbourConfidence;
  /** Ranking: effect × affected tries, in task-ms. */
  readonly scoreTaskMs: number;
  /** The longest stretches of active minutes, oldest first. */
  readonly overlapWindows: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

export interface NoisyNeighbours {
  /** `false` when no minute has known executor slots. */
  readonly evaluated: boolean;
  /** Minutes with known executor slots. */
  readonly minutesWithSlots: number;
  /** DAGs with at least one active minute. */
  readonly candidates: number;
  /** DAGs that met the minimum samples. */
  readonly qualified: number;
  readonly resamples: number;
  /** Qualified DAGs associated with longer waits (effect > 0), highest ranked first. */
  readonly items: readonly NoisyNeighbour[];
}

export interface SlotsInput {
  readonly samples: readonly WorkerSample[];
  readonly snapshots: readonly LiveSnapshot[];
  readonly config: Pick<EnvironmentConfig, 'workerConcurrency' | 'limitSources'>;
  readonly from: number;
  readonly to: number;
}

/**
 * Executor slots per minute from `from` (workers × `worker_concurrency`, HM-011): from the Cloud Monitoring
 * worker sample of the minute, else the last live snapshot in it, else `null`. All `null` when
 * `worker_concurrency` is unknown (HM-032): slots are never guessed.
 */
export function slotsPerMinute(input: SlotsInput): (number | null)[] {
  const minutes = Math.max(0, Math.ceil((input.to - input.from) / MIN));
  const out = new Array<number | null>(minutes).fill(null);
  if (!limitKnown(input.config, 'workerConcurrency')) return out;
  const concurrency = input.config.workerConcurrency;
  const fromSample = new Array<boolean>(minutes).fill(false);
  for (const s of input.samples) {
    const k = Math.floor((s.at - input.from) / MIN);
    if (k < 0 || k >= minutes) continue;
    out[k] = s.workers * concurrency;
    fromSample[k] = true;
  }
  for (const s of input.snapshots) {
    const k = Math.floor((s.at - input.from) / MIN);
    if (k < 0 || k >= minutes || fromSample[k]) continue;
    out[k] = s.workers.current * concurrency;
  }
  return out;
}

/** FNV-1a: a stable 32-bit seed from the DAG ID. */
function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** mulberry32: small, fast, deterministic. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Weighted median of `values` (ascending) with `weights`: the value where the cumulative weight passes half
 * the total; exactly half at an element gives the mean of it and the next, so equal weights give the usual
 * median.
 */
function weightedMedian(values: ArrayLike<number>, weights: ArrayLike<number>, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i] as number;
  const half = total / 2;
  const eps = total * 1e-12;
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i] as number;
    if (w === 0) continue;
    cum += w;
    if (cum > half + eps) return values[i] as number;
    if (cum >= half - eps) {
      for (let j = i + 1; j < n; j++)
        if ((weights[j] as number) > 0) return ((values[i] as number) + (values[j] as number)) / 2;
      return values[i] as number;
    }
  }
  return n > 0 ? (values[n - 1] as number) : 0;
}

interface Group {
  /** Global ranks (indices into the sorted waits), in time order. */
  readonly ranks: number[];
  readonly weights: number[];
}

/** At most `cap` members, evenly spread over time, sorted by rank (so by wait). */
function subsample(g: Group, cap: number): { values: Float64Array; weights: Float64Array } {
  const n = g.ranks.length;
  const m = Math.min(n, cap);
  const picked: Array<[number, number]> = [];
  for (let j = 0; j < m; j++) {
    const i = Math.floor((j * n) / m);
    picked.push([g.ranks[i] as number, g.weights[i] as number]);
  }
  picked.sort((a, b) => a[0] - b[0]);
  return {
    values: Float64Array.from(picked, (p) => p[0]),
    weights: Float64Array.from(picked, (p) => p[1]),
  };
}

function bootstrap(
  active: Group,
  inactive: Group,
  sortedWaits: Float64Array,
  opts: Required<NoisyNeighbourOptions>,
  random: () => number,
): { lowMs: number; highMs: number } {
  const a = subsample(active, opts.maxBootstrapSample);
  const c = subsample(inactive, opts.maxBootstrapSample);
  const av = Float64Array.from(a.values, (r) => sortedWaits[r] as number);
  const cv = Float64Array.from(c.values, (r) => sortedWaits[r] as number);
  const aw = new Float64Array(av.length);
  const cw = new Float64Array(cv.length);
  const effects: number[] = [];
  for (let b = 0; b < opts.resamples; b++) {
    aw.fill(0);
    cw.fill(0);
    for (let j = 0; j < av.length; j++) {
      const i = Math.floor(random() * av.length);
      aw[i] = (aw[i] as number) + 1;
    }
    for (let j = 0; j < cv.length; j++) {
      const i = Math.floor(random() * cv.length);
      cw[i] = (cw[i] as number) + (c.weights[i] as number);
    }
    effects.push(weightedMedian(av, aw, av.length) - weightedMedian(cv, cw, cv.length));
  }
  return { lowMs: percentile(effects, 0.025) ?? 0, highMs: percentile(effects, 0.975) ?? 0 };
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export function noisyNeighbours(
  input: NoisyNeighbourInput,
  options: NoisyNeighbourOptions = {},
): NoisyNeighbours {
  const opts: Required<NoisyNeighbourOptions> = { ...HM017_DEFAULTS, ...options };
  const { from } = input;
  const end = Math.min(input.to, Math.max(from, input.now));
  const minutes = Math.max(0, Math.ceil((input.to - from) / MIN));
  const slots = Array.from({ length: minutes }, (_, k) => input.slots[k] ?? null);
  const minutesWithSlots = slots.filter((s) => s !== null).length;
  const empty = (evaluated: boolean): NoisyNeighbours => ({
    evaluated,
    minutesWithSlots,
    candidates: 0,
    qualified: 0,
    resamples: opts.resamples,
    items: [],
  });
  if (minutesWithSlots === 0) return empty(false);

  // Executor slot-ms per DAG and minute (sparse).
  const dagIndex = new Map<string, number>();
  const dagIds: string[] = [];
  const indexOf = (dagId: string) => {
    let i = dagIndex.get(dagId);
    if (i === undefined) {
      i = dagIds.length;
      dagIds.push(dagId);
      dagIndex.set(dagId, i);
    }
    return i;
  };
  const occupancy: Array<Map<number, number>> = [];
  for (const t of input.tries) {
    if (t.startAt === null) continue;
    const stop = Math.min(t.endAt ?? input.now, end);
    const start = Math.max(t.startAt, from);
    if (!(stop > start)) continue;
    const d = indexOf(t.dagId);
    const occ = (occupancy[d] ??= new Map());
    for (let k = Math.floor((start - from) / MIN); k < minutes; k++) {
      const kFrom = from + k * MIN;
      if (kFrom >= stop) break;
      const overlap = Math.min(stop, kFrom + MIN) - Math.max(start, kFrom);
      if (overlap > 0) occ.set(k, (occ.get(k) ?? 0) + overlap);
    }
  }

  // Other DAGs' queue waits, by the minute they were queued (CSR layout), and their global wait order.
  const raw: Array<{ k: number; d: number; wait: number }> = [];
  for (const t of input.tries) {
    if (t.queuedAt === null || t.startAt === null || t.startAt < t.queuedAt) continue;
    if (t.queuedAt < from || t.queuedAt >= input.to) continue;
    raw.push({ k: Math.floor((t.queuedAt - from) / MIN), d: indexOf(t.dagId), wait: t.startAt - t.queuedAt });
  }
  const n = raw.length;
  const offsets = new Int32Array(minutes + 1);
  for (const r of raw) offsets[r.k + 1] = (offsets[r.k + 1] as number) + 1;
  for (let k = 0; k < minutes; k++) offsets[k + 1] = (offsets[k + 1] as number) + (offsets[k] as number);
  const cursor = offsets.slice(0, minutes);
  const waitDag = new Int32Array(n);
  const waitMs = new Float64Array(n);
  for (const r of raw) {
    const at = cursor[r.k] as number;
    cursor[r.k] = at + 1;
    waitDag[at] = r.d;
    waitMs[at] = r.wait;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (x, y) => (waitMs[x] as number) - (waitMs[y] as number),
  );
  const rank = new Int32Array(n);
  order.forEach((i, r) => (rank[i] = r));
  const sortedWaits = Float64Array.from(order, (i) => waitMs[i] as number);
  const stratum = Int32Array.from(
    { length: minutes },
    (_, k) => (Math.floor((from + k * MIN) / HOUR) + EPOCH_HOUR_OF_WEEK) % 168,
  );

  const wActive = new Float64Array(n);
  const wInactive = new Float64Array(n);
  let candidates = 0;
  const qualified: Array<Omit<NoisyNeighbour, 'ci' | 'confidence'> & { groups: [Group, Group] }> = [];

  for (let d = 0; d < dagIds.length; d++) {
    const occ = occupancy[d];
    if (!occ) continue;
    const state = new Int8Array(minutes); // 1 active, 2 inactive, 0 neither
    let active = 0;
    for (let k = 0; k < minutes; k++) {
      const s = slots[k];
      if (s === null || s === undefined) continue;
      const held = occ.get(k) ?? 0;
      if (held === 0) state[k] = 2;
      else if (held >= opts.activeShare * s * MIN * (1 - 1e-9)) {
        state[k] = 1;
        active++;
      }
    }
    if (active === 0) continue;
    candidates++;
    if (active < opts.minActiveMinutes) continue;

    const countA = new Float64Array(168);
    const countI = new Float64Array(168);
    let allActive = 0;
    for (let k = 0; k < minutes; k++) {
      if (state[k] === 0) continue;
      for (let i = offsets[k] as number; i < (offsets[k + 1] as number); i++) {
        if (waitDag[i] === d) continue;
        const h = stratum[k] as number;
        if (state[k] === 1) {
          countA[h] = (countA[h] as number) + 1;
          allActive++;
        } else countI[h] = (countI[h] as number) + 1;
      }
    }
    let affected = 0;
    let control = 0;
    for (let h = 0; h < 168; h++)
      if ((countA[h] as number) > 0 && (countI[h] as number) > 0) {
        affected += countA[h] as number;
        control += countI[h] as number;
      }
    if (affected < opts.minAffectedTries || control < opts.minControlTries) continue;

    wActive.fill(0);
    wInactive.fill(0);
    const groupA: Group = { ranks: [], weights: [] };
    const groupI: Group = { ranks: [], weights: [] };
    for (let k = 0; k < minutes; k++) {
      if (state[k] === 0) continue;
      const h = stratum[k] as number;
      const a = countA[h] as number;
      const c = countI[h] as number;
      if (a === 0 || c === 0) continue;
      for (let i = offsets[k] as number; i < (offsets[k + 1] as number); i++) {
        if (waitDag[i] === d) continue;
        const r = rank[i] as number;
        if (state[k] === 1) {
          wActive[r] = (wActive[r] as number) + 1;
          groupA.ranks.push(r);
          groupA.weights.push(1);
        } else {
          const w = a / c;
          wInactive[r] = (wInactive[r] as number) + w;
          groupI.ranks.push(r);
          groupI.weights.push(w);
        }
      }
    }
    const medianActiveMs = weightedMedian(sortedWaits, wActive, n);
    const medianInactiveMs = weightedMedian(sortedWaits, wInactive, n);
    const effectMs = medianActiveMs - medianInactiveMs;

    const windows: Array<{ from: number; to: number }> = [];
    for (let k = 0; k < minutes; k++) {
      if (state[k] !== 1) continue;
      let j = k;
      while (j + 1 < minutes && state[j + 1] === 1) j++;
      windows.push({ from: from + k * MIN, to: from + (j + 1) * MIN });
      k = j;
    }
    const overlapWindows = [...windows]
      .sort((x, y) => y.to - y.from - (x.to - x.from) || x.from - y.from)
      .slice(0, opts.maxOverlapWindows)
      .sort((x, y) => x.from - y.from);

    qualified.push({
      dagId: dagIds[d] as string,
      activeMinutes: active,
      affectedTries: affected,
      controlTries: control,
      matchedShare: allActive > 0 ? affected / allActive : 0,
      medianActiveMs,
      medianInactiveMs,
      effectMs,
      scoreTaskMs: effectMs * affected,
      overlapWindows,
      groups: [groupA, groupI],
    });
  }

  const items = qualified
    .filter((q) => q.effectMs > 0)
    .sort((x, y) => y.scoreTaskMs - x.scoreTaskMs || cmp(x.dagId, y.dagId))
    .slice(0, opts.limit)
    .map(({ groups, ...q }): NoisyNeighbour => {
      const ci = bootstrap(groups[0], groups[1], sortedWaits, opts, seeded(seedOf(q.dagId)));
      const confidence: NeighbourConfidence =
        ci.lowMs > 0 ? (q.matchedShare >= 0.8 ? 'high' : 'medium') : 'low';
      return { ...q, ci, confidence };
    });

  return {
    evaluated: true,
    minutesWithSlots,
    candidates,
    qualified: qualified.length,
    resamples: opts.resamples,
    items,
  };
}
