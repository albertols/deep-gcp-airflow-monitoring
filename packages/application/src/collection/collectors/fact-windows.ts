/**
 * Reading finished task instances by closed `updated_at` windows (spec Appendix B.3), oldest first (live facts)
 * or newest first (backfill, FR-COLL-04). The same rules as `af.facts`, in a form both collectors can use:
 *
 * - Airflow 2.11.1 `GET /dags/~/dagRuns/~/taskInstances` filters on `updated_at_gte` and `updated_at_lte`,
 *   both inclusive, and has no `order_by` and no ORDER BY, so rows come in no defined order
 *   (`airflow/api_connexion/openapi/v1.yaml` and `get_task_instances` with `_apply_range_filter` in
 *   `airflow/api_connexion/endpoints/task_instance_endpoint.py`, tag 2.11.1). Each request is therefore one
 *   page of 100 at offset 0, and a window whose `total_entries` exceeds the page is split (at most in half,
 *   smaller where the count says so) until each part fits. Only a window of the minimum width (1 s, B.3) is
 *   paged by offset.
 * - Newest first, the part read first is the newer one, and "reached" is the end of the newest window not
 *   read yet: history is complete from there to the end of the plan, across cycles. Oldest first, it is the
 *   start of the oldest window not read yet. With every window read it is the far end of the plan.
 * - Adaptive sizing (backfill): a part's width also follows the density of the last window read, so busy and
 *   quiet hours both get parts of about 80 rows (a count over seven days says little about one hour). Its
 *   width grows at most fourfold from one part to the next.
 * - A dense second (one statement can mark hundreds of mapped task instances skipped) is paged by offset
 *   across cycles; its rows are kept until every key is seen. It gets at most `maxRequests − laterReserve`
 *   requests a cycle while later windows wait, so those are still read. After {@link DENSE_PASSES} full
 *   passes or {@link DENSE_MAX_CYCLES} cycles DCAM keeps what it read and says how many are missing.
 * - Page caps below 100 (Composer's cap is not documented, spec §7.5, VC-11 open): a cap is learned only when
 *   two short pages (fewer rows than asked and than left) agree, raised by any larger page, and forgotten on a
 *   full page. One short page can be a race between the count and the select (rows leaving the window), and
 *   learning from it would cut every window to the minimum width. A window whose page was short is halved
 *   rather than read again, which ends both a race and a cap not learnt yet without repeating a request.
 *   Offsets advance by the rows each page returned.
 *
 * `af.facts` keeps its own copy of these rules for now (its page-cap rule is being corrected separately);
 * once that lands it can read through this module, so that the rules live in one place.
 *
 * @implements FR-COLL-03, FR-COLL-04, FR-COLL-06
 */
import type { AirflowApi, AirflowTaskInstance, StoredTaskTry } from '@dcam/ports';
import { BudgetExhaustedError } from '../types';
import { FACT_STATES } from './af-facts';
import { keyString, storedTryOf } from './mapping';

const PAGE_SIZE = 100;
/** Share of a page a split part aims at, leaving room for rows that arrive while the window is read. */
const TARGET_SHARE = 0.8;
/** B.3: the minimum window width, below which DCAM pages by offset. */
export const MIN_WINDOW_MS = 1_000;
/** Full passes over a dense second's offsets that may end with keys missing before DCAM keeps what it read. */
const DENSE_PASSES = 2;
/** Cycles a dense second may take before DCAM keeps what it read. */
const DENSE_MAX_CYCLES = 10;
/** Most an adaptive part may grow from the last part read. */
const MAX_GROWTH = 4;

export interface FactWindowReaderOptions {
  readonly direction: 'forward' | 'backward';
  /** Task instance requests one cycle may make. */
  readonly maxRequests: number;
  /** Requests a cycle keeps for the windows after a dense second. */
  readonly laterReserve: number;
  /** Size parts by the density of the last window read as well as by the count. */
  readonly adaptive?: boolean;
  /** The history's name in messages, for example "task instance backfill". */
  readonly history: string;
}

