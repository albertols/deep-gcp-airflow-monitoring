/**
 * The doctor's probes as the CLI provides them: facts about this machine read directly (Node.js, DuckDB,
 * the data directory, `gcloud --version`, CA variables, CA files), the proxy variables as http-guard's
 * transport reads them (the same code, so the evidence matches what DCAM sends), plus the adapter-backed
 * probes (configuration file, ADC token source, Composer, Airflow and Monitoring clients) that the
 * composition root passes in as {@link DoctorAdapters}. Nothing here writes a file or calls the network.
 *
 * @implements FR-AUTH-05, FR-AUTH-02, FR-AUTH-07
 */
import { access, constants, readFile, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  ConfigProbeResult,
  DataDirFacts,
  DoctorEnvironmentProbes,
  DoctorProbes,
  DoctorProxyRoute,
} from '@dcam/application';
import {
  GCLOUD_TIMEOUT_MS,
  gcloudCommand,
  runCommand,
  type CommandResult,
  type CommandRunner,
} from '@dcam/gcp';
import { networkModeFromEnv, proxyRoute, readProxyEnvironment } from '@dcam/http-guard';
import type { AccessTokenSource, EnvironmentEntry, WorkspaceConfig } from '@dcam/ports';

type Env = Readonly<Record<string, string | undefined>>;

/** The adapter-backed probes, wired by the composition root (config-file, gcp, airflow-v1, http-guard). */
export interface DoctorAdapters {
  /** Loads and validates the configuration (`--config`, else `DCAM_CONFIG`, else the default path). */
  loadConfig(): Promise<ConfigProbeResult>;
  /** The gcloud ADC token source the Google and Airflow clients share. */
  readonly tokens: AccessTokenSource;
  /** Clients of one environment on the guarded client, plus its `Date`-header probe. */
  environment(entry: EnvironmentEntry, config: WorkspaceConfig): DoctorEnvironmentProbes;
}

/**
 * The only environment variables the checks see. The proxy variables reach them only through
 * http-guard (`proxySettings`, `proxyRoute`), without credentials.
 */
export const DOCTOR_ENV_KEYS = ['NODE_EXTRA_CA_CERTS', 'GOOGLE_APPLICATION_CREDENTIALS'] as const;

/**
 * First line of `gcloud --version`, or `null` when the Google Cloud CLI is not installed. Started exactly
 * as the ADC token source starts gcloud (`@dcam/gcp`): fixed arguments and no shell; on Windows
 * `gcloud.cmd` through the system `cmd.exe` with a PATH-only lookup, and on a timeout the whole process
 * tree is stopped, so no Python is left running.
 */
export async function gcloudVersion(
  platform: string,
  env: Env,
  run: CommandRunner = runCommand,
): Promise<string | null> {
  const command = gcloudCommand(['--version'], platform, env);
  let result: CommandResult;
  try {
    result = await run(command.file, command.args, {
      timeoutMs: GCLOUD_TIMEOUT_MS,
      ...(command.env === undefined ? {} : { env: command.env }),
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
  if (result.timedOut)
    throw new Error(`gcloud --version did not finish within ${GCLOUD_TIMEOUT_MS / 1000} s.`);
  // cmd.exe exits with 9009 when a command is not found. ⚠️ VERIFY on the Windows laptop.
  if (result.exitCode === 9009 || (platform === 'win32' && /is not recognized/i.test(result.stderr)))
    return null;
  if (result.exitCode !== 0) {
    const detail = result.stderr
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 200);
    throw new Error(
      `gcloud --version failed (exit code ${String(result.exitCode)})${detail ? `: ${detail}` : '.'}`,
    );
  }
  return (
    result.stdout
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim() ?? 'gcloud (version not reported)'
  );
}

/** Facts about the data directory, read without creating it (DCAM creates it at first start). */
export async function inspectDataDir(path: string, platform: string): Promise<DataDirFacts> {
  const target = resolve(path);
  const own = await stat(target).catch(() => null);
  let existing = target;
  if (!own) {
    // The nearest existing parent is where DCAM would create it.
    let dir = dirname(target);
    for (;;) {
      if (await stat(dir).catch(() => null)) {
        existing = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const state = !own ? 'missing' : own.isDirectory() ? 'directory' : 'not-a-directory';
  const writable = await access(existing, constants.W_OK).then(
    () => true,
    () => false,
  );
  const fs = await statfs(existing).catch(() => null);
  return {
    path: target,
    state,
    writable: state !== 'not-a-directory' && writable,
    mode: platform === 'win32' || state !== 'directory' || !own ? null : own.mode & 0o777,
    freeBytes: fs ? fs.bavail * fs.bsize : null,
  };
}

/** `DCAM_DATA_DIR` (with `~` expanded) or `~/.dcam/data` (§17.3, §17.5). */
export function defaultDataDir(env: Env, home: string): string {
  const fromEnv = env['DCAM_DATA_DIR']?.trim();
  if (!fromEnv) return join(home, '.dcam', 'data');
  if (fromEnv === '~') return home;
  if (fromEnv.startsWith('~/') || fromEnv.startsWith('~\\')) return join(home, fromEnv.slice(2));
  return resolve(fromEnv);
}

async function loadDuckDb(): Promise<void> {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  instance.closeSync();
}

export interface CreateDoctorProbesOptions {
  readonly adapters: DoctorAdapters;
  /** Defaults to `process.env`; only {@link DOCTOR_ENV_KEYS} reach the checks. */
  readonly env?: Env;
  readonly platform?: string;
  readonly nodeVersion?: string;
  readonly homeDir?: string;
  /** Starts `gcloud --version`; `runCommand` from `@dcam/gcp` by default. */
  readonly run?: CommandRunner;
}

export function createDoctorProbes(options: CreateDoctorProbesOptions): DoctorProbes {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const picked: Record<string, string> = {};
  for (const key of DOCTOR_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) picked[key] = value;
  }
  const { adapters } = options;
  // Read on every call, like the transport at start-up: an invalid DCAM_NETWORK or proxy throws its error.
  const proxyOptions = () => ({ loopbackOnly: networkModeFromEnv(env) === 'loopback-only' });
  return {
    platform,
    nodeVersion: options.nodeVersion ?? process.versions.node,
    env: picked,
    proxySettings: () => readProxyEnvironment(env, proxyOptions()),
    proxyRoute: (url): DoctorProxyRoute => {
      const route = proxyRoute(env, url, proxyOptions());
      return route.via === 'proxy' ? { via: 'proxy', proxy: route.proxy } : { via: 'direct' };
    },
    defaultDataDir: defaultDataDir(env, options.homeDir ?? homedir()),
    loadDuckDb,
    loadConfig: () => adapters.loadConfig(),
    dataDir: (path) => inspectDataDir(path, platform),
    gcloudVersion: () => gcloudVersion(platform, env, options.run),
    tokens: adapters.tokens,
    readTextFile: (path) => readFile(path, 'utf8'),
    environment: (entry, config) => adapters.environment(entry, config),
  };
}
