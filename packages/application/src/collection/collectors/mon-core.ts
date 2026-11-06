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
 *   backfill is FR-COLL-04 (M2). Alignment periods are at least 60 s (Monitoring API rule).
 * - A minute without one of its inputs is left out rather than filled with zero (NFR-DATA-03). Without
 *   an autoscaler point the target is the current worker count (no scale-up evidence).
 *
 * @implements FR-COLL-01, FR-COLL-06, FR-COLL-07, HM-011, HM-012, HM-028, NFR-OBS-06
 */
import { quantile, type EnvironmentConfig, type PlatformHealth, type WorkerSample } from '@dcam/domain';
import { SourceError, type Aligner, type MetricQuery, type MetricSeries, type Reducer } from '@dcam/ports';
import { BudgetExhaustedError, type Collector } from '../types';

const PREFIX = 'composer.googleapis.com/';
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

type Base = Pick<MetricQuery, 'projectId' | 'resourceType' | 'resourceLabels'>;

interface EnvState {
  lastEnd?: number;
  workerType?: string;
  limits?: { readonly cores: number; readonly memoryBytes: number; readonly at: number };
  healthAt?: number;
}

const floorMinute = (ms: number) => Math.floor(ms / MIN) * MIN;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Points by minute; several series (which the reducers should prevent) merge with `merge`. */
function byMinute(
  series: readonly MetricSeries[],
  merge: (a: number, b: number) => number,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of series)
    for (const p of s.points) {
      const at = Math.round(p.at / MIN) * MIN;
      const prev = out.get(at);
      out.set(at, prev === undefined ? p.value : merge(prev, p.value));
    }
  return out;
}
const values = (series: readonly MetricSeries[]) => series.flatMap((s) => s.points.map((p) => p.value));
const mean = (xs: readonly number[]) =>
  xs.length ? round6(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
const maxOf = (xs: readonly number[]) => (xs.length ? Math.max(...xs) : null);
const sumOf = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);

/** The Celery worker type among the `type` label values seen (⚠️ VERIFY the actual values). */
export function workerTypeOf(types: readonly string[]): string | null {
  const lower = (t: string) => t.toLowerCase();
  return (
    types.find((t) => lower(t).includes('celery')) ??
    types.find((t) => lower(t) === 'worker') ??
    types.find((t) => lower(t).includes('worker') && !/kubernetes|k8s/.test(lower(t))) ??
    null
  );
}

/**
 * Target workers from `scale_factor_target`. ⚠️ VERIFY: Google describes it only as "Scale factor for
 * Airflow workers count", calculated from current workers, queued tasks, idle workers and
 * `worker_concurrency`, applied through the Kubernetes Horizontal Pod Autoscaler
 * (https://docs.cloud.google.com/composer/docs/composer-3/environment-scaling). DCAM reads it as a
 * ratio, desired = ceil(current × factor), clamped to `min_count`…`max_count`; the M1 spike confirms it.
 */
export function targetWorkers(
  workers: number,
  factor: number,
  config: Pick<EnvironmentConfig, 'minWorkers' | 'maxWorkers'> | null,
): number {
  const desired = Math.ceil(workers * factor - 1e-9);
  return config ? Math.min(config.maxWorkers, Math.max(config.minWorkers, desired)) : desired;
}

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
      const environment: Base = {
        projectId: source.projectId,
        resourceType: 'cloud_composer_environment',
        resourceLabels: { location: source.location, environment_name: source.environment },
      };
      const metric = (
        base: Base,
        name: string,
        from: number,
        to: number,
        aligner: Aligner,
        reducer: Reducer,
        alignmentPeriodSeconds = 60,
      ): MetricQuery => ({
        ...base,
        metricType: PREFIX + name,
        from,
        to,
        alignmentPeriodSeconds,
        aligner,
        reducer,
      });

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

      async function workload(): Promise<Base | null> {
        const base: Base = { ...environment, resourceType: 'cloud_composer_workload' };
        if (state.workerType === undefined) {
          const series = await query({
            ...metric(
              base,
              'workload/memory/bytes_used',
              end - MON_TRAILING_MS,
              end,
              'ALIGN_MAX',
              'REDUCE_MAX',
            ),
            groupBy: ['resource.labels.type'],
          });
          const type = workerTypeOf(series.map((s) => s.resourceLabels.type ?? '').filter((t) => t !== ''));
          if (type === null) {
            ctx.reducedFidelity(
              'No Celery worker workload metrics were found, so worker CPU and memory are unknown.',
            );
            return null;
          }
          state.workerType = type;
        }
        return { ...base, resourceLabels: { ...base.resourceLabels, type: state.workerType } };
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
          const recent = end - MON_TRAILING_MS;
          const cores = maxOf(
            values(
              await query(
                metric(workers, 'workload/cpu/reserved_cores', recent, end, 'ALIGN_MAX', 'REDUCE_MAX'),
              ),
            ),
          );
          const memory = maxOf(
            values(
              await query(metric(workers, 'workload/memory/quota', recent, end, 'ALIGN_MAX', 'REDUCE_MAX')),
            ),
          );
          if (cores === null || memory === null || cores <= 0 || memory <= 0) {
            ctx.reducedFidelity('Worker CPU and memory limits are not reported yet, so worker samples wait.');
            return [];
          }
          state.limits = { cores, memoryBytes: memory, at: now };
        }
        const max = Math.max;
        const sum = (a: number, b: number) => a + b;
        const count = byMinute(
          await query(
            metric(environment, 'environment/num_celery_workers', from, end, 'ALIGN_MAX', 'REDUCE_MAX'),
          ),
          max,
        );
        const factor = byMinute(
          await query(
            metric(
              environment,
              'environment/worker/scale_factor_target',
              from,
              end,
              'ALIGN_MAX',
              'REDUCE_MAX',
            ),
          ),
          max,
        );
        const running = byMinute(
          await query(
            metric(environment, 'environment/executor/running_tasks', from, end, 'ALIGN_MAX', 'REDUCE_SUM'),
          ),
          sum,
        );
        const queued = byMinute(
          await query(
            metric(environment, 'environment/executor/queued_tasks', from, end, 'ALIGN_MAX', 'REDUCE_SUM'),
          ),
          sum,
        );
        const cpu = byMinute(
          await query(metric(workers, 'workload/cpu/usage_time', from, end, 'ALIGN_RATE', 'REDUCE_MAX')),
          max,
        );
        const memory = byMinute(
          await query(metric(workers, 'workload/memory/bytes_used', from, end, 'ALIGN_MAX', 'REDUCE_MAX')),
          max,
        );

        const config = await ctx.store.config(envId);
        const limits = state.limits;
        if (!limits) return [];
        const samples: WorkerSample[] = [];
        for (const [at, w] of [...count].sort((a, b) => a[0] - b[0])) {
          const r = running.get(at);
          const q = queued.get(at);
          const c = cpu.get(at);
          const m = memory.get(at);
          if (
            at <= from ||
            at > end ||
            r === undefined ||
            q === undefined ||
            c === undefined ||
            m === undefined
          )
            continue;
          const current = Math.round(w);
          const f = factor.get(at);
          samples.push({
            at,
            workers: current,
            target: f === undefined ? current : targetWorkers(current, f, config),
            running: Math.round(r),
            queued: Math.round(q),
            cpu: round6(clamp01(c / limits.cores)),
            memory: round6(clamp01(m / limits.memoryBytes)),
          });
        }
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
        // ⚠️ VERIFY: Composer reports database utilisation as a 0–1 ratio, as Cloud SQL does.
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
