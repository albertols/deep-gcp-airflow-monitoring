/**
 * The workspace configuration as the application sees it (spec §17), after the config-file adapter has
 * validated `dcam.config.yaml` and applied defaults and environment variables. No secrets: credentials
 * are referenced by environment variable name only (FR-SETUP-07).
 */
import type { Tier } from '@dcam/domain';

/** Collection profiles (FR-SETUP-05). `off` keeps the environment listed but collects nothing. */
export type Profile = 'live' | 'standard' | 'eco' | 'off';
/** Budget classes (§7.11): the profiles plus `background` for inventory refreshes. */
export type BudgetClass = 'live' | 'standard' | 'eco' | 'background';

/** Collector cadences of one profile, in seconds (§17.2 `profiles`). */
export interface ProfileCadences {
  readonly airflowLive: number;
  readonly airflowFacts: number;
  readonly airflowInventory: number;
  readonly monitoring: number;
  readonly composer: number;
}

/** Request budgets (§7.11); values above the hard maxima are rejected by the config adapter. */
export interface Budgets {
  /** Airflow API requests per minute per environment, by budget class. */
  readonly airflowApi: Readonly<Record<BudgetClass, number>> & { readonly maxConcurrent: number };
  /** Cloud Monitoring requests per minute per project. */
  readonly monitoringPerProjectPerMinute: number;
  /** Composer API requests per minute per environment. */
  readonly composerApiPerMinute: number;
}

/** Limits of a self-managed Airflow (the emulator), which has no Composer API to read them from. */
export interface StaticLimits {
  readonly parallelism: number;
  readonly schedulers: number;
  readonly maxActiveTasksPerDag: number;
  readonly maxActiveRunsPerDag: number;
  readonly workerConcurrency: number;
  readonly workers: number;
}

/** Where an environment's data comes from. */
export type EnvironmentSource =
  | {
      /** A Managed Airflow (Composer) environment: Composer API, Cloud Monitoring and the Airflow API. */
      readonly kind: 'composer';
      readonly projectId: string;
      readonly location: string;
      readonly environment: string;
    }
  | {
      /**
       * A self-managed Airflow on this machine, such as the emulator (FR-EMU-02): Airflow API only, on a
       * loopback URL, with basic authentication from the named environment variables.
       */
      readonly kind: 'airflow';
      readonly baseUrl: string;
      readonly usernameEnv: string;
      readonly passwordEnv: string;
      readonly limits: StaticLimits;
    };

export interface EnvironmentEntry {
  /** DCAM's own slug, used in URLs and the API. */
  readonly id: string;
  readonly displayName: string;
  readonly tier: Tier;
  readonly profile: Profile;
  readonly source: EnvironmentSource;
}

export interface WorkspaceConfig {
  /** Absolute path of the file the configuration was read from. */
  readonly path: string;
  /** Absolute data directory (`~` expanded, `DCAM_DATA_DIR` applied). */
  readonly dataDir: string;
  /** Overrides the quota project of Google API calls (FR-AUTH-04); `null` uses each environment's project. */
  readonly quotaProjectId: string | null;
  /** Extra CA bundle for TLS-inspecting proxies (FR-AUTH-07); `NODE_EXTRA_CA_CERTS` is honoured as well. */
  readonly caBundlePath: string | null;
  readonly profiles: Readonly<Record<Exclude<Profile, 'off'>, ProfileCadences>>;
  readonly budgets: Budgets;
  readonly environments: readonly EnvironmentEntry[];
}

/** One validation problem in the configuration file (FR-SETUP-02). */
export interface ConfigIssue {
  /** Dotted path into the file, for example `environments.0.projectId`; empty for the whole file. */
  readonly path: string;
  readonly message: string;
  readonly fixHint: string;
}
