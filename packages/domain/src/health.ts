/**
 * HM-028 explainable environment health score (spec L1370–1391): 100 minus the weights of failing
 * checks, capped at 40 when a critical check fails. Checks without data are "unknown": excluded from
 * the score and shown as coverage. Thresholds are the spec's defaults (marked ⚠️ VERIFY there).
 *
 * @implements HM-028, FR-FLEET-02
 */
import type { PlatformHealth } from './model';

export type CheckState = 'pass' | 'fail' | 'unknown';
export type HealthLabel = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface HealthCheckResult {
  readonly id: string;
  readonly label: string;
  readonly state: CheckState;
  readonly critical: boolean;
  readonly weight: number;
  readonly threshold: string;
  readonly value: string | null;
}

export interface HealthScore {
  readonly score: number | null;
  readonly label: HealthLabel;
  readonly evaluated: number;
  readonly total: number;
  readonly checks: readonly HealthCheckResult[];
}

/** Cap applied when any critical check fails. */
export const CRITICAL_CAP = 40;

const pct = (x: number) => `${Math.round(x * 100)}%`;

interface CheckDef {
  readonly id: string;
  readonly label: string;
  readonly critical: boolean;
  readonly weight: number;
  readonly threshold: string;
  readonly value: (h: PlatformHealth) => number | null;
  readonly passes: (v: number) => boolean;
  readonly show: (v: number) => string;
}

const CHECKS: readonly CheckDef[] = [
  {
    id: 'env-healthy',
    label: 'Environment healthy',
    critical: true,
    weight: 25,
    threshold: '≥ 90 % of the last 4 h',
    value: (h) => h.envHealthyRatio,
    passes: (v) => v >= 0.9,
    show: pct,
  },
  {
    id: 'db-healthy',
    label: 'Database healthy',
    critical: true,
    weight: 20,
    threshold: '≥ 95 % of the last 4 h',
    value: (h) => h.dbHealthyRatio,
    passes: (v) => v >= 0.95,
    show: pct,
  },
  {
    id: 'heartbeat',
    label: 'Scheduler heartbeat complete',
    critical: true,
    weight: 20,
    threshold: '≥ 90 % of the last 4 h',
    value: (h) => h.heartbeatCompleteness,
    passes: (v) => v >= 0.9,
    show: pct,
  },
  {
    id: 'web-server',
    label: 'Web server healthy',
    critical: false,
    weight: 5,
    threshold: '≥ 95 % of the last 4 h',
    value: (h) => h.webServerHealthyRatio,
    passes: (v) => v >= 0.95,
    show: pct,
  },
  {
    id: 'db-cpu-memory',
    label: 'Database CPU and memory',
    critical: false,
    weight: 10,
    threshold: '< 80 % over the last 12 h',
    value: (h) => h.dbCpuMemoryMax,
    passes: (v) => v < 0.8,
    show: pct,
  },
  {
    id: 'zombies',
    label: 'Zombie tasks',
    critical: false,
    weight: 5,
    threshold: '≤ 1 in 24 h',
    value: (h) => h.zombies24h,
    passes: (v) => v <= 1,
    show: String,
  },
  {
    id: 'worker-restarts',
    label: 'Worker restarts',
    critical: false,
    weight: 5,
    threshold: '≤ 1 in 24 h',
    value: (h) => h.workerRestarts24h,
    passes: (v) => v <= 1,
    show: String,
  },
  {
    id: 'import-errors',
    label: 'DAG import errors',
    critical: false,
    weight: 5,
    threshold: '0 for 15 min',
    value: (h) => h.importErrors,
    passes: (v) => v === 0,
    show: String,
  },
  {
    id: 'parse-loop',
    label: 'DAG parse loop p95',
    critical: false,
    weight: 5,
    threshold: '< 5 min',
    value: (h) => h.parseLoopP95Seconds,
    passes: (v) => v < 300,
    show: (v) => `${Math.round(v)} s`,
  },
];

/** Label bands (a feature-001 call; the spec leaves them open): ≥ 80 healthy, 50–79 degraded. */
export function healthLabel(score: number | null): HealthLabel {
  if (score === null) return 'unknown';
  return score >= 80 ? 'healthy' : score >= 50 ? 'degraded' : 'unhealthy';
}

export function healthScore(h: PlatformHealth): HealthScore {
  const checks = CHECKS.map((c): HealthCheckResult => {
    const v = c.value(h);
    const base = { id: c.id, label: c.label, critical: c.critical, weight: c.weight, threshold: c.threshold };
    if (v === null || !Number.isFinite(v)) return { ...base, state: 'unknown', value: null };
    return { ...base, state: c.passes(v) ? 'pass' : 'fail', value: c.show(v) };
  });
  const evaluated = checks.filter((c) => c.state !== 'unknown');
  if (evaluated.length === 0)
    return { score: null, label: 'unknown', evaluated: 0, total: checks.length, checks };
  const failing = evaluated.filter((c) => c.state === 'fail');
  let score = 100 - failing.reduce((s, c) => s + c.weight, 0);
  if (failing.some((c) => c.critical)) score = Math.min(score, CRITICAL_CAP);
  return { score, label: healthLabel(score), evaluated: evaluated.length, total: checks.length, checks };
}
