/**
 * Where an environment's task history starts (NFR-DATA-03): the store's answer when it has one
 * (`TaskInstanceStore.historyStart`), else the earliest of the environment's tries a use case read. Before it,
 * pages show "no history", never zero, and baselines report partial coverage.
 *
 * @implements NFR-DATA-03, HM-009 (actual starts coverage), HM-016 (baseline coverage)
 */
import type { StoredTaskTry, TaskInstanceStore } from '@dcam/ports';

/** The store's history start; `undefined` when the store does not offer one. */
export async function readHistoryStart(
  store: TaskInstanceStore,
  envId: string,
): Promise<number | null | undefined> {
  return store.historyStart ? store.historyStart(envId) : undefined;
}

/** Where the stored task history starts: the earliest try's start (or queued time); `null` without one. */
export function earliestTry(tries: readonly StoredTaskTry[]): number | null {
  let earliest = Infinity;
  for (const t of tries) {
    const at = t.startAt ?? t.queuedAt;
    if (at !== null && at < earliest) earliest = at;
  }
  return Number.isFinite(earliest) ? earliest : null;
}

/**
 * The history start: the store's (from {@link readHistoryStart}), else the earliest of `environmentTries`,
 * which must be tries of every DAG of the environment, not of one DAG only.
 */
export function historyStartOf(
  stored: number | null | undefined,
  environmentTries: readonly StoredTaskTry[],
): number | null {
  return stored !== undefined ? stored : earliestTry(environmentTries);
}
