/**
 * `af.facts` (standard): finished task instance tries by `updated_at` window (spec Appendix B.3,
 * §7.5 "Pagination and consistency").
 *
 * - Window: from the persisted watermark to now minus a one-minute settling delay (B.3: "the window
 *   end is a closed boundary"). The first cycle reads a bounded first window of one hour; backfill
 *   beyond it is FR-COLL-04 (M2).
 * - Overlap (§7.7 L713, 10 minutes): it catches rows that became visible after their window was read
 *   (rows marked again by hand get a new `updated_at` and fall in the newest window anyway). Re-reading
 *   10 minutes every cycle would cost about three extra pages a minute at 28 finished task instances a
 *   minute, above the §7.11 arithmetic (1–2 requests a minute), so the window starts at
 *   `watermark − overlap` once per overlap period, and always after a restart.
 * - The API v1 task instance list has no `order_by` and no defined order, so offset paging over a
 *   changing set can skip or repeat rows. Each request is therefore one page of 100 at offset 0; a
 *   window whose `total_entries` exceeds the page is split (at most in half, smaller where the count
 *   says so) until each part fits. Only a window of the minimum width (1 s, B.3) is paged by offset,
 *   re-read until every key is seen; otherwise it stays incomplete and is retried next cycle.
 * - Windows are read oldest first. The tries of every complete window and the end of the last one are
 *   committed in one transaction (`commitFacts`, FR-STORE-06); the request cap or an exhausted budget
 *   commits nothing past the last complete window. A cycle that stops early leaves its split windows,
 *   with their counts, to the next cycle, which continues from the committed watermark. Upserts on the
 *   natural key make re-reads idempotent (FR-COLL-03).
 * - States: B.3's finished states plus `up_for_retry`, the row of a failed try waiting for its retry,
 *   which still carries that try's number, start and end until the scheduler schedules the next try
 *   (Airflow 2.10+ increments `try_number` at scheduling: RELEASE_NOTES.rst "try_number is no longer
 *   incremented during task execution (#39336)"; `airflow/models/taskinstance.py` and
 *   `airflow/models/dagrun.py` at 2.11.1). Without it a retried try would be lost once rescheduled.
 *
 * @implements FR-COLL-01, FR-COLL-03, FR-COLL-06, FR-STORE-06
 */
import type { AirflowTaskInstance, StoredTaskTry } from '@dcam/ports';
import { BudgetExhaustedError, type Collector } from '../types';
import { assertSupported, keyString, storedTryOf } from './mapping';

export const FACT_STATES = ['success', 'failed', 'upstream_failed', 'skipped', 'up_for_retry'] as const;
const PAGE_SIZE = 100;
/** Rows a split part aims at, leaving room for rows that arrive while the window is read. */
const TARGET_ROWS = 80;
export const FACTS_OVERLAP_MS = 10 * 60_000;
export const FACTS_SETTLE_MS = 60_000;
export const FIRST_FACTS_WINDOW_MS = 60 * 60_000;
/** B.3: the minimum window width, below which DCAM pages by offset. */
const MIN_WINDOW_MS = 1_000;
const MAX_REQUESTS = 6;
const ID = 'af.facts';
/** Full re-reads of a minimum-width window before it is left for the next cycle. */
const DENSE_PASSES = 2;

interface Window {
  readonly from: number;
  readonly to: number;
  /** `total` rows were seen in `[countFrom, to]`: what is left after the windows before this one. */
  known?: { total: number; readonly countFrom: number };
}

/** What one environment's previous cycle left: the split windows still to read, and the overlap. */
interface Progress {
  /** The watermark after that cycle. */
  readonly watermark: number | null;
  readonly pending: readonly Window[];
  /** The window end that cycle read towards. */
  readonly end: number;
  /** When the overlap was last re-read; `null` until it has been. */
  readonly overlapReadAt: number | null;
}

class Stop extends Error {}

const iso = (ms: number) => new Date(ms).toISOString();
const copy = (w: Window): Window => (w.known ? { ...w, known: { ...w.known } } : { from: w.from, to: w.to });

