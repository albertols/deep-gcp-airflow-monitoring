/**
 * The doctor's report and the probes it runs against (FR-AUTH-05). Probes are structural: the CLI
 * implements the local ones itself and the composition root wires the adapter-backed ones (config file,
 * gcloud token source, Composer, Airflow and Monitoring clients on the guarded client).
 *
 * @implements FR-AUTH-05, FR-AUTH-02, FR-AUTH-04, FR-AUTH-06, FR-AUTH-07
 */
import type { AccessTokenSource, ConfigIssue, EnvironmentEntry, WorkspaceConfig } from '@dcam/ports';
import type { EnvironmentSources } from '../collection/types';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

/** Scope of the checks that concern this machine; environment checks use the environment id. */
export const LOCAL_SCOPE = 'local';

/** Stable check identifiers (part of the `--json` output). */
export type DoctorCheckId =
  | 'node.version'
  | 'duckdb.load'
  | 'config.valid'
  | 'data-dir.writable'
  | 'data-dir.permissions'
  | 'data-dir.free-space'
  | 'network.proxy'
  | 'network.ca-bundle'
  | 'gcloud.installed'
  | 'adc.token'
  | 'env.configured'
  | 'composer.environment'
  | 'airflow.version'
  | 'airflow.health'
  | 'airflow.role'
  | 'monitoring.read'
  | 'clock.skew';

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  /** Sentence-case name of what is checked. */
  readonly title: string;
  /** `local`, or the environment id the check ran for. */
  readonly scope: string;
  readonly status: DoctorStatus;
  /** One line of what was observed (for a skip: why it did not run). Never contains secrets. */
  readonly evidence: string;
  /** Extra lines, for example every configuration issue with its path and fix. */
  readonly details: readonly string[];
  /** A copyable command or a plain next step; `null` when there is nothing to do. */
  readonly fixHint: string | null;
  readonly docsUrl: string | null;
  /** Wall time of the check in milliseconds. */
  readonly durationMs: number;
}

export interface DoctorReport {
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly durationMs: number;
  /** Local checks first, then unknown `--env` ids, then each environment in configuration order. */
  readonly checks: readonly DoctorCheck[];
  readonly summary: Readonly<Record<DoctorStatus, number>>;
  /** `true` when no check failed (warnings and skips do not count). */
  readonly ok: boolean;
}

/** What loading `dcam.config.yaml` produced (FR-SETUP-02). */
export type ConfigProbeResult =
  | { readonly kind: 'valid'; readonly config: WorkspaceConfig }
  | { readonly kind: 'invalid'; readonly path: string; readonly issues: readonly ConfigIssue[] }
  | { readonly kind: 'missing'; readonly path: string };

/** Facts about the data directory (§17.5), gathered without creating or changing anything. */
export interface DataDirFacts {
  readonly path: string;
  /** `missing`: it does not exist yet, and DCAM creates it owner-only on first start. */
  readonly state: 'directory' | 'missing' | 'not-a-directory';
  /** The directory, or the nearest existing parent it would be created in, is writable by this user. */
  readonly writable: boolean;
  /** POSIX permission bits (`mode & 0o777`); `null` on Windows, for a missing directory, or unknown. */
  readonly mode: number | null;
  /** Bytes available to this user on the volume; `null` when unknown. */
  readonly freeBytes: number | null;
}

/** The sources of one environment, as the collectors get them, plus the clock probe. */
export interface DoctorEnvironmentProbes extends EnvironmentSources {
  /**
   * Sends one GET to `url` through the guarded client (no credentials needed; any HTTP status counts)
   * and returns its `Date` response header as epoch milliseconds, or `null` when there is none.
   */
  serverDate(url: string): Promise<number | null>;
}

export interface DoctorProbes {
  /** `process.platform`. */
  readonly platform: string;
  /** `process.versions.node`, for example `22.20.0`. */
  readonly nodeVersion: string;
  /**
   * Proxy, CA and credential variables (`HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`,
   * `NO_PROXY`, `no_proxy`, `NODE_EXTRA_CA_CERTS`, `GOOGLE_APPLICATION_CREDENTIALS`).
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The data directory to check when the configuration cannot be used (`DCAM_DATA_DIR` or the default). */
  readonly defaultDataDir: string;
  /** Opens and closes an in-memory DuckDB database; throws when the native binary does not load. */
  loadDuckDb(): Promise<void>;
  loadConfig(): Promise<ConfigProbeResult>;
  dataDir(path: string): Promise<DataDirFacts>;
  /** First line of `gcloud --version`, or `null` when the Google Cloud CLI is not installed. */
  gcloudVersion(): Promise<string | null>;
  /** The token source the adapters use; the doctor asks it once and never shows the token. */
  readonly tokens: AccessTokenSource;
  /** Reads a local text file (CA bundles). */
  readTextFile(path: string): Promise<string>;
  environment(entry: EnvironmentEntry, config: WorkspaceConfig): DoctorEnvironmentProbes;
}

export interface DoctorOptions {
  /** Check only these environments (`--env`); every configured environment when empty or absent. */
  readonly envIds?: readonly string[] | undefined;
  /** Time limit of the local checks and of each environment, in milliseconds (default 30 000). */
  readonly perEnvTimeoutMs?: number | undefined;
  readonly now: () => number;
}
