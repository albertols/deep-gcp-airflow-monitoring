/**
 * Retention of DCAM's own store and its disk budget (spec §9.4 FR-STORE-02 L1613 and FR-STORE-07 L1618,
 * §11.7 L2219, §17.2 L3478): the classes with their defaults and limits, and the thinning of live snapshots
 * that the disk budget applies before it deletes by age.
 *
 * Thinning keeps one snapshot of each 5-minute bucket and fixes its `spanMs` to the time the bucket's
 * snapshots stood for, each by the rule of `snapshot-time.ts` (the gap to the next, capped at two cadences).
 * Covered time stays exact. The kept snapshot is drawn in proportion to the time it stood for (stratified
 * sampling with a low-discrepancy draw fixed by the bucket): waiting task-time, the kept snapshot's waiting
 * times the bucket's span, is then an estimate of the raw value without bias. On the simulated environments
 * the error of total waiting was 2–3 % (rms) over a day of thinned snapshots and 5–11 % over 6 hours; short
 * bursts such as normal latency vary more. Keeping the first snapshot would be biased:
 * buckets start on round minutes, when cron-scheduled runs start and wait, so it would overcount that waiting
 * and miss what follows. Completeness does not steer the choice either: a snapshot is a sample exactly when
 * many task instances wait, so preferring complete ones would undercount (the kept one keeps its coverage).
 *
 * @implements FR-STORE-02, FR-STORE-07
 */
import { DAY_MS } from './advisor-rule';
import { rawCadenceMs, snapshotSpans, type TimedSnapshot } from './snapshot-time';

/** Days each class of data is kept (§17.2 `retention`). */
export interface RetentionDays {
  /** Task instance tries (and DAG runs once DCAM stores them). */
  readonly rawTaskInstancesDays: number;
  /** Live snapshots, worker samples and first-seen ready times. */
  readonly rawMetricPointsDays: number;
  readonly rollup5mDays: number;
  readonly rollup1hDays: number;
  readonly logSignaturesDays: number;
  /** Findings and alert history. */
  readonly findingsDays: number;
}
export type RetentionClass = keyof RetentionDays;

/** FR-STORE-02 defaults (§9.4 L1613, §17.2 L3478). */
export const DEFAULT_RETENTION_DAYS = {
  rawTaskInstancesDays: 90,
  rawMetricPointsDays: 14,
  rollup5mDays: 90,
  rollup1hDays: 400,
  logSignaturesDays: 30,
  findingsDays: 400,
} as const satisfies RetentionDays;

/**
 * Limits of each class, in days: DCAM's own choices, not platform facts. The minimum for task tries is the
 * 7 days the alerts' same-hour baseline reads (`alerts.ts`); one day of metric points serves the 24 h range.
 * The maxima keep a laptop's store within reach of NFR-RES-03 (2 GB for 90 days at reference scale): raw
 * metric points, by far the largest class, at most the longest range preset (90 days, FR-UI-01).
 */
export const RETENTION_DAY_LIMITS = {
  rawTaskInstancesDays: { min: 7, max: 400 },
  rawMetricPointsDays: { min: 1, max: 90 },
  rollup5mDays: { min: 1, max: 400 },
  rollup1hDays: { min: 1, max: 730 },
  logSignaturesDays: { min: 1, max: 90 },
  findingsDays: { min: 1, max: 730 },
} as const satisfies Record<RetentionClass, { readonly min: number; readonly max: number }>;

/** §17.2 `retention.diskBudgetGb`; 1 GB is 10⁹ bytes. */
export const DEFAULT_DISK_BUDGET_GB = 5;
export const DISK_BUDGET_GB_LIMITS = { min: 1, max: 1_000 } as const;
export const BYTES_PER_GB = 1e9;

