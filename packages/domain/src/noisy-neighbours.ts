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
 *    by default) gives the 95 % interval. It is a block bootstrap: tries queued in the same minute are
 *    correlated (a cron burst, one mapped task's expansion), so it resamples whole minutes, with replacement,
 *    within each hour-of-week stratum and each group, keeping the number of minutes per stratum, and
 *    re-weights the inactive tries to the resampled active mix. Resampling single tries would treat a burst
 *    of 200 as 200 independent waits and narrow the interval. It reads at most 1,000 tries per group, evenly
 *    spread over time, so the interval is conservative for larger groups. Only the highest-ranked DAGs get
 *    an interval.
 * 5. D qualifies with ≥ 60 active minutes and ≥ 200 affected tries (HM-017), and, DCAM's choice, ≥ 200
 *    control tries and ≥ 30 distinct affected minutes (active minutes with an affected try in a matched
 *    stratum): one mapped task queued in one minute must not meet the 200 tries alone, and a minute block
 *    bootstrap needs enough blocks. Ranking: effect × affected tries, the associated extra waiting in
 *    task-time.
 *
 * Pure: no clock, no I/O; the PRNG is seeded from the DAG ID, so results are reproducible.
 *
 * @implements HM-017, FR-BOTL-06
 */
import {
  limitKnown,
  type EnvironmentConfig,
  type LiveSnapshot,
  type WorkerCountSource,
  type WorkerSample,
} from './model';
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
  /** Distinct active minutes with an affected try (DCAM's choice; the bootstrap's blocks). */
  readonly minAffectedMinutes?: number;
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
  minAffectedMinutes: 30,
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
  /** Distinct active minutes in which those tries were queued: the blocks the bootstrap resamples. */
  readonly affectedMinutes: number;
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
  const acc = createSlotsPerMinute(input);
  acc.add(input.snapshots);
  return acc.result();
}

/** From the most to the least reliable: a window is as reliable as its weakest minute. */
const SOURCE_ORDER: readonly WorkerCountSource[] = ['monitoring', 'config', 'hostnames'];

/**
 * {@link slotsPerMinute} and {@link slotsSourceOf} with the snapshots added in batches, oldest first
 * (NFR-PERF-01): the last snapshot of a minute counts, as when they come at once.
 */
export function createSlotsPerMinute(input: Omit<SlotsInput, 'snapshots'>) {
  const minutes = Math.max(0, Math.ceil((input.to - input.from) / MIN));
  const out = new Array<number | null>(minutes).fill(null);
  const known = limitKnown(input.config, 'workerConcurrency');
  const concurrency = input.config.workerConcurrency;
  const fromSample = new Array<boolean>(minutes).fill(false);
  const bySnapshot = new Array<WorkerCountSource | null>(minutes).fill(null);
  if (known)
    for (const s of input.samples) {
      const k = Math.floor((s.at - input.from) / MIN);
      if (k < 0 || k >= minutes) continue;
      out[k] = s.workers * concurrency;
      fromSample[k] = true;
    }
  return {
    add(snapshots: readonly LiveSnapshot[]): void {
      if (!known) return;
      for (const s of snapshots) {
        const k = Math.floor((s.at - input.from) / MIN);
        if (k < 0 || k >= minutes || fromSample[k]) continue;
        out[k] = s.workers.current * concurrency;
        // The last snapshot of the minute sets its slots; a stored value outside the three says nothing.
        const source = s.workers.source;
        bySnapshot[k] = source !== undefined && SOURCE_ORDER.includes(source) ? source : null;
      }
    },
    result: (): (number | null)[] => out,
    /** {@link slotsSourceOf}: the weakest source over the minutes with slots. */
    source(): WorkerCountSource | null {
      if (!known) return null;
      let weakest = -1;
      for (let k = 0; k < minutes; k++) {
        const source = fromSample[k] ? 'monitoring' : bySnapshot[k];
        if (source) weakest = Math.max(weakest, SOURCE_ORDER.indexOf(source));
      }
      return weakest < 0 ? null : (SOURCE_ORDER[weakest] as WorkerCountSource);
    },
  };
}

/**
 * HM-011: where the worker counts behind {@link slotsPerMinute} came from, the weakest over the minutes with
 * slots: `hostnames` as soon as one minute's count is the hostname estimate (a lower bound). `null` when no
 * minute has slots, or none of the snapshots used says where its count came from.
 */
