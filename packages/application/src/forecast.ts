/**
 * Use case: the 24-hour load forecast (FR-BOTL-05, HM-010). Reads {@link FORECAST_HISTORY_DAYS} days of task
 * tries, the DAG inventory's schedules and the configuration, runs the domain forecast and maps it to the
 * contract, with the history used and a plain statement of its confidence. Every number is an estimate, labelled
 * with its method (`HM-010/run-profiles`).
 *
 * @implements HM-010, FR-BOTL-05, NFR-DATA-03
 */
import type { Forecast, ForecastCheck, SourceId } from '@dcam/contracts';
import {
  FORECAST_HISTORY_DAYS,
  MIN_FORECAST_HISTORY_DAYS,
  SATURATION_MIN_MINUTES,
  loadForecast,
  type LoadForecast,
  type SaturationCheck,
} from '@dcam/domain';
import type { Clock, EnvironmentModelSource, TaskInstanceStore } from '@dcam/ports';
import { limitSourceOf } from './capacity';
import { historyStartOf, readHistoryStart } from './history';
import { composerConfig, usedSources } from './sources';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const STEP_MINUTES = 5;
const POOL_STEP_MINUTES = 15;
/** The contract's `dags` list. */
const MAX_DAGS = 20;

export interface ForecastDeps {
  readonly store: TaskInstanceStore;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
}

export interface ForecastQuery {
  readonly envId: string;
  readonly sources: readonly SourceId[];
}

const iso = (ms: number) => new Date(ms).toISOString();

const days = (d: number) => {
  if (d < 1) {
    const hours = Math.max(1, Math.round(d * 24));
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const rounded = Math.round(d * 10) / 10;
  return `${rounded} day${rounded === 1 ? '' : 's'}`;
};

/** One plain sentence on how far the forecast can be trusted (spec §12.12: say what it means and what next). */
function confidenceOf(f: LoadForecast): Forecast['confidence'] {
  const dags = f.dags.length;
  const low = f.dags.filter((d) => d.lowConfidence).length;
  const level =
    !f.evaluated ||
    (f.lowConfidenceShare === null ? f.historyDays < MIN_FORECAST_HISTORY_DAYS : f.lowConfidenceShare >= 0.5)
      ? 'low'
      : 'normal';
  const min = MIN_FORECAST_HISTORY_DAYS;
  let summary: string;
  if (!f.evaluated)
    summary =
      'No forecast yet: DCAM has no task history for this environment. It starts after the first collection cycles.';
  else if (level === 'low')
    summary =
      `Low confidence: ${low} of ${dags} DAGs ${low === 1 ? 'has' : 'have'} less than ${min} days of history ` +
      `(DCAM has ${days(f.historyDays)}), so the forecast rests on few runs. It firms up as history builds.`;
  else if (low > 0)
    summary =
      `${low} of ${dags} DAGs ${low === 1 ? 'has' : 'have'} less than ${min} days of history; ` +
      `${low === 1 ? 'its' : 'their'} part of the forecast is low confidence.`;
  else summary = `Every DAG in the forecast has at least ${min} days of history.`;
  return {
    level,
    summary,
    dags,
    low_confidence_dags: low,
    dags_without_history: f.dagsWithoutHistory,
    low_confidence_share: f.lowConfidenceShare,
  };
}

const checkOf = (c: SaturationCheck, band: ForecastCheck['band']): ForecastCheck => ({
  evaluated: c.evaluated,
  not_evaluated_reason: c.reason,
  band,
  min_minutes: SATURATION_MIN_MINUTES,
  windows: c.windows.map((w) => ({
    start: iso(w.start),
    end: iso(w.end),
    minutes: w.minutes,
    peak_slots: w.peak,
    capacity_slots: w.capacity,
    low_confidence: w.lowConfidence,
    top_dags: w.topDags.map((d) => ({
      dag_id: d.dagId,
      slot_minutes: d.slotMinutes,
      share: d.share,
      low_confidence: d.lowConfidence,
    })),
  })),
});

export async function getForecast(deps: ForecastDeps, q: ForecastQuery): Promise<Forecast> {
  const now = deps.clock.now();
  const readFrom = now - FORECAST_HISTORY_DAYS * DAY;
  const config = await deps.model.config(q.envId);
  if (!config) throw new Error(`No configuration collected for environment "${q.envId}".`);
  const [dags, tries, storedHistory] = await Promise.all([
    deps.model.dags(q.envId),
    deps.store.taskTries(q.envId, readFrom, now),
    readHistoryStart(deps.store, q.envId),
  ]);
  const f = loadForecast({
    config,
    dags,
    tries,
    now,
    historyReadFrom: readFrom,
    historyFrom: historyStartOf(storedHistory, tries),
    stepMinutes: STEP_MINUTES,
  });
  // The newest instant the history knows of: a finished try's end, a running try's start.
  let latest: number | null = null;
  for (const t of tries) {
    const at = t.endAt ?? t.startAt;
    if (at !== null && (latest === null || at > latest)) latest = Math.min(now, at);
  }

  return {
    env_id: q.envId,
    horizon: { from: iso(f.from), to: iso(f.to) },
    data_as_of: latest === null ? null : iso(latest),
    // Schedules and history come from the Airflow REST API; max_count and worker_concurrency from Composer.
    sources: usedSources(q.sources, {
      airflow: tries.length > 0 || dags.length > 0,
      monitoring: false,
      composer: composerConfig(config),
    }),
    method: 'HM-010/run-profiles',
    estimate: true,
    evaluated: f.evaluated,
    not_evaluated_reason: f.reason,
    time_zone: 'UTC',
    step_seconds: f.stepMinutes * 60,
    history: {
      from: f.historyFrom === null ? null : iso(f.historyFrom),
      to: iso(now),
      days: f.historyDays,
      read_days: FORECAST_HISTORY_DAYS,
      min_days: MIN_FORECAST_HISTORY_DAYS,
      runs_profiled: f.runsProfiled,
    },
    confidence: confidenceOf(f),
    capacity: {
      worker_slots_at_max: f.capacity.workerSlotsAtMax,
      worker_concurrency_source: limitSourceOf(config, 'workerConcurrency'),
      max_workers: config.maxWorkers,
      parallelism_total: f.capacity.parallelism,
    },
    series: f.series.map((s) => ({
      start: iso(s.start),
      p10: s.p10,
      p50: s.p50,
      p90: s.p90,
      baseline: s.baseline,
    })),
    saturation: checkOf(f.saturation, 'p50'),
    risk: checkOf(f.risk, 'p90'),
    planned_runs: f.plannedRuns,
    unscheduled_dags: f.unscheduledDags,
    dag_count: f.dags.length,
    dags: f.dags.slice(0, MAX_DAGS).map((d) => ({
      dag_id: d.dagId,
      schedule: d.schedule,
      planned_runs: d.plannedRuns,
      runs_profiled: d.runsProfiled,
      history_days: d.historyDays,
      low_confidence: d.lowConfidence,
      slot_minutes: d.slotMinutes,
      peak_slots: d.peakP50,
    })),
    baseline: { method: f.baseline.method, slot_minutes: f.baseline.slotMinutes, weeks: f.baseline.weeks },
    pool_step_seconds: POOL_STEP_MINUTES * 60,
    pools: f.pools.map((p) => ({
      name: p.name,
      slots: p.slots,
      peak_slots: p.peakP50,
      peak_at: p.peakAt === null ? null : iso(p.peakAt),
      minutes_over: p.minutesOver,
      series: [...p.series],
    })),
  };
}
