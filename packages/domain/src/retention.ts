/**
 * Retention of DCAM's own store and its disk budget (spec §9.4 FR-STORE-02 L1613 and FR-STORE-07 L1618,
 * §11.7 L2219, §17.2 L3478): the classes with their defaults and limits, and the thinning of live snapshots
 * that the disk budget applies before it deletes by age.
 *
 * Thinning keeps the first snapshot of each 5-minute bucket and fixes its `spanMs` to the time the bucket's
 * snapshots stood for, each by the rule of `snapshot-time.ts` (the gap to the next, capped at two cadences).
 * Covered time stays exact; waiting task-time becomes the kept snapshot's waiting times that span, an estimate
 * whose error is how much waiting changes within five minutes.
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

/**
 * Which snapshots (oldest first) to keep and the span each kept one stands for, one per bucket aligned to
 * the epoch. Idempotent: a bucket that already holds one snapshot with its span is left alone. A bucket that
 * holds a thinned snapshot and raw ones merges them; the spans never overlap, so nothing is counted twice.
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
    const first = snapshots[i] as TimedSnapshot;
    const bucket = Math.floor(first.at / bucketMs);
    let total = 0;
    let j = i;
    for (; j < snapshots.length; j++) {
      const s = snapshots[j] as TimedSnapshot;
      if (s.at >= end || Math.floor(s.at / bucketMs) !== bucket) break;
      total += spanOf[j] ?? 0;
      if (j > i) dropped.push(s.at);
    }
    if (j - i > 1 || first.spanMs !== total) spans.push({ at: first.at, spanMs: total });
    i = j;
  }
  return { spans, dropped };
}