interface Dense {
  readonly seen: Map<string, StoredTaskTry>;
  offset: number;
  total: number;
  /** Passes over every offset that ended with keys missing (the order changed while it was paged). */
  passes: number;
  /** Cycles that left it incomplete. */
  cycles: number;
}

/** One closed window `[from, to]` to read. */
export interface FactWindow {
  readonly from: number;
  readonly to: number;
  /** `total` rows were counted over `[countFrom, countTo]`, less the windows inside it read since. */
  known?: { total: number; readonly countFrom: number; readonly countTo: number };
  /** Its page was short: it is split in half next, never read again whole. */
  halve?: boolean;
  dense?: Dense;
}

export interface FactWindowResult {
  /** Rows of the windows completed this cycle, by natural key. */
  readonly rows: ReadonlyMap<string, StoredTaskTry>;
  /** Where the history read so far ends, across cycles (see the module comment). */
  readonly reached: number;
  /** `done`: no window left; `cap`: the cycle's requests are used; `budget`: the budget refused a request. */
  readonly stop: 'done' | 'cap' | 'budget' | 'error';
  readonly requests: number;
  /** Dense seconds still incomplete or kept partially, in plain words. */
  readonly notes: readonly string[];
  /** Where the history waits for an incomplete dense second, if anywhere. */
  readonly stuckAt: number | null;
  /** A source error other than the budget: the caller commits the rows, then rethrows it. */
  readonly error: Error | null;
}

class Stop extends Error {}

const iso = (ms: number) => new Date(ms).toISOString();

/** The largest page the server returns, learned from short pages that agree (see the module comment). */
class PageCap {
  private cap: number | null = null;
  private candidate: number | null = null;

  rows(): number {
    return this.cap ?? PAGE_SIZE;
  }

  observe(n: number, left: number): void {
    if (n >= PAGE_SIZE) {
      this.cap = null;
      this.candidate = null;
      return;
    }
    if (this.cap !== null && n > this.cap) this.cap = n;
    const short = n > 0 && n < left;
    if (!short) return;
    if (this.candidate === n) this.cap = Math.max(this.cap ?? 0, n);
    this.candidate = n;
  }
}

/** The windows of one environment still to read, kept across cycles. */
export class FactWindowReader {
  pending: FactWindow[] = [];
  /** The far end of the plan in reading order: reached once every window is read. */
  private end = 0;
  private readonly cap = new PageCap();
  /** Rows per ms of the last window read, and its width (adaptive sizing). */
  private last: { readonly density: number; readonly width: number } | null = null;

  constructor(private readonly options: FactWindowReaderOptions) {}

  /** Replaces the windows to read, in reading order (a new plan, or after a restart). */
  reset(windows: readonly FactWindow[]): void {
    this.pending = windows.map((w) => ({ from: w.from, to: w.to }));
    const last = windows.at(-1);
    if (last) this.end = this.options.direction === 'forward' ? last.to : last.from;
  }

  /** Where the history read so far ends (see the module comment). */
  reached(): number {
    const next = this.pending[0];
    if (!next) return this.end;
    return this.options.direction === 'forward' ? next.from : next.to;
  }

  /** Rows per page the server returns. */
  pageRows(): number {
    return this.cap.rows();
  }

  /** Rows left to read, once the last window in reading order (it spans the rest) has been counted. */
  remaining(): number | null {
    return this.pending.at(-1)?.known?.total ?? null;
  }

