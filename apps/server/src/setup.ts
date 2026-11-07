/**
 * Setup-mode workspace (FR-SETUP-02): the configuration file is missing or invalid, so DCAM starts no
 * collector but keeps the UI available to explain what to fix. It is a live-mode workspace with no
 * environments: every endpoint answers (the fleet and alerts are empty; environment routes are 404s).
 *
 * @implements FR-SETUP-02
 */
import { openStore } from '@dcam/duckdb-store';
import type { Clock, ConfigIssue, EnvironmentModelSource } from '@dcam/ports';
import type { Workspace } from './workspace';

type PlatformHealth = Awaited<ReturnType<EnvironmentModelSource['platformHealth']>>;

const NO_HEALTH: PlatformHealth = {
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

/** An environment model that knows nothing yet: no configuration, DAGs, snapshots or samples. */
export const EMPTY_ENVIRONMENT_MODEL: EnvironmentModelSource = {
  config: async () => null,
  dags: async () => [],
  snapshots: async () => [],
  workerSamples: async () => [],
  platformHealth: async () => NO_HEALTH,
};

export interface SetupWorkspaceOptions {
  /** File that was read; `null` when no configuration file was found. */
  readonly configPath: string | null;
  /** The `--config` path DCAM was started with, absolute, so the page's commands can repeat it. */
  readonly configFlag?: string | null;
  /** Validation problems, each with its path in the file and a fix hint. */
  readonly issues: readonly ConfigIssue[];
  /** Injected clock (tests); the system clock by default. */
  readonly now?: () => number;
}

export async function createSetupWorkspace(options: SetupWorkspaceOptions): Promise<Workspace> {
  const clock: Clock = { now: options.now ?? (() => Date.now()) };
  const store = await openStore({ path: ':memory:', now: () => clock.now() });
  return {
    mode: 'live',
    environments: [],
    store,
    model: EMPTY_ENVIRONMENT_MODEL,
    clock,
    setup: {
      configPath: options.configPath,
      ...(options.configFlag === undefined ? {} : { configFlag: options.configFlag }),
      issues: [...options.issues],
    },
  };
}
