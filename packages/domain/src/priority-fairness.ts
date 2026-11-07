/**
 * HM-023 priority fairness, the part DCAM's data supports (spec L1158): whether low-priority work in a pool
 * waits longer than high-priority work in the same pool. Priority applies within a pool, so bands are formed
 * per pool from the `priority_weight` each waiting task instance reports in the live snapshots.
 *
 * - **Observed wait** of a try = the last time a snapshot saw it waiting (ready or queued) − the earliest
 *   time it was known to be waiting (`since`: first seen ready, or `queued_when`). It is a lower bound at
 *   snapshot resolution; tries that waited less than one cadence may not be seen at all.
 * - **Bands**: the mid-rank quantile of a weight among the pool's tries; below 1/3 is low, below 2/3 mid,
 *   else high. The lowest weight is always low and the highest always high. One weight means no bands.
 * - The spec's **starvation ratio** (current p95 ÷ the band's 28-day median while higher bands ran) is not
 *   computed: snapshots list waiting work only, so when higher bands *ran* is not observed, and there is no
 *   28-day baseline yet (specs/007-botl-depth/spec.md, "Blocked").
 *
 * ⚠️ VERIFY (VC-14): that the weight the API reports per task instance is the effective weight (`weight_rule`).
 *
 * @implements HM-023
 */
import type { LiveSnapshot, SnapshotTaskInstance } from './model';
import { quantile, type Quantile } from './stats';

export type PriorityBandId = 'low' | 'mid' | 'high';

export interface PriorityBand {
  readonly band: PriorityBandId;
  readonly minWeight: number;
  readonly maxWeight: number;
  readonly tries: number;
  /** Observed wait in ms. */
  readonly waitP50: Quantile;
  /** Observed wait in ms; the max, flagged low sample, under 20 tries (§8.9). */
  readonly waitP95: Quantile;
}

export interface PoolPriority {
  readonly pool: string;
  /** Distinct waiting tries seen in the pool. */
  readonly tries: number;
  readonly distinctWeights: number;
  /** Low to high; empty when every try has the same weight. */
  readonly bands: readonly PriorityBand[];
}

interface Seen {
  readonly mapIndex: number;
  readonly tryNumber: number;
  pool: string;
  weight: number;
  firstSince: number;
  lastAt: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const BANDS: readonly PriorityBandId[] = ['low', 'mid', 'high'];

export function priorityFairness(
  snapshots: readonly LiveSnapshot[],
  window: { readonly from: number; readonly to: number },
): PoolPriority[] {
  // Nested maps (DAG → run → task → tries) instead of one string key per sighting: no string is built per
  // task instance, and each ID string is hashed once.
  const byDag = new Map<string, Map<string, Map<string, Seen[]>>>();
  const all: Seen[] = [];
  const see = (ti: SnapshotTaskInstance, at: number) => {
    let runs = byDag.get(ti.dagId);
    if (!runs) byDag.set(ti.dagId, (runs = new Map()));
    let tasks = runs.get(ti.runId);
    if (!tasks) runs.set(ti.runId, (tasks = new Map()));
    let tries = tasks.get(ti.taskId);
    if (!tries) tasks.set(ti.taskId, (tries = []));
    let seen: Seen | undefined;
    for (const x of tries)
      if (x.mapIndex === ti.mapIndex && x.tryNumber === ti.tryNumber) {
        seen = x;
        break;
      }
    if (!seen) {
      seen = {
        mapIndex: ti.mapIndex,
        tryNumber: ti.tryNumber,
        pool: ti.pool,
        weight: ti.priorityWeight,
        firstSince: ti.since,
        lastAt: at,
      };
      tries.push(seen);
      all.push(seen);
    } else {
      seen.pool = ti.pool;
      seen.weight = ti.priorityWeight;
      if (ti.since < seen.firstSince) seen.firstSince = ti.since;
      if (at > seen.lastAt) seen.lastAt = at;
    }
  };
  for (const s of snapshots) {
    if (s.at < window.from || s.at >= window.to) continue;
    for (const ti of s.scheduled) see(ti, s.at);
    for (const ti of s.queued) see(ti, s.at);
  }

  const byPool = new Map<string, Seen[]>();
  for (const t of all) {
    const list = byPool.get(t.pool);
    if (list) list.push(t);
    else byPool.set(t.pool, [t]);
  }

  return [...byPool]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([pool, list]) => {
      const counts = new Map<number, number>();
      for (const t of list) counts.set(t.weight, (counts.get(t.weight) ?? 0) + 1);
      const weights = [...counts.keys()].sort((a, b) => a - b);
      if (weights.length < 2) return { pool, tries: list.length, distinctWeights: weights.length, bands: [] };

      const bandOf = new Map<number, number>();
      let below = 0;
      weights.forEach((w, i) => {
        const n = counts.get(w) ?? 0;
        const midRank = (below + n / 2) / list.length;
        below += n;
        const band =
          i === 0 ? 0 : i === weights.length - 1 ? 2 : midRank < 1 / 3 ? 0 : midRank < 2 / 3 ? 1 : 2;
        bandOf.set(w, band);
      });
      const bands = BANDS.map((band, b) => {
        const waits: number[] = [];
        let minWeight = Infinity;
        let maxWeight = -Infinity;
        for (const t of list) {
          if (bandOf.get(t.weight) !== b) continue;
          waits.push(Math.max(0, t.lastAt - t.firstSince));
          if (t.weight < minWeight) minWeight = t.weight;
          if (t.weight > maxWeight) maxWeight = t.weight;
        }
        return {
          band,
          minWeight,
          maxWeight,
          tries: waits.length,
          waitP50: quantile(waits, 0.5),
          waitP95: quantile(waits, 0.95),
        };
      }).filter((b) => b.tries > 0);
      return { pool, tries: list.length, distinctWeights: weights.length, bands };
    });
}