export function slotsSourceOf(input: SlotsInput): WorkerCountSource | null {
  const acc = createSlotsPerMinute(input);
  acc.add(input.snapshots);
  return acc.source();
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
  return medianWithTotal(values, weights, n, total);
}

/** {@link weightedMedian} when the total weight is already known: one pass that stops at the median. */
function medianWithTotal(
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
  n: number,
  total: number,
): number {
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
  /** The minute each member was queued in, in the same order. */
  readonly minutes: number[];
}

/** A group ready to resample: waits ascending, and the minute blocks of each stratum as positions in them. */
interface Blocks {
  readonly values: Float64Array;
  /** Stratum of each position. */
  readonly stratumOf: Int32Array;
  /** Per stratum, its minute blocks; each block lists the positions of the tries queued in that minute. */
  readonly byStratum: ReadonlyMap<number, readonly (readonly number[])[]>;
}

/**
 * At most `cap` members, evenly spread over time (so each minute keeps about its share), sorted by rank (so
 * by wait), grouped into minute blocks per hour-of-week stratum.
 */
function blocksOf(g: Group, cap: number, sortedWaits: Float64Array, stratum: Int32Array): Blocks {
  const n = g.ranks.length;
  const m = Math.min(n, cap);
  const picked: Array<[number, number]> = [];
  for (let j = 0; j < m; j++) {
    const i = Math.floor((j * n) / m);
    picked.push([g.ranks[i] as number, g.minutes[i] as number]);
  }
  picked.sort((a, b) => a[0] - b[0]);
  const byMinute = new Map<number, number[]>();
  picked.forEach(([, k], p) => {
    const block = byMinute.get(k);
    if (block) block.push(p);
    else byMinute.set(k, [p]);
  });
  const byStratum = new Map<number, number[][]>();
  for (const [k, block] of byMinute) {
    const h = stratum[k] as number;
    const list = byStratum.get(h);
    if (list) list.push(block);
    else byStratum.set(h, [block]);
  }
  return {
    values: Float64Array.from(picked, (p) => sortedWaits[p[0]] as number),
    stratumOf: Int32Array.from(picked, (p) => stratum[p[1]] as number),
    byStratum,
  };
}

/**
 * Draws as many minute blocks as each matched stratum has, with replacement, adding 1 per drawn try to its
 * position's count; `drawn[h]` gets the number of tries drawn in stratum h.
 */
function drawBlocks(
  g: Blocks,
  strata: readonly number[],
  counts: Float64Array,
  drawn: Float64Array,
  random: () => number,
): void {
  counts.fill(0);
  for (const h of strata) {
    const blocks = g.byStratum.get(h) as readonly (readonly number[])[];
    let tries = 0;
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[(random() * blocks.length) | 0] as readonly number[];
      for (const p of block) counts[p] = (counts[p] as number) + 1;
      tries += block.length;
    }
    drawn[h] = tries;
  }
}

/** HM-017 interval by a stratified minute-block bootstrap (see the module comment, point 4). */
function bootstrap(
  active: Group,
  inactive: Group,
  sortedWaits: Float64Array,
  stratum: Int32Array,
  opts: Required<NoisyNeighbourOptions>,
  random: () => number,
): { lowMs: number; highMs: number } {
  const a = blocksOf(active, opts.maxBootstrapSample, sortedWaits, stratum);
  const c = blocksOf(inactive, opts.maxBootstrapSample, sortedWaits, stratum);
  // Strata with tries of both groups in the sample; the others take no part, as in the estimate.
  const strata = [...a.byStratum.keys()].filter((h) => c.byStratum.has(h)).sort((x, y) => x - y);
  const na = a.values.length;
  const nc = c.values.length;
  const aw = new Float64Array(na);
  const cw = new Float64Array(nc);
  const drawnA = new Float64Array(168);
  const drawnC = new Float64Array(168);
  const effects: number[] = [];
  for (let b = 0; b < opts.resamples; b++) {
    drawBlocks(a, strata, aw, drawnA, random);
    drawBlocks(c, strata, cw, drawnC, random);
    let totalA = 0;
    for (const h of strata) totalA += drawnA[h] as number;
    // Inactive tries weigh (active ÷ inactive tries drawn in their stratum), so both mixes match.
    for (let p = 0; p < nc; p++) {
      const count = cw[p] as number;
      if (count === 0) continue;
      const h = c.stratumOf[p] as number;
      cw[p] = (count * (drawnA[h] as number)) / (drawnC[h] as number);
    }
    effects.push(medianWithTotal(a.values, aw, na, totalA) - medianWithTotal(c.values, cw, nc, totalA));
  }
  return { lowMs: percentile(effects, 0.025) ?? 0, highMs: percentile(effects, 0.975) ?? 0 };
}

