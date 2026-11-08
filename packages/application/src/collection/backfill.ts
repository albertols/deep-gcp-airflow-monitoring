/**
 * Backfill on first add (FR-COLL-04): how many days each backfill reads, and an honest estimate of when it
 * finishes.
 *
 * - Days: §17.2 `environments[].backfill` (`taskInstancesDays: 7`, `metricsDays: 14`). The configuration
 *   adapter rejects values above the maxima; they are clamped here as well, and a server test checks that
 *   both declarations agree. Task instances: at most the raw task instance retention (FR-STORE-02, 90 days).
 *   Metrics: at most the six weeks Cloud Monitoring keeps Composer metrics (spec §7.2 "Retention").
 * - ETA: the work left divided by the rate observed over the last {@link RATE_WINDOW_MS}, once at least
 *   {@link MIN_OBSERVED_MS} of progress has been observed. No progress, or no count of the work left, gives no
 *   ETA rather than a guess. The rate follows the budget the backfill actually gets, so it changes with the
 *   profile and with the live and standard work it yields to.
 *
 * @implements FR-COLL-04
 */
import type { BackfillDays, EnvironmentEntry } from '@dcam/ports';

export const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_BACKFILL: BackfillDays = { taskInstancesDays: 7, metricsDays: 14 };
export const BACKFILL_MAXIMA: BackfillDays = { taskInstancesDays: 90, metricsDays: 42 };
/** The rate behind an ETA is measured over this much recent time. */
export const RATE_WINDOW_MS = 30 * 60_000;
/** An ETA needs at least this much observed progress. */
export const MIN_OBSERVED_MS = 5 * 60_000;

const days = (value: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0;

/** The environment's backfill days, defaults applied and clamped to the maxima. */
export function backfillDays(entry: EnvironmentEntry): BackfillDays {
  const configured = entry.backfill ?? DEFAULT_BACKFILL;
  return {
    taskInstancesDays: days(configured.taskInstancesDays, BACKFILL_MAXIMA.taskInstancesDays),
    metricsDays: days(configured.metricsDays, BACKFILL_MAXIMA.metricsDays),
  };
}

/** Progress over time (items done so far), for an ETA from the observed rate. */
export class ProgressRate {
  private points: Array<{ readonly at: number; readonly done: number }> = [];

  record(at: number, done: number): void {
    this.points.push({ at, done });
    // Keep one point before the window, so the window's start is always covered.
    const from = at - RATE_WINDOW_MS;
    while (this.points.length > 2 && (this.points[1] as { at: number }).at <= from) this.points.shift();
  }

  /** Seconds until `remaining` more items are done at the observed rate; `null` when it cannot be told. */
  eta(now: number, remaining: number | null): number | null {
    if (remaining === null) return null;
    if (remaining <= 0) return 0;
    const from = now - RATE_WINDOW_MS;
    const recent = this.points.filter((p) => p.at >= from);
    const first = recent[0];
    const last = recent.at(-1);
    if (!first || !last || last.at - first.at < MIN_OBSERVED_MS) return null;
    const perMs = (last.done - first.done) / (last.at - first.at);
    if (!(perMs > 0)) return null;
    return Math.round(remaining / perMs / 1_000);
  }
}