  async read(airflow: AirflowApi, envId: string): Promise<FactWindowResult> {
    const { direction, maxRequests, laterReserve, history } = this.options;
    const forward = direction === 'forward';
    const pending = this.pending;
    const rows = new Map<string, StoredTaskTry>();
    const notes: string[] = [];
    let requests = 0;
    let blocked: number | null = null;
    let stop: FactWindowResult['stop'] = 'done';
    let error: Error | null = null;

    const request = async (w: FactWindow, offset: number) => {
      if (requests >= maxRequests) throw new Stop();
      requests++;
      let page: Awaited<ReturnType<AirflowApi['taskInstances']>>;
      try {
        page = await airflow.taskInstances({
          states: FACT_STATES,
          updatedFrom: w.from,
          updatedTo: w.to,
          limit: PAGE_SIZE,
          offset,
        });
      } catch (e) {
        // A request the budget refused was never sent.
        if (e instanceof BudgetExhaustedError) requests--;
        throw e;
      }
      this.cap.observe(page.items.length, page.total - offset);
      return page;
    };
    const stored = (items: readonly AirflowTaskInstance[]) =>
      items.map((t) => [keyString(t), storedTryOf(envId, t)] as const);

    /** The rows of `w` are accounted for: parts counted over it no longer include them. */
    const settle = (w: FactWindow, count: number) => {
      for (const p of pending)
        if (p !== w && p.known && p.known.countFrom <= w.from && w.to <= p.known.countTo)
          p.known.total = Math.max(0, p.known.total - count);
    };
    const accept = (i: number, w: FactWindow, items: Iterable<readonly [string, StoredTaskTry]>) => {
      let count = 0;
      for (const [k, t] of items) {
        rows.set(k, t);
        count++;
      }
      pending.splice(i, 1);
      settle(w, count);
      const width = Math.max(MIN_WINDOW_MS, w.to - w.from);
      if (!w.dense) this.last = { density: Math.max(1, count) / width, width };
    };
    const leave = (w: FactWindow, d: Dense) => {
      d.cycles++;
      blocked ??= forward ? w.from : w.to;
      settle(w, d.total);
      notes.push(
        `The ${history} is stuck at ${iso(w.from)}: ${d.total} task instances changed within that second and ${d.seen.size} have been read in ${d.cycles} cycles. Other windows are read meanwhile; that second is read again next cycle, and after ${DENSE_MAX_CYCLES} cycles DCAM keeps what it read.`,
      );
    };
    const readDense = async (w: FactWindow, d: Dense, later: boolean) => {
      const limit = later ? maxRequests - laterReserve : maxRequests;
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
    /** Width of the part read first when `w` (counted) is split. */
    const firstPart = (w: FactWindow, total: number) => {
      const width = w.to - w.from;
      const target = Math.max(1, Math.floor(this.pageRows() * TARGET_SHARE));
      let part = Math.floor(width * Math.min(0.5, target / total));
      if (this.options.adaptive && this.last)
        part = Math.min(Math.floor(width / 2), target / this.last.density, MAX_GROWTH * this.last.width);
      return Math.max(MIN_WINDOW_MS, Math.floor(part));
    };

    try {
      for (let i = 0; i < pending.length;) {
        const w = pending[i] as FactWindow;
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
        if (w.known && (w.known.total > this.pageRows() || w.halve) && width > MIN_WINDOW_MS) {
          // A window whose page was short (a cap not learnt yet, or a race) is halved, not read again.
          const part = w.halve ? Math.max(MIN_WINDOW_MS, Math.floor(width / 2)) : firstPart(w, w.known.total);
          const parts: FactWindow[] = forward
            ? [
                { from: w.from, to: w.from + part },
                { from: w.from + part, to: w.to, known: w.known },
              ]
            : [
                { from: w.to - part, to: w.to },
                { from: w.from, to: w.to - part, known: w.known },
              ];
          pending.splice(i, 1, ...parts);
          continue;
        }
        const page = await request(w, 0);
        if (page.total <= page.items.length) accept(i, w, stored(page.items));
        else if (width > MIN_WINDOW_MS) {
          w.known = { total: page.total, countFrom: w.from, countTo: w.to };
          if (page.items.length < Math.min(PAGE_SIZE, page.total)) w.halve = true;
        } else
          w.dense = {
            seen: new Map(stored(page.items)),
            offset: page.items.length > 0 ? page.items.length : page.total,
            total: page.total,
            passes: 0,
            cycles: 0,
          };
      }
    } catch (e) {
      if (e instanceof Stop) stop = 'cap';
      else if (e instanceof BudgetExhaustedError) stop = 'budget';
      else {
        stop = 'error';
        error = e instanceof Error ? e : new Error('The task instance list failed.', { cause: e });
      }
    }
    return {
      rows,
      reached: this.reached(),
      stop,
      requests,
      notes,
      stuckAt: blocked,
      error,
    };
  }
}
