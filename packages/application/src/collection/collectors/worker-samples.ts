/**
 * Worker samples from Cloud Monitoring, shared by `mon.core` (live) and `mon.backfill` (history,
 * FR-COLL-04): the Celery worker workload, worker limits, and the six series joined into one
 * {@link WorkerSample} per minute. Metrics, kinds and labels: spec Appendix A and the Google Cloud metrics
 * list (https://docs.cloud.google.com/monitoring/api/metrics_gcp_c, Composer section, checked 2026-11-05);
 * see `mon-core.ts` for the table.
 *
 * - Every query reduces across series, so each returns one series (NFR-OBS-06 bills per series returned).
 * - A minute without one of its inputs is left out rather than filled with zero (NFR-DATA-03). Without an
 *   autoscaler point the target is the current worker count (no scale-up evidence).
 * - Samples are the minutes in `(from, to]`, so adjacent windows neither repeat nor miss a minute.
 *
 * @implements HM-011, HM-012, NFR-DATA-03, NFR-OBS-06
 */
import type { EnvironmentConfig, WorkerSample } from '@dcam/domain';
import type { Aligner, EnvironmentSource, MetricQuery, MetricSeries, Reducer } from '@dcam/ports';

export const METRIC_PREFIX = 'composer.googleapis.com/';
const MIN = 60_000;

export type MetricBase = Pick<MetricQuery, 'projectId' | 'resourceType' | 'resourceLabels'>;
/** Runs one `timeSeries.list` query (budgeted, series counted by the caller). */
export type SeriesQuery = (q: MetricQuery) => Promise<readonly MetricSeries[]>;

export interface WorkerLimits {
  readonly cores: number;
  readonly memoryBytes: number;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const floorMinute = (ms: number) => Math.floor(ms / MIN) * MIN;
export const values = (series: readonly MetricSeries[]) =>
  series.flatMap((s) => s.points.map((p) => p.value));
export const maxOf = (xs: readonly number[]) => (xs.length ? Math.max(...xs) : null);

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

/** The environment's monitored resource. */
export function environmentBase(source: Extract<EnvironmentSource, { kind: 'composer' }>): MetricBase {
  return {
    projectId: source.projectId,
    resourceType: 'cloud_composer_environment',
    resourceLabels: { location: source.location, environment_name: source.environment },
  };
}

/** The environment's workloads, of one `type` when given. */
export function workloadBase(environment: MetricBase, type?: string): MetricBase {
  return {
    ...environment,
    resourceType: 'cloud_composer_workload',
    resourceLabels: type === undefined ? environment.resourceLabels : { ...environment.resourceLabels, type },
  };
}

export function metricQuery(
  base: MetricBase,
  name: string,
  from: number,
  to: number,
  aligner: Aligner,
  reducer: Reducer,
  alignmentPeriodSeconds = 60,
): MetricQuery {
  return { ...base, metricType: METRIC_PREFIX + name, from, to, alignmentPeriodSeconds, aligner, reducer };
}

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
 * The `type` label of `cloud_composer_workload` has no documented values (the monitored-resource page says
 * only "The type of a workload"; ⚠️ VERIFY): one metric grouped by it shows which types exist.
 */
export async function discoverWorkerType(
  query: SeriesQuery,
  environment: MetricBase,
  from: number,
  to: number,
): Promise<string | null> {
  const series = await query({
    ...metricQuery(
      workloadBase(environment),
      'workload/memory/bytes_used',
      from,
      to,
      'ALIGN_MAX',
      'REDUCE_MAX',
    ),
    groupBy: ['resource.labels.type'],
  });
  return workerTypeOf(series.map((s) => s.resourceLabels.type ?? '').filter((t) => t !== ''));
}

/** The highest worker CPU and memory limits in `[from, to]`; `null` when either is not reported. */
export async function readWorkerLimits(
  query: SeriesQuery,
  workers: MetricBase,
  from: number,
  to: number,
  alignmentPeriodSeconds = 60,
): Promise<WorkerLimits | null> {
  const max = async (name: string) =>
    maxOf(
      values(
        await query(metricQuery(workers, name, from, to, 'ALIGN_MAX', 'REDUCE_MAX', alignmentPeriodSeconds)),
      ),
    );
  const cores = await max('workload/cpu/reserved_cores');
  const memoryBytes = await max('workload/memory/quota');
  if (cores === null || memoryBytes === null || cores <= 0 || memoryBytes <= 0) return null;
  return { cores, memoryBytes };
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

/** One sample per minute in `(from, to]` from the six series, at a 60 s alignment. */
export async function readWorkerSamples(
  query: SeriesQuery,
  environment: MetricBase,
  workers: MetricBase,
  from: number,
  to: number,
  limits: WorkerLimits,
  config: EnvironmentConfig | null,
): Promise<WorkerSample[]> {
  const max = Math.max;
  const sum = (a: number, b: number) => a + b;
  const series = async (base: MetricBase, name: string, aligner: Aligner, reducer: Reducer) =>
    query(metricQuery(base, name, from, to, aligner, reducer));
  const count = byMinute(
    await series(environment, 'environment/num_celery_workers', 'ALIGN_MAX', 'REDUCE_MAX'),
    max,
  );
  const factor = byMinute(
    await series(environment, 'environment/worker/scale_factor_target', 'ALIGN_MAX', 'REDUCE_MAX'),
    max,
  );
  const running = byMinute(
    await series(environment, 'environment/executor/running_tasks', 'ALIGN_MAX', 'REDUCE_SUM'),
    sum,
  );
  const queued = byMinute(
    await series(environment, 'environment/executor/queued_tasks', 'ALIGN_MAX', 'REDUCE_SUM'),
    sum,
  );
  const cpu = byMinute(await series(workers, 'workload/cpu/usage_time', 'ALIGN_RATE', 'REDUCE_MAX'), max);
  const memory = byMinute(
    await series(workers, 'workload/memory/bytes_used', 'ALIGN_MAX', 'REDUCE_MAX'),
    max,
  );

  const samples: WorkerSample[] = [];
  for (const [at, w] of [...count].sort((a, b) => a[0] - b[0])) {
    const r = running.get(at);
    const q = queued.get(at);
    const c = cpu.get(at);
    const m = memory.get(at);
    if (at <= from || at > to || r === undefined || q === undefined || c === undefined || m === undefined)
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
  return samples;
}
