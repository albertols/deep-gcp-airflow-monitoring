import type { DagTaskTry } from '../src/index';

export const T0 = Date.UTC(2026, 10, 5, 0, 0, 0);
export const M = 60_000;
export const H = 60 * M;

/** A task instance try with sensible defaults; times are minutes after {@link T0}. */
export function tryAt(
  p: Partial<Omit<DagTaskTry, 'startAt' | 'endAt' | 'queuedAt' | 'readyAt'>> & {
    readonly start: number | null;
    readonly end?: number | null;
    readonly queued?: number | null;
    readonly ready?: number | null;
  },
): DagTaskTry {
  const at = (m: number | null | undefined) => (m === null || m === undefined ? null : T0 + m * M);
  const end = p.end === undefined ? (p.start === null ? null : p.start + 1) : p.end;
  return {
    dagId: p.dagId ?? 'dag_a',
    taskId: p.taskId ?? 'task_1',
    runId: p.runId ?? 'scheduled__2026-11-05T00:00:00+00:00',
    mapIndex: p.mapIndex ?? -1,
    tryNumber: p.tryNumber ?? 1,
    pool: p.pool ?? 'default_pool',
    poolSlots: p.poolSlots ?? 1,
    state: p.state === undefined ? (end === null ? 'running' : 'success') : p.state,
    readyAt: at(p.ready),
    queuedAt: p.queued === undefined ? at(p.start) : at(p.queued),
    startAt: at(p.start),
    endAt: at(end),
  };
}

/** Minutes after {@link T0} as a sweep window. */
export const windowOf = (from: number, to: number, now = to) => ({
  from: T0 + from * M,
  to: T0 + to * M,
  now: T0 + now * M,
});
