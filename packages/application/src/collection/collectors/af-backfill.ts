/**
 * `af.backfill` (background): the backfill on first add of finished task instances (FR-COLL-04, §7.7 L729).
 *
 * - Plan: `[A − days, A]` by `updated_at`, where `A` is `af.facts`' persisted watermark when the backfill
 *   first runs; until `af.facts` has committed one, it waits without a request. `af.facts` covers everything
 *   updated from its first window on (`S ≤ A`), so every row has exactly one `updated_at` on one side or both:
 *   no gap. `[S, A]` (normally `af.facts`' first hour) is read by both and stored once, because tries upsert
 *   on their natural key (FR-COLL-03). A row marked again while the backfill runs moves past `A`, where
 *   `af.facts` reads it.
 * - Reading: newest first through {@link FactWindowReader} (the same window rules as `af.facts`, sized by
 *   the density of the last window read), so recent history arrives first and the history stays contiguous
 *   with live collection. Airflow 2.11.1's list has no `order_by`, so splitting windows is the only safe
 *   paging (see `fact-windows.ts`).
 * - Budget: background priority. It takes the guaranteed background share and spare capacity (`budget.ts`)
 *   and yields to live and standard work; running out of budget ends the cycle with its progress, and is not
 *   reduced fidelity. Rows a dense second lost are (FR-COLL-06).
 * - Progress: the plan, how far history is covered, rows and requests used, start and completion, committed
 *   with the cycle's rows in one transaction (`commitBackfill`, FR-STORE-06). A restart resumes from the
 *   covered start without re-reading what is covered (§7.3: backfills resume from watermarks, not page
 *   tokens). More days configured later extend the plan back; 0 turns it off.
 * - ETA: rows left (the count of the remaining window) at the rate observed over the last 30 minutes.
 * - DAG runs: DCAM stores no runs; it derives them from tries (`domain/dag-runs.ts`), so this backfills runs
 *   too. Earlier tries of a task instance retried within the window are in task instance history
 *   (`GET …/tries`) and are not read here: the list returns each task instance's current row only.
 *
 * @implements FR-COLL-03, FR-COLL-04, FR-COLL-06, FR-STORE-06
 */
import type { BackfillProgress } from '@dcam/ports';
import { DAY_MS, ProgressRate, backfillDays } from '../backfill';
import type { BackfillReport, Collector } from '../types';
import { FactWindowReader } from './fact-windows';
import { assertSupported } from './mapping';

const ID = 'af.backfill';
const FACTS_ID = 'af.facts';
/** Task instance requests a cycle; the budget usually allows fewer (2 a minute guaranteed on standard). */
const MAX_REQUESTS = 20;
const LATER_RESERVE = 2;

interface Run {
  readonly reader: FactWindowReader;
  /** The plan's start and covered start the reader's windows were made for. */
  from: number;
  coveredFrom: number;
  readonly rate: ProgressRate;
}

const reportOf = (
  state: BackfillReport['state'],
  days: number,
  p: BackfillProgress | null,
  etaSeconds: number | null = null,
): BackfillReport => ({
  state,
  days,
  from: p?.from ?? null,
  to: p?.to ?? null,
  coveredFrom: p?.coveredFrom ?? null,
  itemsRead: p?.itemsRead ?? 0,
  requestsUsed: p?.requestsUsed ?? 0,
  etaSeconds,
});

export function afBackfillCollector(): Collector {
  const runs = new Map<string, Run>();
  return {
    manifest: {
      id: ID,
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowFacts',
      priority: 'background',
      maxRequestsPerCycle: MAX_REQUESTS,
      outputs: ['tries'],
      sourceKinds: ['composer', 'airflow'],
      backfill: 'task_instances',
    },
    async collect(ctx) {
      assertSupported(ctx);
      const envId = ctx.env.id;
      const days = backfillDays(ctx.env).taskInstancesDays;
      const now = ctx.now();
      let progress = await ctx.store.backfill(envId, ID);
      if (days === 0) {
        ctx.reportBackfill(reportOf('disabled', days, progress));
        return { dataAsOf: null };
      }
      if (!progress) {
        const anchor = await ctx.store.watermark(envId, FACTS_ID);
        if (anchor === null) {
          ctx.reportBackfill(reportOf('waiting', days, null));
          return { dataAsOf: null };
        }
        progress = {
          to: anchor,
          from: anchor - days * DAY_MS,
          coveredFrom: anchor,
          itemsRead: 0,
          requestsUsed: 0,
          startedAt: now,
          completedAt: null,
        };
        await ctx.store.commitBackfill(envId, ID, progress, {});
      }
      // The days may have changed since the plan was made.
      const from = progress.to - days * DAY_MS;
      if (progress.coveredFrom <= from) {
        if (progress.from !== from || progress.completedAt === null) {
          progress = { ...progress, from, completedAt: progress.completedAt ?? now };
          await ctx.store.commitBackfill(envId, ID, progress, {});
        }
        ctx.reportBackfill(reportOf('complete', days, progress, 0));
        return { dataAsOf: null };
      }

      let run = runs.get(envId);
      if (!run || run.from !== from || run.coveredFrom !== progress.coveredFrom) {
        // First cycle, a restart, or other days: read what is not covered yet.
        const reader =
          run?.reader ??
          new FactWindowReader({
            direction: 'backward',
            maxRequests: MAX_REQUESTS,
            laterReserve: LATER_RESERVE,
            adaptive: true,
            history: 'task instance backfill',
          });
        reader.reset([{ from, to: progress.coveredFrom }]);
        run = { reader, from, coveredFrom: progress.coveredFrom, rate: run?.rate ?? new ProgressRate() };
        runs.set(envId, run);
      }

      const result = await run.reader.read(ctx.airflow(), envId);
      const coveredFrom = Math.max(from, Math.min(progress.coveredFrom, result.reached));
      const complete = coveredFrom <= from;
      const next: BackfillProgress = {
        ...progress,
        from,
        coveredFrom,
        itemsRead: progress.itemsRead + result.rows.size,
        requestsUsed: progress.requestsUsed + result.requests,
        completedAt: complete ? now : null,
      };
      if (
        result.rows.size > 0 ||
        result.requests > 0 ||
        next.coveredFrom !== progress.coveredFrom ||
        next.from !== progress.from
      )
        await ctx.store.commitBackfill(envId, ID, next, { tries: [...result.rows.values()] });
      run.coveredFrom = coveredFrom;
      run.rate.record(now, next.itemsRead);
      for (const note of result.notes) if (!note.includes(' is stuck at ')) ctx.reducedFidelity(note);
      // The rows read before the error are committed above; the cycle still fails with it.
      if (result.error !== null) throw result.error;
      ctx.reportBackfill(
        reportOf(
          complete ? 'complete' : 'running',
          days,
          next,
          complete ? 0 : run.rate.eta(now, run.reader.remaining()),
        ),
      );
      return { dataAsOf: null };
    },
  };
}
