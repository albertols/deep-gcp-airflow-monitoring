/**
 * In-memory {@link EnvironmentModelSource} over simulation results (demo mode, FR-EMU-01).
 */
import type { DagMeta, EnvironmentConfig, LiveSnapshot, PlatformHealth, WorkerSample } from '@dcam/domain';
import type { EnvironmentModelSource } from '@dcam/ports';
import type { SimulationResult } from './simulator';

const NO_DATA: PlatformHealth = {
  envHealthyRatio: null,
  dbHealthyRatio: null,
  heartbeatCompleteness: null,
  webServerHealthyRatio: null,
  dbCpuMemoryMax: null,
  zombies24h: null,
  workerRestarts24h: null,
  importErrors: null,
  parseLoopP95Seconds: null,
};

/** Items with `from <= at < to` from an array sorted by `at`. */
function between<T extends { readonly at: number }>(items: readonly T[], from: number, to: number): T[] {
  const lower = (x: number) => {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((items[mid] as T).at < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return items.slice(lower(from), lower(to));
}

export class InMemoryEnvironmentModel implements EnvironmentModelSource {
  readonly #byEnv: ReadonlyMap<string, SimulationResult>;

  constructor(results: readonly SimulationResult[]) {
    this.#byEnv = new Map(results.map((r) => [r.config.envId, r]));
  }

  async config(envId: string): Promise<EnvironmentConfig | null> {
    return this.#byEnv.get(envId)?.config ?? null;
  }

  async dags(envId: string): Promise<DagMeta[]> {
    return [...(this.#byEnv.get(envId)?.dags ?? [])];
  }

  async snapshots(envId: string, from: number, to: number): Promise<LiveSnapshot[]> {
    return between(this.#byEnv.get(envId)?.snapshots ?? [], from, to);
  }

  async workerSamples(envId: string, from: number, to: number): Promise<WorkerSample[]> {
    return between(this.#byEnv.get(envId)?.workerSamples ?? [], from, to);
  }

  async platformHealth(envId: string): Promise<PlatformHealth> {
    return this.#byEnv.get(envId)?.platformHealth ?? NO_DATA;
  }
}
