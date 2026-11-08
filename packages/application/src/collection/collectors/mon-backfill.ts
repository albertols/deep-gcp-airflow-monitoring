/**
 * `mon.backfill` (background, Composer only): the backfill on first add of Cloud Monitoring worker samples
 * (FR-COLL-04, default 14 days).
 *
 * - Plan: `[B − days, B]`, where `B` is now minus the 120 s ingestion delay, on a minute, at the first cycle
 *   (FR-COLL-07: no point is read before its delay has passed). `mon.core` reads from an hour before its own
 *   first cycle on, so the two overlap by up to an hour and samples upsert by minute: no gap, no duplicate.
 * - Reading: one day per chunk, newest first, at the 60 s alignment `mon.core` uses. `WorkerSample` is one
 *   sample per minute and every consumer counts a sample as at most one minute (`capacityStats`,
 *   `workerSignals`), so a coarser alignment would undercount minutes at max workers. Monitoring bills per
 *   series returned, not per point (NFR-OBS-06): a day is two limit queries (hourly alignment, the highest
 *   limit of the day) and the six sample series, each reduced to one series of 1,440 points, one page
 *   (`pageSize` counts points, at most 100,000). 14 days: 14 × 8 queries and the worker-type discovery,
 *   about 113 series once, against the default budget of 1,000,000 a month.
 * - Budget: background priority, within the Monitoring background share (5 a minute by default) and spare
 *   capacity. A day cut short by the budget keeps the series it read, so the next cycle asks only for the
 *   rest; a day is committed whole, with its progress, in one transaction (FR-STORE-06).
 * - Days without worker limits (before the environment existed, or not reported) are covered with no
 *   samples: a gap, never zeros (NFR-DATA-03).
 * - Health inputs are a latest-only record whose reads have their own 4 h to 24 h lookback, so there is no
 *   history of them to backfill.
 * - Worker limits are the highest of each day; a worker size changed within a day makes the utilisation of
 *   its smaller part read lower (an approximation, rare).
 *
 * @implements FR-COLL-04, FR-COLL-06, FR-COLL-07, FR-STORE-06, NFR-DATA-03, NFR-OBS-06
 */
import { SourceError, type BackfillProgress, type MetricQuery, type MetricSeries } from '@dcam/ports';
import { DAY_MS, ProgressRate, backfillDays } from '../backfill';
import { BudgetExhaustedError, type BackfillReport, type Collector } from '../types';
import { MON_INGESTION_DELAY_MS, MON_TRAILING_MS } from './mon-core';
import {
  discoverWorkerType,
  environmentBase,
  floorMinute,
  readWorkerLimits,
  readWorkerSamples,
  workloadBase,
} from './worker-samples';

const ID = 'mon.backfill';
/** Discovery, two limits and six series. */
const MAX_REQUESTS = 9;
/** Limits are read at an hourly alignment: 24 points a day. */
const LIMITS_ALIGNMENT_S = 3_600;

interface Chunk {
  readonly from: number;
  readonly to: number;
  /** Series read for this day so far, by query. */
  readonly series: Map<string, readonly MetricSeries[]>;
}

