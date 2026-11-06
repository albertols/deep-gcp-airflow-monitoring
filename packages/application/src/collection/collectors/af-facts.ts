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
 *   says so) until each part fits. Only a window of the minimum width (1 s, B.3) is paged by offset.
 * - Page size: upstream Airflow 2.11.1 does not cap `limit` on this list, but Composer's cap is not
 *   documented (spec §7.5 "Pagination and consistency", VC-11 open). A page shorter than both the limit
 *   and the rows left shows a lower cap: from then on the environment's windows are split to the largest
 *   page the server returned, and offsets advance by the rows each page returned, so a cap below 100
 *   neither repeats a window forever nor skips rows.
 * - A dense second (one statement can mark hundreds of mapped task instances skipped) may need more
 *   pages than a cycle allows. Its rows are kept across cycles until every key is seen, and it gets at
 *   most {@link MAX_REQUESTS} − {@link LATER_RESERVE} requests a cycle while later windows wait, so they
 *   are still read and stored. After {@link DENSE_PASSES} full passes over its offsets, or
 *   {@link DENSE_MAX_CYCLES} cycles, DCAM keeps what it read and reports how many are missing. Until
 *   then the reduced-fidelity reason says the history is stuck at that second.
 * - Windows are read oldest first. The tries of every complete window are committed in one transaction
 *   with the watermark (`commitFacts`, FR-STORE-06). The watermark is the end of the last complete window
 *   before any incomplete one, so it waits at a dense second while later rows are already stored; the
 *   request cap or an exhausted budget commits nothing past the last complete window. A cycle that stops
 *   early leaves its windows, with their counts and dense rows, to the next cycle, which continues from
 *   the committed watermark. Upserts on the natural key make re-reads idempotent (FR-COLL-03).
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
/** Share of a page a split part aims at, leaving room for rows that arrive while the window is read. */
const TARGET_SHARE = 0.8;
export const FACTS_OVERLAP_MS = 10 * 60_000;
export const FACTS_SETTLE_MS = 60_000;
export const FIRST_FACTS_WINDOW_MS = 60 * 60_000;
/** B.3: the minimum window width, below which DCAM pages by offset. */
const MIN_WINDOW_MS = 1_000;
const MAX_REQUESTS = 6;
const ID = 'af.facts';
/** Requests a cycle keeps for the windows after a dense second, so that one burst never blocks them. */
const LATER_RESERVE = 2;
/** Full passes over a dense second's offsets that may end with keys missing before DCAM keeps what it read. */
const DENSE_PASSES = 2;
/** Cycles a dense second may take before DCAM keeps what it read. */
const DENSE_MAX_CYCLES = 10;

/** A minimum-width window paged by offset; its rows are kept across cycles until every key is seen. */
interface Dense {
  readonly seen: Map<string, StoredTaskTry>;
  offset: number;
  total: number;
  /** Passes over every offset that ended with keys missing (the order changed while it was paged). */
  passes: number;
  /** Cycles that left it incomplete. */
  cycles: number;
}

