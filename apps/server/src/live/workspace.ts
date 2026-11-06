/**
 * The live workspace: the configured environments, collected read-only by the collection engine into
 * the DuckDB store in the data directory. The store also serves every page, so live and demo pages are
 * the same code. Without a valid configuration DCAM starts in setup mode instead (FR-SETUP-02).
 *
 * @implements FR-SETUP-02, FR-COLL-01, FR-COLL-11, FR-STORE-01, HM-030
 */
import {
  createCollectionEngine,
  createCollectors,
  type CollectionEngine,
  type CollectionLogEntry,
  type Collector,
} from '@dcam/application';
import { loadWorkspaceConfig } from '@dcam/config-file';
import { openFileStore } from '@dcam/duckdb-store';
import { createGcloudTokenSource } from '@dcam/gcp';
import type { Transport } from '@dcam/http-guard';
import type { AccessTokenSource, Clock, ConfigIssue, Sleeper, WorkspaceConfig } from '@dcam/ports';
import { createSetupWorkspace } from '../setup';
import type { Workspace } from '../workspace';
import { createEnvironmentClients, type EnvironmentClients } from './environment-clients';
import { systemSleeper } from './sleeper';

type Env = Readonly<Record<string, string | undefined>>;

/** A workspace that runs: live collection, or setup mode with nothing to collect. */
export interface RunningWorkspace extends Workspace {
  /** Starts the collectors; nothing happens in setup mode. */
  start(): void;
  /** Stops the collectors, waits for running cycles, then closes connections and the store. */
  close(): Promise<void>;
}

/** What tests replace; DCAM itself uses the defaults. */
export interface LiveWorkspaceOverrides {
  readonly now?: () => number;
  /** The ADC token source; `gcloud auth application-default print-access-token` by default (ADR-0016). */
  readonly tokens?: AccessTokenSource;
  readonly sleeper?: Sleeper;
  /** Replaces the proxy- and CA-aware transport of every guarded client. */
  readonly transport?: Transport;
  /** The collectors; every M1 collector by default. */
  readonly collectors?: readonly Collector[];
  readonly log?: (entry: CollectionLogEntry) => void;
}

export interface LiveWorkspaceOptions extends LiveWorkspaceOverrides {
  readonly config: WorkspaceConfig;
  /** The process environment: proxy and CA variables, `DCAM_NETWORK`, emulator credentials. */
  readonly env: Env;
}

function storeError(dataDir: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const hint = /lock/i.test(message)
    ? 'Another DCAM may be running on this data directory: stop it first, or set DCAM_DATA_DIR to another folder.'
    : 'Check that the folder is writable by you, or set DCAM_DATA_DIR to another folder.';
  return new Error(`DCAM could not open its database in ${dataDir}: ${message}\n${hint}`, { cause: error });
}

export async function createLiveWorkspace(options: LiveWorkspaceOptions): Promise<RunningWorkspace> {
  const { config, env } = options;
  const now = options.now ?? Date.now;
  const clock: Clock = { now };
  const store = await openFileStore({ dataDir: config.dataDir, now }).catch((e: unknown) => {
    throw storeError(config.dataDir, e);
  });
  const tokens = options.tokens ?? createGcloudTokenSource({ now });
  const clients = new Map<string, EnvironmentClients>();
  // The guard's footprint hook needs the engine, and the engine needs the clients: bound late.
  let engine: CollectionEngine | undefined;
  try {
    engine = createCollectionEngine({
      config,
      store,
      clock,
      sleeper: options.sleeper ?? systemSleeper,
      collectors: options.collectors ?? createCollectors(),
      ...(options.log === undefined ? {} : { log: options.log }),
      sources: (entry) => {
        let c = clients.get(entry.id);
        if (!c) {
          c = createEnvironmentClients({
            entry,
            config,
            env,
            tokens,
            now,
            ...(options.transport === undefined ? {} : { transport: options.transport }),
            onRequest: (api, request) => engine?.recordRequest(entry.id, api, request),
          });
          clients.set(entry.id, c);
        }
        return c;
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const running = engine;
  let closing: Promise<void> | undefined;
  return {
    mode: 'live',
    environments: config.environments.map((e) => ({
      env_id: e.id,
      display_name: e.displayName,
      tier: e.tier,
    })),
    store,
    model: store,
    clock,
    collection: () => running.status(),
    start: () => running.start(),
    close: () =>
      (closing ??= (async () => {
        await running.stop();
        await Promise.allSettled([...clients.values()].map((c) => c.close()));
        store.close();
      })()),
  };
}

export interface OpenConfiguredWorkspaceOptions extends LiveWorkspaceOverrides {
  /** `--config <file>`. */
  readonly configPath?: string | undefined;
  /** The process environment (`DCAM_CONFIG`, `DCAM_DATA_DIR`, proxy and CA variables, ...). */
  readonly env: Env;
  readonly cwd: string;
  readonly homeDir: string;
}

/**
 * Loads the configuration (`--config`, else `DCAM_CONFIG`, else `dcam.config.yaml` in the working
 * directory) and opens the live workspace, or the setup workspace when the file is missing or invalid.
 */
export async function openConfiguredWorkspace(
  options: OpenConfiguredWorkspaceOptions,
): Promise<{ readonly workspace: RunningWorkspace; readonly warnings: readonly ConfigIssue[] }> {
  const loaded = await loadWorkspaceConfig({
    flagPath: options.configPath,
    env: options.env,
    cwd: options.cwd,
    homeDir: options.homeDir,
  });
  if (!loaded.ok) {
    const setup = await createSetupWorkspace({
      configPath: loaded.configPath,
      issues: loaded.issues,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return {
      workspace: { ...setup, start: () => undefined, close: async () => setup.store.close() },
      warnings: [],
    };
  }
  const workspace = await createLiveWorkspace({ ...options, config: loaded.config });
  return { workspace, warnings: loaded.warnings };
}