interface EnvState {
  workerType: string | null;
  chunk: Chunk | null;
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

export function monBackfillCollector(): Collector {
  const states = new Map<string, EnvState>();
  return {
    manifest: {
      id: ID,
      source: 'SRC-MON',
      api: 'monitoring',
      cadence: 'monitoring',
      priority: 'background',
      maxRequestsPerCycle: MAX_REQUESTS,
      outputs: ['samples'],
      sourceKinds: ['composer'],
      backfill: 'metrics',
    },
    async collect(ctx) {
      const source = ctx.env.source;
      const monitoring = ctx.monitoring;
      if (source.kind !== 'composer' || !monitoring)
        throw new SourceError(
          'unsupported',
          'mon.backfill reads Cloud Monitoring for Composer environments only.',
        );
      const envId = ctx.env.id;
      const days = backfillDays(ctx.env).metricsDays;
      const now = ctx.now();
      let progress = await ctx.store.backfill(envId, ID);
      if (days === 0) {
        ctx.reportBackfill(reportOf('disabled', days, progress));
        return { dataAsOf: null };
      }
      if (!progress) {
        const to = floorMinute(now - MON_INGESTION_DELAY_MS);
        progress = {
          to,
          from: to - days * DAY_MS,
          coveredFrom: to,
          itemsRead: 0,
          requestsUsed: 0,
          startedAt: now,
          completedAt: null,
        };
        await ctx.store.commitBackfill(envId, ID, progress, {});
      }
      const from = progress.to - days * DAY_MS;
      if (progress.coveredFrom <= from) {
        if (progress.from !== from || progress.completedAt === null) {
          progress = { ...progress, from, completedAt: progress.completedAt ?? now };
          await ctx.store.commitBackfill(envId, ID, progress, {});
        }
        ctx.reportBackfill(reportOf('complete', days, progress, 0));
        return { dataAsOf: null };
      }

      let state = states.get(envId);
      if (!state) {
        state = { workerType: null, chunk: null, rate: new ProgressRate() };
        states.set(envId, state);
      }
      const chunkTo = progress.coveredFrom;
      const chunkFrom = Math.max(from, chunkTo - DAY_MS);
      if (state.chunk?.from !== chunkFrom || state.chunk.to !== chunkTo)
        state.chunk = { from: chunkFrom, to: chunkTo, series: new Map() };
      const chunk = state.chunk;
      let requests = 0;
      /** Each query of the day once: a cycle cut short keeps what it read. */
      const query = async (q: MetricQuery) => {
        const key = JSON.stringify(q);
        const cached = chunk.series.get(key);
        if (cached) return cached;
        requests++;
        let series: readonly MetricSeries[];
        try {
          series = await monitoring.series(q);
        } catch (e) {
          if (e instanceof BudgetExhaustedError) requests--;
          throw e;
        }
        ctx.countSeries(series.length);
        chunk.series.set(key, series);
        return series;
      };

      const environment = environmentBase(source);
      let next: BackfillProgress = progress;
      try {
        state.workerType ??= await discoverWorkerType(query, environment, chunkTo - MON_TRAILING_MS, chunkTo);
        if (state.workerType === null) {
          // Not kept: the empty answer is cached with the day's series, so drop the day and ask again next cycle.
          state.chunk = null;
          ctx.reducedFidelity(
            'No Celery worker workload metrics were found, so worker history cannot be read yet.',
          );
        } else {
          const workers = workloadBase(environment, state.workerType);
          const limits = await readWorkerLimits(query, workers, chunkFrom, chunkTo, LIMITS_ALIGNMENT_S);
          const samples =
            limits === null
              ? []
              : await readWorkerSamples(
                  query,
                  environment,
                  workers,
                  chunkFrom,
                  chunkTo,
                  limits,
                  await ctx.store.config(envId),
                );
          next = {
            ...progress,
            from,
            coveredFrom: chunkFrom,
            itemsRead: progress.itemsRead + samples.length,
            requestsUsed: progress.requestsUsed + requests,
            completedAt: chunkFrom <= from ? now : null,
          };
          await ctx.store.commitBackfill(envId, ID, next, { samples });
          state.chunk = null;
          requests = 0;
        }
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
      }
      if (requests > 0) {
        // Requests of a day not finished yet: counted now, so the total survives a restart.
        next = { ...next, from, requestsUsed: next.requestsUsed + requests };
        await ctx.store.commitBackfill(envId, ID, next, {});
      }
      const complete = next.coveredFrom <= from;
      state.rate.record(now, next.to - next.coveredFrom);
      ctx.reportBackfill(
        reportOf(
          complete ? 'complete' : 'running',
          days,
          next,
          complete ? 0 : state.rate.eta(now, next.coveredFrom - from),
        ),
      );
      return { dataAsOf: null };
    },
  };
}
