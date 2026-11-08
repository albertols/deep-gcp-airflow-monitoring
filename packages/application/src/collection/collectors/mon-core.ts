/**
 * `mon.core` (standard, Composer only): Cloud Monitoring `timeSeries.list` → one {@link WorkerSample}
 * per minute, and the Monitoring inputs of the HM-028 health checks.
 *
 * Metrics, kinds, labels and delays are from spec Appendix A (L4890–5077) and the Google Cloud metrics
 * list (https://docs.cloud.google.com/monitoring/api/metrics_gcp_c, Composer section, checked
 * 2026-11-05):
 *
 * | Input | Metric (`composer.googleapis.com/…`) | Kind | Aligner, reducer |
 * |---|---|---|---|
 * | workers | `environment/num_celery_workers` | GAUGE INT64, 60 s | MAX, MAX |
 * | target | `environment/worker/scale_factor_target` (label `queue_name`) | GAUGE DOUBLE, 30 s | MAX, MAX |
 * | running, queued | `environment/executor/running_tasks`, `queued_tasks` (label `executor`) | GAUGE INT64 | MAX, SUM |
 * | CPU | `workload/cpu/usage_time` ÷ `workload/cpu/reserved_cores` | DELTA DOUBLE s; GAUGE | RATE, MAX; MAX, MAX |
 * | memory | `workload/memory/bytes_used` ÷ `workload/memory/quota` | GAUGE INT64 By | MAX, MAX |
 *
 * - Fewest series (NFR-OBS-06, billed per series returned): every query reduces across series, so each
 *   returns one series. Worker CPU and memory are the highest of any worker: workers of one
 *   environment share one size (`workloadsConfig.worker`), so max(usage) ÷ max(limit) is the highest
 *   utilisation. Limits change rarely and are read hourly. Every series returned is counted.
 * - Worker workloads: the `type` label of `cloud_composer_workload` has no documented values (the
 *   monitored-resource page says only "The type of a workload"; ⚠️ VERIFY), so the first cycle groups
 *   one metric by `resource.labels.type` and picks the Celery worker type; later cycles filter on it.
 * - Windows (FR-COLL-07): they end at now minus the ingestion delay (120 s; database metrics 180 s),
 *   on a minute boundary, and each cycle re-reads the trailing 10 minutes (§7.7 L717) so late points
 *   replace earlier ones (`saveWorkerSamples` upserts by minute). The first window covers an hour;
 *   older history is `mon.backfill`'s (FR-COLL-04). Alignment periods are at least 60 s (Monitoring API
 *   rule). The worker type, limits and the per-minute join are shared with it (`worker-samples.ts`).
 * - A minute without one of its inputs is left out rather than filled with zero (NFR-DATA-03). Without
 *   an autoscaler point the target is the current worker count (no scale-up evidence).
 *
 * @implements FR-COLL-01, FR-COLL-06, FR-COLL-07, HM-011, HM-012, HM-028, NFR-OBS-06
 */
import { quantile, type PlatformHealth, type WorkerSample } from '@dcam/domain';
import { SourceError, type Aligner, type MetricQuery, type Reducer } from '@dcam/ports';
import { BudgetExhaustedError, type Collector } from '../types';
import {
  discoverWorkerType,
  environmentBase,
  floorMinute,
  maxOf,
  metricQuery,
  readWorkerLimits,
  readWorkerSamples,
  values,
  workloadBase,
  type MetricBase,
  type WorkerLimits,
} from './worker-samples';

export { targetWorkers, workerTypeOf } from './worker-samples';

const MIN = 60_000;
/** "Data is not visible for up to 120 seconds" for most Composer metrics (Appendix A.1). */
export const MON_INGESTION_DELAY_MS = 120_000;
/** Database CPU, memory, disk and network metrics: up to 180 s (Appendix A.6). */
export const MON_DB_INGESTION_DELAY_MS = 180_000;
export const MON_TRAILING_MS = 10 * MIN;
const FIRST_WINDOW_MS = 60 * MIN;
const HEALTH_EVERY_MS = 5 * MIN;
const LIMITS_EVERY_MS = 60 * MIN;
/** Discovery, six sample queries, two limits and seven health queries. */
const MAX_REQUESTS = 16;

