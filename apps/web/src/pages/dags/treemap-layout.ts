/**
 * Squarified treemap layout (Bruls, Huizing and van Wijk, 2000) for team → DAG, sized by executor
 * slot-seconds and coloured by p95 queue wait. Pure geometry; the SVG lives in Treemap.tsx.
 *
 * @implements FR-DAGX-04
 */
import type { DagLeagueRow, Quantile } from '@dcam/contracts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Sized<T> {
  readonly item: T;
  readonly area: number;
}

/** Worst aspect ratio of a row of areas laid along a side of length `side`. */
function worst<T>(row: readonly Sized<T>[], side: number): number {
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const r of row) {
    sum += r.area;
    max = Math.max(max, r.area);
    min = Math.min(min, r.area);
  }
  const s2 = sum * sum;
  const w2 = side * side;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

/** Tiles with areas proportional to `value`, largest first, filling `rect`; non-positive values are skipped. */
export function squarify<T extends { readonly value: number }>(
  items: readonly T[],
  rect: Rect,
): Array<T & Rect> {
  const positive = items
    .filter((i) => Number.isFinite(i.value) && i.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = positive.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || rect.width <= 0 || rect.height <= 0) return [];
  const scale = (rect.width * rect.height) / total;
  const out: Array<T & Rect> = [];
  let free: Rect = rect;

  const place = (row: readonly Sized<T>[]) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    if (free.width >= free.height) {
      // A column along the left edge.
      const width = Math.min(free.width, sum / free.height);
      let y = free.y;
      for (const { item, area } of row) {
        const height = area / width;
        out.push({ ...item, x: free.x, y, width, height });
        y += height;
      }
      free = { x: free.x + width, y: free.y, width: Math.max(0, free.width - width), height: free.height };
    } else {
      // A row along the top edge.
      const height = Math.min(free.height, sum / free.width);
      let x = free.x;
      for (const { item, area } of row) {
        const width = area / height;
        out.push({ ...item, x, y: free.y, width, height });
        x += width;
      }
      free = { x: free.x, y: free.y + height, width: free.width, height: Math.max(0, free.height - height) };
    }
  };

  let row: Sized<T>[] = [];
  for (const item of positive) {
    const next = { item, area: item.value * scale };
    const side = Math.min(free.width, free.height);
    if (row.length === 0 || worst([...row, next], side) <= worst(row, side)) row.push(next);
    else {
      place(row);
      row = [next];
    }
  }
  if (row.length > 0) place(row);
  return out;
}

export interface TreemapTile extends Rect {
  /** One DAG, or the smaller DAGs of a team folded into one tile. */
  readonly kind: 'dag' | 'other';
  readonly id: string;
  readonly label: string;
  readonly team: string;
  /** Executor slot-seconds. */
  readonly value: number;
  readonly dagCount: number;
  readonly row: DagLeagueRow | null;
}

export interface TreemapGroup extends Rect {
  readonly team: string;
  readonly value: number;
  readonly dagCount: number;
  readonly tiles: TreemapTile[];
}

export interface TreemapOptions {
  /** Largest DAGs drawn as their own tile; the rest of each team becomes one "other" tile. */
  readonly maxTiles?: number;
  /** Space reserved at the top of each team for its label. */
  readonly headerHeight?: number;
  readonly padding?: number;
}

function inset(r: Rect, padding: number, header: number): Rect {
  const inner = {
    x: r.x + padding,
    y: r.y + header,
    width: r.width - 2 * padding,
    height: r.height - header - padding,
  };
  return inner.width > 0 && inner.height > 0 ? inner : r;
}

/** Teams sized by their DAGs' slot-seconds, each filled with its DAGs. Inactive DAGs take no space. */
export function treemapLayout(
  rows: readonly DagLeagueRow[],
  rect: Rect,
  { maxTiles = 200, headerHeight = 0, padding = 0 }: TreemapOptions = {},
): TreemapGroup[] {
  const active = rows.filter((r) => r.executor_slot_seconds > 0);
  const shown = new Set(
    [...active]
      .sort((a, b) => b.executor_slot_seconds - a.executor_slot_seconds)
      .slice(0, maxTiles)
      .map((r) => r.dag_id),
  );
  const byTeam = new Map<string, DagLeagueRow[]>();
  for (const r of active) {
    const list = byTeam.get(r.team);
    if (list) list.push(r);
    else byTeam.set(r.team, [r]);
  }
  const teams = squarify(
    [...byTeam].map(([team, list]) => ({
      team,
      value: list.reduce((s, r) => s + r.executor_slot_seconds, 0),
    })),
    rect,
  );
  return teams.map((g) => {
    const list = byTeam.get(g.team) ?? [];
    const rest = list.filter((r) => !shown.has(r.dag_id));
    const items: Array<Omit<TreemapTile, keyof Rect>> = list
      .filter((r) => shown.has(r.dag_id))
      .map((r) => ({
        kind: 'dag',
        id: r.dag_id,
        label: r.dag_id,
        team: g.team,
        value: r.executor_slot_seconds,
        dagCount: 1,
        row: r,
      }));
    if (rest.length > 0)
      items.push({
        kind: 'other',
        id: `${g.team}\u0000other`,
        label: `${rest.length} smaller DAG${rest.length === 1 ? '' : 's'}`,
        team: g.team,
        value: rest.reduce((s, r) => s + r.executor_slot_seconds, 0),
        dagCount: rest.length,
        row: null,
      });
    return { ...g, dagCount: list.length, tiles: squarify(items, inset(g, padding, headerHeight)) };
  });
}

export type QueueWaitBand = 'none' | 'low' | 'medium' | 'high';

/** Colour bands for p95 queue wait (HM-001): under 1 min, 1–5 min, 5 min or more, or no data. */
export function queueWaitBand(q: Quantile): QueueWaitBand {
  if (q.value_seconds === null) return 'none';
  if (q.value_seconds < 60) return 'low';
  if (q.value_seconds < 300) return 'medium';
  return 'high';
}

export const QUEUE_WAIT_BANDS: ReadonlyArray<{ readonly band: QueueWaitBand; readonly label: string }> = [
  { band: 'low', label: 'p95 queue wait under 1 min' },
  { band: 'medium', label: '1 to 5 min' },
  { band: 'high', label: '5 min or more' },
  { band: 'none', label: 'No data, or several DAGs' },
];
