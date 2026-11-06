/**
 * The doctor's probes as the CLI provides them: facts about this machine read directly (Node.js, DuckDB,
 * the data directory, `gcloud --version`, CA variables, CA files), the proxy variables as http-guard's
 * transport reads them (the same code, so the evidence matches what DCAM sends), plus the adapter-backed
 * probes (configuration file, ADC token source, Composer, Airflow and Monitoring clients) that the
 * composition root passes in as {@link DoctorAdapters}. Nothing here writes a file or calls the network.
 *
 * @implements FR-AUTH-05, FR-AUTH-02, FR-AUTH-07
 */
import { execFile } from 'node:child_process';
import { access, constants, readFile, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  ConfigProbeResult,
  DataDirFacts,
  DoctorEnvironmentProbes,
  DoctorProbes,
  DoctorProxyRoute,
} from '@dcam/application';
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

/** `execFile` without a shell, as the probes use it. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number },
) => Promise<{ readonly stdout: string }>;

/**
 * The only environment variables the checks see. The proxy variables reach them only through
 * http-guard (`proxySettings`, `proxyRoute`), without credentials.
 */
export const DOCTOR_ENV_KEYS = ['NODE_EXTRA_CA_CERTS', 'GOOGLE_APPLICATION_CREDENTIALS'] as const;

const GCLOUD_TIMEOUT_MS = 20_000;

const run = promisify(execFile);
const defaultExec: ExecFileFn = async (file, args, options) => {
  const { stdout } = await run(file, [...args], {
    timeout: options.timeout,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  return { stdout };
};

/**
 * First line of `gcloud --version`, or `null` when the Google Cloud CLI is not installed. Fixed
 * arguments and no shell. On Windows `gcloud` is `gcloud.cmd`, which Node.js cannot start without a
 * shell since the CVE-2024-27980 fix, so it runs through `cmd.exe /d /s /c` with fixed arguments
 * (`%ComSpec%`, as Node.js itself resolves the shell, so a `cmd.exe` in the working directory is not used).
 */
export async function gcloudVersion(
  platform: string,
  env: Env,
  exec: ExecFileFn = defaultExec,
): Promise<string | null> {
  const [file, args] =
    platform === 'win32'
      ? [env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', 'gcloud.cmd', '--version']]
      : ['gcloud', ['--version']];
  try {
    const { stdout } = await exec(file, args, { timeout: GCLOUD_TIMEOUT_MS });
    return (
      stdout
        .split(/\r?\n/)
        .find((l) => l.trim())
        ?.trim() ?? 'gcloud (version not reported)'
    );
  } catch (error) {
    const e = error as { code?: unknown; stderr?: unknown };
    if (e.code === 'ENOENT') return null;
    // cmd.exe exits with 9009 when a command is not found. ⚠️ VERIFY on the Windows laptop.
    const stderr = typeof e.stderr === 'string' ? e.stderr : '';
    if (platform === 'win32' && (e.code === 9009 || /is not recognized/i.test(stderr))) return null;
    throw error;
  }
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
  readonly exec?: ExecFileFn;
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
    gcloudVersion: () => gcloudVersion(platform, env, options.exec),
    tokens: adapters.tokens,
    readTextFile: (path) => readFile(path, 'utf8'),
    environment: (entry, config) => adapters.environment(entry, config),
  };
}

const NOT_WIRED =
  'not wired in this build yet: the configuration, Google Cloud and Airflow adapters join the doctor when feature 002 is assembled.';

/**
 * Placeholder until the composition root passes the real adapters: every adapter-backed check fails
 * and says why. It never pretends that a check passed.
 */
export function unwiredDoctorAdapters(_options: { readonly configPath: string | null }): DoctorAdapters {
  const fail = async (): Promise<never> => {
    throw new Error(`Adapters ${NOT_WIRED}`);
  };
  return {
    loadConfig: fail,
    tokens: { accessToken: fail, invalidate: () => undefined },
    environment: () => {
      throw new Error(`Environment adapters ${NOT_WIRED}`);
    },
  };
}