interface WaitIndex {
  readonly n: number;
  /** Waits of minute k are at [offsets[k], offsets[k + 1]). */
  readonly offsets: Int32Array;
  readonly waitDag: Int32Array;
  readonly dagIndex: ReadonlyMap<string, number>;
  /** Position of each wait in ascending order. */
  readonly rank: Int32Array;
  readonly sortedWaits: Float64Array;
}

/** Most intervals open at once, from flat `[start, stop, …]` pairs; a stop frees its slot before a start at the same time. */
function peakConcurrency(iv: readonly number[]): number {
  const m = iv.length / 2;
  const starts = new Float64Array(m);
  const stops = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    starts[j] = iv[2 * j] as number;
    stops[j] = iv[2 * j + 1] as number;
  }
  starts.sort();
  stops.sort();
  let open = 0;
  let peak = 0;
  let s = 0;
  for (let j = 0; j < m; j++) {
    while (s < m && (stops[s] as number) <= (starts[j] as number)) {
      s++;
      open--;
    }
    open++;
    if (open > peak) peak = open;
  }
  return peak;
}

/** Queue waits (`start − queued`) by the minute they were queued, and their global order. */
function indexWaits(input: NoisyNeighbourInput, minutes: number): WaitIndex {
  const { from } = input;
  const dagIndex = new Map<string, number>();
  const ks: number[] = [];
  const ds: number[] = [];
  const ws: number[] = [];
  for (const t of input.tries) {
    if (t.queuedAt === null || t.startAt === null || t.startAt < t.queuedAt) continue;
    if (t.queuedAt < from || t.queuedAt >= input.to) continue;
    let d = dagIndex.get(t.dagId);
    if (d === undefined) {
      d = dagIndex.size;
      dagIndex.set(t.dagId, d);
    }
    ks.push(Math.floor((t.queuedAt - from) / MIN));
    ds.push(d);
    ws.push(t.startAt - t.queuedAt);
  }
  const n = ks.length;
  const offsets = new Int32Array(minutes + 1);
  for (const k of ks) offsets[k + 1] = (offsets[k + 1] as number) + 1;
  for (let k = 0; k < minutes; k++) offsets[k + 1] = (offsets[k + 1] as number) + (offsets[k] as number);
  const cursor = offsets.slice(0, minutes);
  const waitDag = new Int32Array(n);
  const waitMs = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const k = ks[j] as number;
    const at = cursor[k] as number;
    cursor[k] = at + 1;
    waitDag[at] = ds[j] as number;
    waitMs[at] = ws[j] as number;
  }
  // Sort (wait, index) pairs packed into one number when they fit exactly, else with a comparator.
  let maxWait = 0;
  let integral = true;
  for (let i = 0; i < n; i++) {
    const w = waitMs[i] as number;
    if (w > maxWait) maxWait = w;
    if (!Number.isInteger(w)) integral = false;
  }
  let order: ArrayLike<number>;
  if (integral && (maxWait + 1) * n < Number.MAX_SAFE_INTEGER) {
    const packed = new Float64Array(n);
    for (let i = 0; i < n; i++) packed[i] = (waitMs[i] as number) * n + i;
    packed.sort();
    order = Int32Array.from(packed, (x) => x % n);
  } else {
    order = Array.from({ length: n }, (_, i) => i).sort(
      (x, y) => (waitMs[x] as number) - (waitMs[y] as number),
    );
  }
  const rank = new Int32Array(n);
  const sortedWaits = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    const i = order[r] as number;
    rank[i] = r;
    sortedWaits[r] = waitMs[i] as number;
  }
  return { n, offsets, waitDag, dagIndex, rank, sortedWaits };
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

  // 1. Running intervals per DAG, clipped to the observed window.
  const intervals = new Map<string, number[]>();
  for (const t of input.tries) {
    if (t.startAt === null) continue;
    const stop = Math.min(t.endAt ?? input.now, end);
    const start = Math.max(t.startAt, from);
    if (!(stop > start)) continue;
    const list = intervals.get(t.dagId);
    if (list) list.push(start, stop);
    else intervals.set(t.dagId, [start, stop]);
  }

  // 2. A DAG whose peak concurrency stays below the active share of the fewest slots can never be active,
  //    so its minutes are never swept: at thousands of DAGs, almost all of them.
  let fewestSlots = Infinity;
  for (const x of slots) if (x !== null && x < fewestSlots) fewestSlots = x;
  const needed = opts.activeShare * fewestSlots * (1 - 1e-9);
  const occupancy = new Map<string, Map<number, number>>();
  for (const [dagId, iv] of intervals) {
    if (iv.length / 2 < needed || peakConcurrency(iv) < needed) continue;
    const occ = new Map<number, number>();
    for (let j = 0; j < iv.length; j += 2) {
      const start = iv[j] as number;
      const stop = iv[j + 1] as number;
      for (let k = Math.floor((start - from) / MIN); k < minutes; k++) {
        const kFrom = from + k * MIN;
        if (kFrom >= stop) break;
        const overlap = Math.min(stop, kFrom + MIN) - Math.max(start, kFrom);
        if (overlap > 0) occ.set(k, (occ.get(k) ?? 0) + overlap);
      }
    }
    occupancy.set(dagId, occ);
  }

  const stratum = Int32Array.from(
    { length: minutes },
    (_, k) => (Math.floor((from + k * MIN) / HOUR) + EPOCH_HOUR_OF_WEEK) % 168,
  );
  let waits: WaitIndex | null = null;
  let wActive = new Float64Array(0);
  let wInactive = new Float64Array(0);
  let candidates = 0;
  const qualified: Array<Omit<NoisyNeighbour, 'ci' | 'confidence'> & { groups: [Group, Group] }> = [];

  for (const [dagId, occ] of occupancy) {
    let active = 0;
    for (const [k, held] of occ) {
      const x = slots[k];
      if (x !== null && x !== undefined && held >= opts.activeShare * x * MIN * (1 - 1e-9)) active++;
    }
    if (active === 0) continue;
    candidates++;
    if (active < opts.minActiveMinutes) continue;

    // 3. Minute states (1 active, 2 inactive, 0 neither) and, once, the index of other DAGs' waits.
    const state = new Int8Array(minutes);
    for (let k = 0; k < minutes; k++) if (slots[k] !== null) state[k] = 2;
    for (const [k, held] of occ) {
      const x = slots[k];
      if (x === null || x === undefined) continue;
      state[k] = held >= opts.activeShare * x * MIN * (1 - 1e-9) ? 1 : 0;
    }
    if (!waits) {
      waits = indexWaits(input, minutes);
      wActive = new Float64Array(waits.n);
      wInactive = new Float64Array(waits.n);
    }
    const { offsets, waitDag, rank, sortedWaits, n } = waits;
    const d = waits.dagIndex.get(dagId) ?? -1;

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
    const groupA: Group = { ranks: [], minutes: [] };
    const groupI: Group = { ranks: [], minutes: [] };
    let affectedMinutes = 0;
    for (let k = 0; k < minutes; k++) {
      if (state[k] === 0) continue;
      const h = stratum[k] as number;
      const a = countA[h] as number;
      const c = countI[h] as number;
      if (a === 0 || c === 0) continue;
      const before = groupA.ranks.length;
      for (let i = offsets[k] as number; i < (offsets[k + 1] as number); i++) {
        if (waitDag[i] === d) continue;
        const r = rank[i] as number;
        if (state[k] === 1) {
          wActive[r] = (wActive[r] as number) + 1;
          groupA.ranks.push(r);
          groupA.minutes.push(k);
        } else {
          wInactive[r] = (wInactive[r] as number) + a / c;
          groupI.ranks.push(r);
          groupI.minutes.push(k);
        }
      }
      if (groupA.ranks.length > before) affectedMinutes++;
    }
    if (affectedMinutes < opts.minAffectedMinutes) continue;
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
      dagId,
      activeMinutes: active,
      affectedTries: affected,
      affectedMinutes,
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
      const ci = bootstrap(
        groups[0],
        groups[1],
        (waits as WaitIndex).sortedWaits,
        stratum,
        opts,
        seeded(seedOf(q.dagId)),
      );
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
