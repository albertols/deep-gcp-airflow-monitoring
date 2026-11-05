/**
 * Use case: every environment at a glance (S-02) with the HM-028 health score.
 *
 * @implements FR-FLEET-01, FR-FLEET-02, HM-028
 */
import type { Bottlenecks, Fleet, FleetCard, FindingRef, Meta, SourceId } from '@dcam/contracts';
import { healthScore, slotSeconds } from '@dcam/domain';
import { getBottlenecks, type BottleneckDeps } from './bottlenecks';
import { RANGE_MS } from './range';

export interface FleetQuery {
  readonly environments: Meta['environments'];
  readonly sources: readonly SourceId[];
  /** Up to three most important findings per environment (the advisor supplies them). */
  readonly topFindings?: (envId: string) => Promise<FindingRef[]>;
  /** Alerts currently firing per environment (the alert evaluator supplies them). */
  readonly alertsFiring?: (envId: string) => Promise<number>;
  /** 24 h bottleneck analysis per environment; lets the caller reuse a cached result. */
  readonly bottlenecks?: (envId: string) => Promise<Bottlenecks>;
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function getFleet(deps: BottleneckDeps, q: FleetQuery): Promise<Fleet> {
  const now = deps.clock.now();
  const from = now - RANGE_MS['24h'];
  const cards = await Promise.all(
    q.environments.map(async (env): Promise<FleetCard> => {
      const [config, health, snapshots, tries, findings, firing] = await Promise.all([
        deps.model.config(env.env_id),
        deps.model.platformHealth(env.env_id),
        deps.model.snapshots(env.env_id, now - 5 * 60_000, now),
        deps.store.taskTries(env.env_id, from, now),
        q.topFindings?.(env.env_id) ?? Promise.resolve([]),
        q.alertsFiring?.(env.env_id) ?? Promise.resolve(0),
      ]);
      const latest = snapshots.at(-1);
      const bottlenecks = config
        ? await (q.bottlenecks?.(env.env_id) ??
            getBottlenecks(deps, { envId: env.env_id, range: '24h', sources: q.sources }))
        : null;
      const score = healthScore(health);
      return {
        env_id: env.env_id,
        display_name: env.display_name,
        tier: env.tier,
        composer_image: config?.composerImage ?? 'unknown',
        airflow_version: config?.airflowVersion ?? 'unknown',
        health: {
          score: score.score,
          label: score.label,
          evaluated: score.evaluated,
          total: score.total,
          checks: score.checks.map((c) => ({ ...c })),
        },
        running: latest?.executor.running ?? 0,
        queued: latest?.executor.queued ?? 0,
        workers: {
          current: latest?.workers.current ?? 0,
          min: config?.minWorkers ?? 0,
          max: config?.maxWorkers ?? 0,
        },
        failures_24h: tries.filter((t) => t.state === 'failed').length,
        slot_seconds_24h: slotSeconds(tries, { from, to: now, now }).totalExecutorSlotSeconds,
        waiting_task_seconds_24h: bottlenecks?.waiting_task_seconds ?? 0,
        top_reason: bottlenecks?.answer.reason ?? null,
        top_findings: findings.slice(0, 3),
        alerts_firing: firing,
        data_as_of: iso(latest?.at ?? now),
      };
    }),
  );
  return { data_as_of: iso(now), sources: [...q.sources], environments: cards };
}