interface EnvState {
  lastEnd?: number;
  workerType?: string;
  limits?: WorkerLimits & { readonly at: number };
  healthAt?: number;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const mean = (xs: readonly number[]) =>
  xs.length ? round6(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
const sumOf = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);

export function monCoreCollector(): Collector {
  const states = new Map<string, EnvState>();
  return {
    manifest: {
      id: 'mon.core',
      source: 'SRC-MON',
      api: 'monitoring',
      cadence: 'monitoring',
      priority: 'standard',
      maxRequestsPerCycle: MAX_REQUESTS,
      outputs: ['samples', 'health'],
      sourceKinds: ['composer'],
    },
    async collect(ctx) {
      const source = ctx.env.source;
      const monitoring = ctx.monitoring;
      if (source.kind !== 'composer' || !monitoring)
        throw new SourceError(
          'unsupported',
          'mon.core reads Cloud Monitoring for Composer environments only.',
        );
      const envId = ctx.env.id;
      const state = states.get(envId) ?? {};
      states.set(envId, state);
      const now = ctx.now();
      const end = floorMinute(now - MON_INGESTION_DELAY_MS);

      const query = async (q: MetricQuery) => {
        const series = await monitoring.series(q);
        ctx.countSeries(series.length);
        return series;
      };
      const environment = environmentBase(source);
      const metric = (
        base: MetricBase,
        name: string,
        from: number,
        to: number,
        aligner: Aligner,
        reducer: Reducer,
        alignmentPeriodSeconds = 60,
      ): MetricQuery => metricQuery(base, name, from, to, aligner, reducer, alignmentPeriodSeconds);

      let dataAsOf: number | null = null;
      try {
        const samples = await readSamples();
        if (samples.length > 0) {
          await ctx.store.saveWorkerSamples(envId, samples);
          dataAsOf = Math.max(...samples.map((s) => s.at));
        }
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
        ctx.reducedFidelity(
          'The Cloud Monitoring request budget is used up; worker samples are read next cycle.',
        );
      }
      if (state.healthAt === undefined || now - state.healthAt >= HEALTH_EVERY_MS) {
        try {
          // A patch: the import errors come from the Airflow API concurrently (HM-028).
          await ctx.store.patchPlatformHealth(envId, await readHealth());
          state.healthAt = now;
        } catch (e) {
          if (!(e instanceof BudgetExhaustedError)) throw e;
          ctx.reducedFidelity(
            'The Cloud Monitoring request budget is used up; health inputs are read next cycle.',
          );
        }
      }
      return { dataAsOf };

      async function workload(): Promise<MetricBase | null> {
        if (state.workerType === undefined) {
          const type = await discoverWorkerType(query, environment, end - MON_TRAILING_MS, end);
          if (type === null) {
            ctx.reducedFidelity(
              'No Celery worker workload metrics were found, so worker CPU and memory are unknown.',
            );
            return null;
          }
          state.workerType = type;
        }
        return workloadBase(environment, state.workerType);
      }

      async function readSamples(): Promise<WorkerSample[]> {
        const from =
          state.lastEnd === undefined
            ? end - FIRST_WINDOW_MS
            : Math.min(state.lastEnd, end) - MON_TRAILING_MS;
        if (end <= from) return [];
        const workers = await workload();
        if (!workers) return [];
        if (!state.limits || now - state.limits.at >= LIMITS_EVERY_MS) {
          const limits = await readWorkerLimits(query, workers, end - MON_TRAILING_MS, end);
          if (limits === null) {
            ctx.reducedFidelity('Worker CPU and memory limits are not reported yet, so worker samples wait.');
            return [];
          }
          state.limits = { ...limits, at: now };
        }
        const limits = state.limits;
        const config = await ctx.store.config(envId);
        const samples = await readWorkerSamples(query, environment, workers, from, end, limits, config);
        state.lastEnd = end;
        return samples;
      }

      async function readHealth(): Promise<Partial<PlatformHealth>> {
        const dbEnd = floorMinute(now - MON_DB_INGESTION_DELAY_MS);
        const fourHours = end - 4 * 60 * MIN;
        const ratio = async (name: string) =>
          mean(
            values(
              await query(
                metric(environment, name, fourHours, end, 'ALIGN_FRACTION_TRUE', 'REDUCE_MEAN', 300),
              ),
            ),
          );
        const envHealthyRatio = await ratio('environment/healthy');
        const dbHealthyRatio = await ratio('environment/database_health');
        const webServerHealthyRatio = await ratio('environment/web_server/health');
        const dbMax = async (name: string) =>
          maxOf(
            values(
              await query(
                metric(environment, name, dbEnd - 12 * 60 * MIN, dbEnd, 'ALIGN_MAX', 'REDUCE_MAX', 3600),
              ),
            ),
          );
        // Composer documents the database metrics as "CPU utilization ratio (from 0.0 to 1.0)", unit 1
        // (https://cloud.google.com/monitoring/api/metrics_gcp_c, composer.googleapis.com, read 2026-11-07).
        const dbCpu = await dbMax('environment/database/cpu/utilization');
        const dbMemory = await dbMax('environment/database/memory/utilization');
        const zombies = sumOf(
          values(
            await query(
              metric(
                environment,
                'environment/zombie_task_killed_count',
                end - 24 * 60 * MIN,
                end,
                'ALIGN_SUM',
                'REDUCE_SUM',
                3600,
              ),
            ),
          ),
        );
        const parse = values(
          await query(
            metric(
              environment,
              'environment/dag_processing/total_parse_time',
              end - 60 * MIN,
              end,
              'ALIGN_MAX',
              'REDUCE_MAX',
            ),
          ),
        );
        const both = [dbCpu, dbMemory].filter((x): x is number => x !== null);
        return {
          envHealthyRatio,
          dbHealthyRatio,
          webServerHealthyRatio,
          dbCpuMemoryMax: maxOf(both),
          zombies24h: zombies,
          parseLoopP95Seconds: quantile(parse, 0.95).value,
        };
      }
    },
  };
}
