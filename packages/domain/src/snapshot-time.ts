/**
 * How much time each live snapshot stands for (FR-BOTL-01, HM-006). The `af.live` cadence depends on
 * the collection profile (10 s live, 30 s standard, 120 s eco by default, spec §7.7 and §17.2) and slows
 * down when a request budget runs out (FR-COLL-06), so no fixed interval is right. A snapshot stands for
 * the real gap to the next one, capped at {@link SNAPSHOT_GAP_CADENCES} cadences: a longer gap is a
 * collection gap, unknown, never waiting. The last snapshot stands for one cadence, up to the window end.
 *
 * A snapshot thinned by the disk budget (FR-STORE-07, `retention.ts`) carries `spanMs`, the time its
 * 5-minute bucket stood for when it was thinned; it stands for that, up to the window end. The cadence is
 * observed on raw snapshots only: five minutes between thinned snapshots is not a cadence.
 *
 * @implements FR-BOTL-01, HM-006, FR-STORE-07
 */

/** A gap longer than this many cadences is a collection gap; the snapshot before it stands for the cap. */
export const SNAPSHOT_GAP_CADENCES = 2;

/** What the span of a snapshot depends on: its time and, when thinned, its stored span. */
export interface TimedSnapshot {
  readonly at: number;
  readonly spanMs?: number;
}

/** The `af.live` cadence as observed: the median gap between consecutive snapshots, oldest first. */
export function observedCadenceMs(snapshots: readonly { readonly at: number }[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const gap = (snapshots[i] as { at: number }).at - (snapshots[i - 1] as { at: number }).at;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? (gaps[mid] as number) : ((gaps[mid - 1] as number) + (gaps[mid] as number)) / 2;
}

/** The observed cadence of the raw (not thinned) snapshots among `snapshots`. */
export function rawCadenceMs(snapshots: readonly TimedSnapshot[]): number | null {
  return observedCadenceMs(snapshots.filter((s) => s.spanMs === undefined));
}

/** Milliseconds each snapshot (oldest first) stands for, given the cadence and the window end. */
export function snapshotSpans(snapshots: readonly TimedSnapshot[], cadenceMs: number, to: number): number[] {
  const cap = SNAPSHOT_GAP_CADENCES * cadenceMs;
  return snapshots.map((s, i) => {
    if (s.spanMs !== undefined) return Math.max(0, Math.min(s.spanMs, to - s.at));
    const next = snapshots[i + 1];
    const span = next ? Math.min(next.at - s.at, cap) : Math.min(cadenceMs, to - s.at);
    return Math.max(0, span);
  });
}

/**
 * {@link snapshotSpans} for snapshots fed one by one, oldest first, possibly across batches (NFR-PERF-01):
 * each snapshot is emitted with its span once the next one arrives, and the last when the stream ends. The
 * spans are the same as {@link snapshotSpans} over all the snapshots at once.
 */
export function createSpanStream<T extends TimedSnapshot>(
  cadenceMs: number,
  to: number,
  emit: (snapshot: T, spanMs: number) => void,
) {
  const cap = SNAPSHOT_GAP_CADENCES * cadenceMs;
  let pending: T | null = null;
  const thinned = (s: T) => Math.max(0, Math.min(s.spanMs as number, to - s.at));
  return {
    push(s: T): void {
      if (pending)
        emit(
          pending,
          pending.spanMs !== undefined ? thinned(pending) : Math.max(0, Math.min(s.at - pending.at, cap)),
        );
      pending = s;
    },
    end(): void {
      if (pending)
        emit(
          pending,
          pending.spanMs !== undefined ? thinned(pending) : Math.max(0, Math.min(cadenceMs, to - pending.at)),
        );
      pending = null;
    },
  };
}
