/**
 * DAG × hour-of-day load heatmap for the top N DAGs (FR-DAGX-06): per UTC hour of the day, the mean number of
 * executor slots each DAG held over the hours of history in the range (one slot per running try, as HM-003
 * counts executor slot-seconds), so 1.5 means "one and a half slots on average in that hour of the day".
 *
 * The spec renders it from 5-minute rollups. The store has none yet, so this reads task tries: one pass, each
 * try split at UTC hour boundaries, O(tries × hours each spans) time and O(DAGs × 24) memory. Hours of the day
 * the history does not reach are `null`, never zero (NFR-DATA-03). Rollups replace the input later
 * (specs/009-env-capacity/plan.md).
 *
 * @implements FR-DAGX-06, HM-003, NFR-DATA-03
 */
import type { TaskTry } from './occupancy';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface DagLoadWindow {
  readonly from: number;
  readonly to: number;
  /** Running tries end here. */
  readonly now: number;
  /** Where the environment's task history starts (`null`: none); absent means it covers the range. */
  readonly historyFrom?: number | null;
  /** How many DAGs to return, by executor slot-seconds. */
  readonly top: number;
}

export interface DagLoadRow {
  readonly dagId: string;
  readonly executorSlotSeconds: number;
  /** Share of every DAG's executor slot-seconds in the range, 0–1. */
  readonly share: number;
  /** 24 entries, UTC hour of day: mean executor slots held; `null` where the range has no history. */
  readonly hours: readonly (number | null)[];
}

export interface DagLoadHeatmap {
  /** Hours of history in each UTC hour of the day (24 entries): the denominators of the means. */
  readonly coveredHours: readonly number[];
  readonly totalExecutorSlotSeconds: number;
  /** DAGs with executor slot time in the range. */
  readonly dagCount: number;
  readonly dags: readonly DagLoadRow[];
}

const hourOfDay = (t: number) => Math.floor((((t % DAY) + DAY) % DAY) / HOUR);

/** Adds the ms of `[a, b)` to `bins` by UTC hour of day. */
function spread(bins: Float64Array | number[], a: number, b: number) {
  for (let t = a; t < b;) {
    const next = Math.min(b, Math.floor(t / HOUR) * HOUR + HOUR);
    const h = hourOfDay(t);
    bins[h] = (bins[h] ?? 0) + (next - t);
    t = next;
  }
}

export function dagLoadByHour(tries: readonly TaskTry[], w: DagLoadWindow): DagLoadHeatmap {
  const history = w.historyFrom === undefined ? w.from : w.historyFrom;
  const coveredFrom = history === null ? Infinity : Math.max(w.from, history);
  const coveredTo = Math.min(w.to, w.now);
  const coveredMs = new Array<number>(24).fill(0);
  if (coveredFrom < coveredTo) spread(coveredMs, coveredFrom, coveredTo);

  const byDag = new Map<string, Float64Array>();
  const totals = new Map<string, number>();
  let grand = 0;
  for (const t of tries) {
    if (t.startAt === null) continue;
    const end = t.endAt ?? w.now;
    if (!(end >= t.startAt)) continue;
    const a = Math.max(t.startAt, coveredFrom);
    const b = Math.min(end, coveredTo);
    if (b <= a) continue;
    let bins = byDag.get(t.dagId);
    if (!bins) byDag.set(t.dagId, (bins = new Float64Array(24)));
    spread(bins, a, b);
    totals.set(t.dagId, (totals.get(t.dagId) ?? 0) + (b - a));
    grand += b - a;
  }

  const ranked = [...totals]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .slice(0, Math.max(0, w.top));
  return {
    coveredHours: coveredMs.map((ms) => ms / HOUR),
    totalExecutorSlotSeconds: grand / 1000,
    dagCount: totals.size,
    dags: ranked.map(([dagId, ms]) => {
      const bins = byDag.get(dagId) as Float64Array;
      return {
        dagId,
        executorSlotSeconds: ms / 1000,
        share: grand > 0 ? ms / grand : 0,
        hours: coveredMs.map((c, h) => (c > 0 ? (bins[h] as number) / c : null)),
      };
    }),
  };
}
