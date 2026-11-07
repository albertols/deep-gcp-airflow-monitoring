/**
 * `af.facts` (standard): finished task instance tries by `updated_at` window (spec Appendix B.3,
 * §7.5 "Pagination and consistency").
 *
 * - Window: from the persisted watermark to now minus a one-minute settling delay (B.3: "the window
 *   end is a closed boundary"). The first cycle reads a bounded first window of one hour; the history
 *   before it is `af.backfill`'s (FR-COLL-04).
 * - Overlap (§7.7 L713, 10 minutes): it catches rows that became visible after their window was read
 *   (rows marked again by hand get a new `updated_at` and fall in the newest window anyway). Re-reading
 *   10 minutes every cycle would cost about three extra pages a minute at 28 finished task instances a
 *   minute, above the §7.11 arithmetic (1–2 requests a minute), so the window starts at
 *   `watermark − overlap` once per overlap period, and always after a restart.
 * - Reading: oldest first through {@link FactWindowReader}, by the window rules `af.backfill` reads by too
 *   (`fact-windows.ts`): one page of 100 at offset 0 a request, a window split until each part fits, a page
 *   cap learnt only when two short pages agree, and a dense second paged by offset across cycles while
 *   {@link LATER_RESERVE} of the cycle's {@link MAX_REQUESTS} requests are kept for the windows after it.
 *   Until such a second is complete the reduced-fidelity reason says the history is stuck at it.
 * - Commit: the tries of every complete window are committed in one transaction with the watermark
 *   (`commitFacts`, FR-STORE-06). The watermark is the end of the last complete window before any
 *   incomplete one, so it waits at a dense second while later rows are already stored; the request cap or
 *   an exhausted budget commits nothing past the last complete window. A cycle that stops early leaves its
 *   windows, with their counts and dense rows, to the next cycle, which continues from the committed
 *   watermark; a cycle whose commit fails is read again. Upserts on the natural key make re-reads
 *   idempotent (FR-COLL-03).
 * - States: {@link FACT_STATES}, B.3's finished states plus `up_for_retry` (see `fact-windows.ts`).
 * - Import errors (HM-028): `GET /importErrors` once a cycle, after the task instances: §7.5 (L653) reads
 *   them "Every fact cycle" and §7.7 (L715) gives them to `af.facts`. They have a request of their own
 *   beyond the {@link MAX_REQUESTS} for task instances (about one request a minute on the standard
 *   profile, within the §7.11 line "Import errors, `/dagWarnings`, event log and health: about 1.5"),
 *   and patch only that health input, because `mon.core` writes the others concurrently.
 *
 * @implements FR-COLL-01, FR-COLL-03, FR-COLL-06, FR-STORE-06, HM-028 (import errors)
 */
import { BudgetExhaustedError, type Collector } from '../types';
import { FACT_STATES, FactWindowReader, type FactWindow } from './fact-windows';
import { assertSupported } from './mapping';

export { FACT_STATES };
export const FACTS_OVERLAP_MS = 10 * 60_000;
export const FACTS_SETTLE_MS = 60_000;
export const FIRST_FACTS_WINDOW_MS = 60 * 60_000;
/** Task instance requests a cycle; `GET /importErrors` takes one more. */
const MAX_REQUESTS = 6;
/** Requests a cycle keeps for the windows after a dense second, so that one burst never blocks them. */
const LATER_RESERVE = 2;
const ID = 'af.facts';

/** What one environment's previous cycle left: the split windows still to read, and the overlap. */
interface Progress {
  /** The watermark after that cycle. */
  readonly watermark: number | null;
  /** The windows still to read, as that cycle's commit left them ({@link FactWindowReader.snapshot}). */
  readonly pending: readonly FactWindow[];
  /** The window end that cycle read towards. */
  readonly end: number;
  /** When the overlap was last re-read; `null` until it has been. */
  readonly overlapReadAt: number | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function afFactsCollector(): Collector {
  const progress = new Map<string, Progress>();
  /** Per environment: the windows to read and the page cap learnt, kept across cycles. */
  const readers = new Map<string, FactWindowReader>();
  const readerOf = (envId: string) => {
    let reader = readers.get(envId);
    if (!reader) {
      reader = new FactWindowReader({
        direction: 'forward',
        maxRequests: MAX_REQUESTS,
        laterReserve: LATER_RESERVE,
        history: 'finished task instance history',
      });
      readers.set(envId, reader);
    }
    return reader;
  };
  return {
    manifest: {
      id: ID,
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowFacts',
      priority: 'standard',
      maxRequestsPerCycle: MAX_REQUESTS + 1,
      outputs: ['tries', 'health'],
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
      const notes: string[] = [];
      /** Reads the import error count into platform health; a refused request waits for the next cycle. */
      const importErrors = async () => {
        try {
          const count = await ctx.airflow().importErrorCount();
          await ctx.store.patchPlatformHealth(envId, { importErrors: count });
        } catch (e) {
          if (!(e instanceof BudgetExhaustedError)) throw e;
          notes.push('The Airflow request budget is used up; import errors are read next cycle.');
        }
      };

      const reader = readerOf(envId);
      let readOverlap = false;
      if (last && last.watermark === watermark && last.pending.length > 0) {
        reader.resume(end > last.end ? [...last.pending, { from: last.end, to: end }] : last.pending);
      } else {
        readOverlap =
          watermark !== null && (overlapReadAt === null || now - overlapReadAt >= FACTS_OVERLAP_MS);
        const from =
          watermark === null
            ? end - FIRST_FACTS_WINDOW_MS
            : readOverlap
              ? watermark - FACTS_OVERLAP_MS
              : watermark;
        if (end <= from) {
          await importErrors();
          if (notes.length > 0) ctx.reducedFidelity(notes.join(' '));
          return { dataAsOf: null };
        }
        reader.reset([{ from, to: end }]);
      }
      const start = reader.reached();

      const result = await reader.read(ctx.airflow(), envId);
      notes.push(...result.notes);
      if (result.stop === 'cap')
        notes.push(
          `Finished task instances are read within the request budget; ${iso(result.reached)} to ${iso(end)} continues next cycle.`,
        );
      else if (result.stop === 'budget')
        notes.push(
          `The Airflow request budget is used up; finished task instances after ${iso(result.reached)} and import errors continue next cycle.`,
        );

      // The end of the last complete window before any incomplete one, or `null` when none was complete:
      // windows are never empty, so the reader is past the start once one was.
      const reached = result.stuckAt ?? (result.reached === start ? null : result.reached);
      // The watermark never moves back.
      const next = reached === null ? watermark : Math.max(reached, watermark ?? -Infinity);
      const advanced = next !== null && (result.rows.size > 0 || next !== watermark);
      if (advanced) await ctx.store.commitFacts(envId, ID, [...result.rows.values()], next);
      progress.set(envId, {
        watermark: next,
        pending: reader.snapshot(),
        end,
        overlapReadAt: readOverlap ? now : overlapReadAt,
      });
      // The rows read before a source error are committed above; the cycle still fails with it.
      if (result.error !== null) throw result.error;
      if (result.stop !== 'budget') await importErrors();
      if (notes.length > 0) ctx.reducedFidelity(notes.join(' '));
      return { dataAsOf: advanced ? next : null };
    },
  };
}
