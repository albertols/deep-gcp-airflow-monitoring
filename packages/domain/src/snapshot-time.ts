/**
 * How much time each live snapshot stands for (FR-BOTL-01, HM-006). The `af.live` cadence depends on
 * the collection profile (10 s live, 30 s standard, 120 s eco by default, spec §7.7 and §17.2) and slows
 * down when a request budget runs out (FR-COLL-06), so no fixed interval is right. A snapshot stands for
 * the real gap to the next one, capped at {@link SNAPSHOT_GAP_CADENCES} cadences: a longer gap is a
 * collection gap, unknown, never waiting. The last snapshot stands for one cadence, up to the window end.
 *
 * @implements FR-BOTL-01, HM-006
 */

/** A gap longer than this many cadences is a collection gap; the snapshot before it stands for the cap. */
export const SNAPSHOT_GAP_CADENCES = 2;

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

/** Milliseconds each snapshot (oldest first) stands for, given the cadence and the window end. */
export function snapshotSpans(
  snapshots: readonly { readonly at: number }[],
  cadenceMs: number,
  to: number,
): number[] {
  const cap = SNAPSHOT_GAP_CADENCES * cadenceMs;
  return snapshots.map((s, i) => {
    const next = snapshots[i + 1];
    const span = next ? Math.min(next.at - s.at, cap) : Math.min(cadenceMs, to - s.at);
    return Math.max(0, span);
  });
}
