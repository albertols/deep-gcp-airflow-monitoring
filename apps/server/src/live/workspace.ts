/**
 * The live workspace: the configured environments, collected read-only by the collection engine into
 * the DuckDB store in the data directory. The store also serves every page, so live and demo pages are
 * the same code. Without a valid configuration DCAM starts in setup mode instead (FR-SETUP-02).
 *
 * Every environment's clients are built before the store opens: a network setting DCAM cannot use (a
 * missing `network.caBundlePath`, a SOCKS proxy, a mistyped `DCAM_NETWORK`) stops start-up with its own
 * message, instead of failing every collection cycle afterwards (FR-AUTH-07).
 *
 * @implements FR-SETUP-02, FR-COLL-01, FR-COLL-11, FR-STORE-01, FR-AUTH-07, HM-030
 */
import {
  createCollectionEngine,
  createCollectors,
  type CollectionEngine,
  type CollectionLogEntry,
  type Collector,
} from '@dcam/application';
import { configFileLocation, loadWorkspaceConfig } from '@dcam/config-file';
import { openFileStore } from '@dcam/duckdb-store';
import { networkModeFromEnv, type Transport } from '@dcam/http-guard';
import type { AccessTokenSource, Clock, ConfigIssue, Sleeper, WorkspaceConfig } from '@dcam/ports';
import { createSetupWorkspace } from '../setup';
import type { Workspace } from '../workspace';
import { createEnvironmentClients, type EnvironmentClients } from './environment-clients';
import { systemSleeper } from './sleeper';
import { createAdcTokenSource } from './tokens';

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
  /**
   * The ADC token source: gcloud by default (ADR-0016), and none at all with `DCAM_NETWORK=loopback-only`
   * (see `createAdcTokenSource`).
   */
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

function networkError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `DCAM cannot use its network settings: ${message}\n` +
      'Correct this in the shell that starts DCAM or in dcam.config.yaml, then start DCAM again ' +
      '("pnpm dcam doctor" checks the proxy and CA settings).',
    { cause: error },
  );
}

const closeAll = (clients: Iterable<EnvironmentClients>) =>
  Promise.allSettled([...clients].map((c) => c.close()));

export async function createLiveWorkspace(options: LiveWorkspaceOptions): Promise<RunningWorkspace> {
  const { config, env } = options;
  const now = options.now ?? Date.now;
  const clock: Clock = { now };
  const tokens = options.tokens ?? createAdcTokenSource({ env, now });
  // The guard's footprint hook needs the engine, and the engine needs the clients: bound late.
  let engine: CollectionEngine | undefined;
  const clients = new Map<string, EnvironmentClients>();
  try {
    networkModeFromEnv(env);
    for (const entry of config.environments) {
      clients.set(
        entry.id,
        createEnvironmentClients({
          entry,
          config,
          env,
          tokens,
          now,
          ...(options.transport === undefined ? {} : { transport: options.transport }),
          onRequest: (api, request) => engine?.recordRequest(entry.id, api, request),
        }),
      );
    }
  } catch (error) {
    await closeAll(clients.values());
    throw networkError(error);
  }
  let store: Awaited<ReturnType<typeof openFileStore>>;
  try {
    store = await openFileStore({ dataDir: config.dataDir, now });
  } catch (error) {
    await closeAll(clients.values());
    throw storeError(config.dataDir, error);
  }
  try {
    engine = createCollectionEngine({
      config,
      store,
      clock,
      sleeper: options.sleeper ?? systemSleeper,
      collectors: options.collectors ?? createCollectors(),
      ...(options.log === undefined ? {} : { log: options.log }),
      sources: (entry) => {
        const c = clients.get(entry.id);
        if (!c) throw new Error(`No clients for environment ${entry.id}: it is not in the configuration.`);
        return c;
      },
    });
  } catch (error) {
    store.close();
    await closeAll(clients.values());
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
        await closeAll(clients.values());
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
  const input = {
    flagPath: options.configPath,
    env: options.env,
    cwd: options.cwd,
    homeDir: options.homeDir,
  };
  const loaded = await loadWorkspaceConfig(input);
  if (!loaded.ok) {
    const setup = await createSetupWorkspace({
      configPath: loaded.configPath,
      // The setup page repeats --config in the commands it suggests.
      configFlag: options.configPath ? configFileLocation(input) : null,
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
