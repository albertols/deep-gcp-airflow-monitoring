/**
 * Use case: why is work waiting (S-16). Classifies live snapshots by HM-006, aggregates waiting over
 * time, and adds pool pressure, worker capacity (HM-011, HM-012) and sensor waste (HM-008).
 *
 * @implements FR-BOTL-01, FR-BOTL-02, FR-BOTL-07, FR-BOTL-09, HM-006, HM-008, HM-011, HM-012
 */
import type { Bottlenecks, Range, SourceId } from '@dcam/contracts';
import {
  REASON_PHASE,
  UNEVALUATED_REASONS,
  WAIT_REASONS,
  attributeWaiting,
  capacityStats,
  limitKnown,
  quantile,
  type WaitReasonId,
} from '@dcam/domain';
import type { Clock, EnvironmentModelSource, TaskInstanceStore } from '@dcam/ports';
import { RANGE_MS } from './range';

/**
 * The `af.live` cadence of the standard profile (spec §7.7, §17.2), assumed only while fewer than two
 * snapshots show the real one. Otherwise each snapshot stands for the real gap to the next, capped at
 * two cadences (domain `snapshot-time.ts`): the live profile collects every 10 s, eco every 120 s.
 */
export const DEFAULT_SNAPSHOT_CADENCE_MS = 30_000;
const BUCKET_MS: Record<Range, number> = { '1h': 60_000, '6h': 300_000, '24h': 900_000 };
const PLATFORM_REASONS = WAIT_REASONS.filter((r) => r !== 'normal-latency');

export interface BottleneckDeps {
  readonly store: TaskInstanceStore;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
}

export interface BottleneckQuery {
  readonly envId: string;
  readonly range: Range;
  readonly sources: readonly SourceId[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const seconds = (ms: number | undefined) => (ms ?? 0) / 1000;

export async function getBottlenecks(deps: BottleneckDeps, q: BottleneckQuery): Promise<Bottlenecks> {
  const now = deps.clock.now();
  const from = now - RANGE_MS[q.range];
  const config = await deps.model.config(q.envId);
  if (!config) throw new Error(`No configuration collected for environment "${q.envId}".`);
  const [dags, snapshots, samples, tries] = await Promise.all([
    deps.model.dags(q.envId),
    deps.model.snapshots(q.envId, from, now),
    deps.model.workerSamples(q.envId, from, now),
    deps.store.taskTries(q.envId, from, now),
  ]);

  const a = attributeWaiting(
    snapshots,
    { config, dagMaxActiveTasks: new Map(dags.map((d) => [d.dagId, d.maxActiveTasks])) },
    { from, to: now, bucketMs: BUCKET_MS[q.range], fallbackCadenceMs: DEFAULT_SNAPSHOT_CADENCE_MS },
  );
  const waitingMs = PLATFORM_REASONS.reduce((s, r) => s + (a.totals.get(r) ?? 0), 0);
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
  const top = PLATFORM_REASONS.reduce<WaitReasonId | null>(
    (best, r) => ((a.totals.get(r) ?? 0) > (best ? (a.totals.get(best) ?? 0) : 0) ? r : best),
    null,
  );

  const latest = a.latest;
  let binding: WaitReasonId | null = null;
  if (latest) {
    const counts = new Map<WaitReasonId, number>();
    for (const c of latest.classified)
      if (c.reason !== 'normal-latency') counts.set(c.reason, (counts.get(c.reason) ?? 0) + 1);
    binding = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  }

  const capacity = capacityStats(samples, config);
  const sensors = new Map<string, { dag_id: string; task_id: string; slot_seconds: number }>();
  for (const t of tries) {
    if (!t.operator?.endsWith('Sensor') || t.startAt === null) continue;
    const held = (Math.min(t.endAt ?? now, now) - Math.max(t.startAt, from)) / 1000;
    if (held <= 0) continue;
    const key = `${t.dagId}\u0000${t.taskId}`;
    const s = sensors.get(key) ?? { dag_id: t.dagId, task_id: t.taskId, slot_seconds: 0 };
    s.slot_seconds += held;
    sensors.set(key, s);
  }

  return {
    env_id: q.envId,
    range: { from: iso(from), to: iso(now) },
    data_as_of: iso(latest?.snapshot.at ?? now),
    sources: [...q.sources],
    bucket_seconds: BUCKET_MS[q.range] / 1000,
    snapshot_interval_seconds: a.cadenceMs === null ? null : Math.max(1, Math.round(a.cadenceMs / 1000)),
    waiting_task_seconds: seconds(waitingMs),
    normal_latency_task_seconds: seconds(a.totals.get('normal-latency')),
    answer: {
      reason: top,
      share: top ? share(a.totals.get(top) ?? 0, waitingMs) : 0,
      workers_at_max_share: top ? share(a.atMaxWorkersMs.get(top) ?? 0, a.totals.get(top) ?? 0) : 0,
    },
    reasons: PLATFORM_REASONS.map((id) => {
      const total = a.totals.get(id) ?? 0;
      return {
        id,
        phase: REASON_PHASE[id],
        waiting_task_seconds: seconds(total),
        share: share(total, waitingMs),
        evaluated: !UNEVALUATED_REASONS.has(id),
        top_contributors: [...(a.byReasonDag.get(id) ?? new Map<string, number>())]
          .slice(0, 10)
          .map(([dag_id, ms]) => ({ dag_id, waiting_task_seconds: seconds(ms), share: share(ms, total) })),
      };
    }),
    series: a.buckets.map((b) => ({
      start: iso(b.start),
      waiting_task_seconds: Object.fromEntries(
        PLATFORM_REASONS.filter((r) => (b.byReason.get(r) ?? 0) > 0).map((r) => [
          r,
          seconds(b.byReason.get(r)),
        ]),
      ),
      workers: b.workers,
      worker_slots_used: b.slotsUsed,
    })),
    current: {
      at: latest ? iso(latest.snapshot.at) : null,
      binding,
      scheduled: latest?.snapshot.scheduled.length ?? 0,
      queued: latest?.snapshot.queued.length ?? 0,
      running: latest?.snapshot.executor.running ?? 0,
      workers: {
        current: latest?.snapshot.workers.current ?? 0,
        target: latest?.snapshot.workers.target ?? 0,
        min: config.minWorkers,
        max: config.maxWorkers,
      },
      // A worker_concurrency DCAM does not know is null, never the placeholder (HM-032).
      worker_slots: limitKnown(config, 'workerConcurrency')
        ? (latest?.snapshot.workers.current ?? 0) * config.workerConcurrency
        : null,
    },
    pools: config.pools.map((p) => {
      const pressure = a.pools.get(p.name);
      return {
        name: p.name,
        slots: p.slots,
        waiting_task_seconds: seconds(pressure?.waitingMs),
        starved_minutes: (pressure?.starvedMs ?? 0) / 60_000,
        utilisation_p95: quantile(pressure?.utilisation ?? [], 0.95).value,
      };
    }),
    capacity: {
      capacity_bound_minutes: capacity.capacityBoundMinutes,
      minutes_at_max_workers: capacity.minutesAtMax,
      scale_up_lag_p95_seconds: quantile(capacity.scaleUpLagsSeconds, 0.95).value,
      utilisation_p95: capacity.utilisation.value,
      worker_samples: samples.length,
    },
    sensors: [...sensors.values()].sort((x, y) => y.slot_seconds - x.slot_seconds).slice(0, 20),
  };
}