interface Window {
  readonly from: number;
  readonly to: number;
  /** `total` rows were seen in `[countFrom, to]`: what is left after the windows before this one. */
  known?: { total: number; readonly countFrom: number };
  dense?: Dense;
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
const copy = (w: Window): Window => {
  const c: Window = { from: w.from, to: w.to };
  if (w.known) c.known = { ...w.known };
  if (w.dense) c.dense = w.dense;
  return c;
};

export function afFactsCollector(): Collector {
  const progress = new Map<string, Progress>();
  /** Per environment, the largest page the server returned once a short page showed a cap below the limit. */
  const served = new Map<string, number>();
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
      /** Rows the server returns per page. */
      const pageRows = () => served.get(envId) ?? PAGE_SIZE;
      const request = async (w: Window, offset: number) => {
        if (requests >= MAX_REQUESTS) throw new Stop();
        requests++;
        const page = await airflow.taskInstances({
          states: FACT_STATES,
          updatedFrom: w.from,
          updatedTo: w.to,
          limit: PAGE_SIZE,
          offset,
        });
        const n = page.items.length;
        if (n > 0 && n < PAGE_SIZE && n < page.total - offset)
          served.set(envId, Math.max(n, served.get(envId) ?? 0));
        return page;
      };

      const rows = new Map<string, StoredTaskTry>();
      const stored = (items: readonly AirflowTaskInstance[]) =>
        items.map((t) => [keyString(t), storedTryOf(envId, t)] as const);
      /** End of the last window accepted with no incomplete window before it. */
      let frontier: number | null = null;
      /** Start of the first window left incomplete this cycle: the watermark waits there. */
      let blocked: number | null = null;
      const notes: string[] = [];

      /** The rows of `w` are accounted for: later parts counted over it no longer include them. */
      const settle = (w: Window, count: number) => {
        for (const p of pending)
          if (p !== w && p.from >= w.to && p.known && p.known.countFrom <= w.from)
            p.known.total = Math.max(0, p.known.total - count);
      };
      const accept = (i: number, w: Window, items: Iterable<readonly [string, StoredTaskTry]>) => {
        let count = 0;
        for (const [k, t] of items) {
          rows.set(k, t);
          count++;
        }
        pending.splice(i, 1);
        if (blocked === null) frontier = w.to;
        settle(w, count);
      };
      const leave = (w: Window, d: Dense) => {
        d.cycles++;
        blocked ??= w.from;
        settle(w, d.total);
        notes.push(
          `The finished task instance history is stuck at ${iso(w.from)}: ${d.total} task instances changed within that second and ${d.seen.size} have been read in ${d.cycles} cycles. Later ones are stored; that second is read again next cycle, and after ${DENSE_MAX_CYCLES} cycles DCAM keeps what it read.`,
        );
      };

      /** Offset paging of a dense second with the requests this cycle can give it. */
      const readDense = async (w: Window, d: Dense, later: boolean) => {
        const limit = later ? MAX_REQUESTS - LATER_RESERVE : MAX_REQUESTS;
        for (;;) {
          if (d.offset >= d.total) {
            if (d.seen.size >= d.total) return 'complete';
            d.passes++;
            d.offset = 0;
          }
          if (d.passes >= DENSE_PASSES || d.cycles >= DENSE_MAX_CYCLES) return 'partial';
          if (requests >= limit) return 'incomplete';
          const page = await request(w, d.offset);
          d.total = page.total;
          for (const [k, t] of stored(page.items)) d.seen.set(k, t);
          // An empty page before the end: rows left the second while it was paged; the pass ends here.
          d.offset = page.items.length > 0 ? d.offset + page.items.length : d.total;
        }
      };

      try {
        for (let i = 0; i < pending.length;) {
          const w = pending[i] as Window;
          const width = w.to - w.from;
          if (w.dense) {
            const d = w.dense;
            const outcome = await readDense(w, d, i < pending.length - 1);
            if (outcome === 'incomplete') {
              leave(w, d);
              i++;
              continue;
            }
            if (outcome === 'partial')
              notes.push(
                `DCAM read ${d.seen.size} of the ${d.total} task instances that changed within one second at ${iso(w.from)}; the other ${Math.max(0, d.total - d.seen.size)} are missing from the history (their order changed while they were paged).`,
              );
            accept(i, w, d.seen);
            continue;
          }
          if (w.known && w.known.total > pageRows() && width > MIN_WINDOW_MS) {
            const share = Math.min(0.5, Math.max(1, Math.floor(pageRows() * TARGET_SHARE)) / w.known.total);
            const mid = w.from + Math.max(MIN_WINDOW_MS, Math.floor(width * share));
            pending.splice(i, 1, { from: w.from, to: mid }, { from: mid, to: w.to, known: w.known });
            continue;
          }
          const page = await request(w, 0);
          if (page.total <= page.items.length) accept(i, w, stored(page.items));
          else if (width > MIN_WINDOW_MS) w.known = { total: page.total, countFrom: w.from };
          else
            w.dense = {
              seen: new Map(stored(page.items)),
              offset: page.items.length > 0 ? page.items.length : page.total,
              total: page.total,
              passes: 0,
              cycles: 0,
            };
        }
      } catch (e) {
        const from = iso(blocked ?? frontier ?? start);
        if (e instanceof Stop)
          notes.push(
            `Finished task instances are read within the request budget; ${from} to ${iso(end)} continues next cycle.`,
          );
        else if (e instanceof BudgetExhaustedError)
          notes.push(
            `The Airflow request budget is used up; finished task instances after ${from} continue next cycle.`,
          );
        else {
          await commit();
          throw e;
        }
      }
      const committed = await commit();
      if (notes.length > 0) ctx.reducedFidelity(notes.join(' '));
      return { dataAsOf: committed };

      /** Commits the rows read and the watermark, which never moves back; returns it, or `null`. */
      async function commit(): Promise<number | null> {
        const reached = blocked ?? frontier;
        const next = reached === null ? watermark : Math.max(reached, watermark ?? -Infinity);
        const advanced = next !== null && (rows.size > 0 || next !== watermark);
        if (advanced) await ctx.store.commitFacts(envId, ID, [...rows.values()], next);
        progress.set(envId, {
          watermark: next,
          pending,
          end,
          overlapReadAt: readOverlap ? now : overlapReadAt,
        });
        return advanced ? next : null;
      }
    },
  };
}