/** FR-STORE-07: at this share of the budget DCAM warns, thins, then deletes by age. */
export const DISK_WARN_SHARE = 0.9;
/** The last 24 h are never thinned: the 1 h, 6 h and 24 h ranges keep every snapshot. */
export const THIN_AFTER_MS = DAY_MS;
/** Thinned snapshots: one per 5 minutes. */
export const THIN_BUCKET_MS = 5 * 60_000;
/** Deleting by age for the budget never reaches the last 8 days (the alerts' 7-day baseline and today). */
export const BUDGET_FLOOR_MS = 8 * DAY_MS;

export type DiskUsageState = 'ok' | 'warning';

/** FR-STORE-07: `warning` at or above {@link DISK_WARN_SHARE} of the budget. */
export function diskUsageState(usedBytes: number, budgetBytes: number): DiskUsageState {
  return usedBytes >= DISK_WARN_SHARE * budgetBytes ? 'warning' : 'ok';
}

export interface ThinOptions {
  /** Only buckets that end at or before this are thinned: it is rounded down to a bucket boundary. */
  readonly before: number;
  readonly bucketMs: number;
  /** The first snapshot after the given ones, whose time ends the last one's span; `null` when none. */
  readonly nextAt: number | null;
  /** The cadence to assume while fewer than two raw snapshots show it. */
  readonly fallbackCadenceMs: number;
}

export interface ThinPlan {
  /** Kept snapshots whose stored span is new or changes. */
  readonly spans: readonly { readonly at: number; readonly spanMs: number }[];
  /** Times of the snapshots to delete. */
  readonly dropped: readonly number[];
}

/** 1 / φ: consecutive multiples of it, modulo 1, spread over [0, 1) as evenly as any sequence can (Weyl). */
const GOLDEN = 0.6180339887498949;

/**
 * The draw of a bucket, in [0, 1): fixed by the bucket, so thinning again keeps the same snapshot. Over many
 * buckets each position in a bucket is drawn as often as its share of the bucket's span, even for patterns
 * that repeat every hour; on the simulator this halved the error of independent random draws.
 */
function bucketDraw(bucket: number): number {
  const x = bucket * GOLDEN;
  return x - Math.floor(x);
}

/**
 * Which snapshots (oldest first) to keep and the span each kept one stands for, one per bucket aligned to
 * the epoch, drawn by span (see the module comment). Every snapshot of the bucket adds its span to the kept
 * one. Deterministic and idempotent: a bucket that already holds one snapshot with its span is left alone. A
 * bucket that holds a thinned snapshot and raw ones merges them; the spans never overlap, so nothing is
 * counted twice.
 */
export function thinSnapshots(snapshots: readonly TimedSnapshot[], options: ThinOptions): ThinPlan {
  const { bucketMs } = options;
  const end = Math.floor(options.before / bucketMs) * bucketMs;
  const cadence = rawCadenceMs(snapshots) ?? options.fallbackCadenceMs;
  const closed = options.nextAt === null ? snapshots : [...snapshots, { at: options.nextAt }];
  const spanOf = snapshotSpans(closed, cadence, Infinity);

  const spans: { at: number; spanMs: number }[] = [];
  const dropped: number[] = [];
  let i = 0;
  while (i < snapshots.length && (snapshots[i] as TimedSnapshot).at < end) {
    const bucket = Math.floor((snapshots[i] as TimedSnapshot).at / bucketMs);
    let j = i;
    let total = 0;
    while (j < snapshots.length) {
      const s = snapshots[j] as TimedSnapshot;
      if (s.at >= end || Math.floor(s.at / bucketMs) !== bucket) break;
      total += spanOf[j] ?? 0;
      j++;
    }
    // The snapshot whose share of the bucket's span holds the draw.
    const target = bucketDraw(bucket) * total;
    let k = i;
    for (let sum = spanOf[i] ?? 0; k < j - 1 && sum <= target; sum += spanOf[k] ?? 0) k++;
    const kept = snapshots[k] as TimedSnapshot;
    for (let m = i; m < j; m++) if (m !== k) dropped.push((snapshots[m] as TimedSnapshot).at);
    if (j - i > 1 || kept.spanMs !== total) spans.push({ at: kept.at, spanMs: total });
    i = j;
  }
  return { spans, dropped };
}