export function afFactsCollector(): Collector {
  const progress = new Map<string, Progress>();
  return {
    manifest: {
      id: ID,
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowFacts',
      priority: 'standard',
      maxRequestsPerCycle: MAX_REQUESTS,
      outputs: ['tries'],
      sourceKinds: ['composer', 'airflow'],
    },
    async collect(ctx) {
      assertSupported(ctx);
      const envId = ctx.env.id;
      const watermark = await ctx.store.watermark(envId, ID);
      const now = ctx.now();
      const end = now - FACTS_SETTLE_MS;
      const last = progress.get(envId);
      const overlapReadAt = last?.overlapReadAt ?? null;

      let pending: Window[];
      let readOverlap = false;
      if (last && last.watermark === watermark && last.pending.length > 0) {
        pending = last.pending.map(copy);
        if (end > last.end) pending.push({ from: last.end, to: end });
      } else {
        readOverlap =
          watermark !== null && (overlapReadAt === null || now - overlapReadAt >= FACTS_OVERLAP_MS);
        const from =
          watermark === null
            ? end - FIRST_FACTS_WINDOW_MS
            : readOverlap
              ? watermark - FACTS_OVERLAP_MS
              : watermark;
        if (end <= from) return { dataAsOf: null };
        pending = [{ from, to: end }];
      }
      const start = (pending[0] as Window).from;

      const airflow = ctx.airflow();
      let requests = 0;
      const request = async (w: Window, offset: number) => {
        if (requests >= MAX_REQUESTS) throw new Stop();
        requests++;
        return airflow.taskInstances({
          states: FACT_STATES,
          updatedFrom: w.from,
          updatedTo: w.to,
          limit: PAGE_SIZE,
          offset,
        });
      };

      const rows = new Map<string, StoredTaskTry>();
      let committedTo: number | null = null;
      const accept = (w: Window, items: readonly AirflowTaskInstance[]) => {
        for (const t of items) rows.set(keyString(t), storedTryOf(envId, t));
        committedTo = w.to;
        pending.shift();
        for (const p of pending)
          if (p.known && p.known.countFrom <= w.from)
            p.known.total = Math.max(0, p.known.total - items.length);
      };

      /** Offset paging within a minimum-width window until every key is seen, or `null`. */
      const readDense = async (w: Window, first: readonly AirflowTaskInstance[], firstTotal: number) => {
        const seen = new Map(first.map((t) => [keyString(t), t]));
        let total = firstTotal;
        for (let pass = 0, offset = PAGE_SIZE; pass < DENSE_PASSES;) {
          if (offset >= total) {
            if (seen.size >= total) return [...seen.values()];
            pass++;
            offset = 0;
            continue;
          }
          const page = await request(w, offset);
          total = page.total;
          for (const t of page.items) seen.set(keyString(t), t);
          offset += PAGE_SIZE;
        }
        return seen.size >= total ? [...seen.values()] : null;
      };

      let stopped: string | null = null;
      try {
        while (pending.length > 0) {
          const w = pending[0] as Window;
          const width = w.to - w.from;
          if (w.known && w.known.total > PAGE_SIZE && width > MIN_WINDOW_MS) {
            const share = Math.min(0.5, TARGET_ROWS / w.known.total);
            const mid = w.from + Math.max(MIN_WINDOW_MS, Math.floor(width * share));
            pending.splice(0, 1, { from: w.from, to: mid }, { from: mid, to: w.to, known: w.known });
            continue;
          }
          const page = await request(w, 0);
          if (page.total <= page.items.length) accept(w, page.items);
          else if (width > MIN_WINDOW_MS) w.known = { total: page.total, countFrom: w.from };
          else {
            const all = await readDense(w, page.items, page.total);
            if (all === null) {
              stopped = `More than ${PAGE_SIZE} task instances changed within one second at ${iso(w.from)} and could not all be read; that second is read again next cycle.`;
              break;
            }
            accept(w, all);
          }
        }
      } catch (e) {
        if (e instanceof Stop)
          stopped = `Finished task instances are read within the request budget; ${iso(committedTo ?? start)} to ${iso(end)} continues next cycle.`;
        else if (e instanceof BudgetExhaustedError)
          stopped = `The Airflow request budget is used up; finished task instances after ${iso(committedTo ?? start)} continue next cycle.`;
        else {
          await commit();
          throw e;
        }
      }
      await commit();
      if (stopped !== null) ctx.reducedFidelity(stopped);
      return { dataAsOf: committedTo };

      async function commit() {
        if (committedTo !== null) await ctx.store.commitFacts(envId, ID, [...rows.values()], committedTo);
        progress.set(envId, {
          watermark: committedTo ?? watermark,
          pending,
          end,
          overlapReadAt: readOverlap ? now : overlapReadAt,
        });
      }
    },
  };
}
