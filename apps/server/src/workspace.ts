/**
 * What the HTTP API serves: the configured environments and the ports their pages read. The demo,
 * setup and live workspaces all have this shape, so every page works the same in each mode.
 *
 * @implements FR-SETUP-02, FR-COLL-11, FR-SELF-01, FR-UI-04
 */
import type { Collection, Meta } from '@dcam/contracts';
import type { Store } from '@dcam/duckdb-store';
import type { Clock, ConfigIssue, EnvironmentModelSource } from '@dcam/ports';

/** Setup mode (FR-SETUP-02): the configuration is missing or invalid, so no collector runs. */
export interface SetupState {
  /** File that was read; `null` when none was found. */
  readonly configPath: string | null;
  /** The `--config` path DCAM was started with, absolute; `null` or absent without `--config`. */
  readonly configFlag?: string | null;
  readonly issues: readonly ConfigIssue[];
}

export interface Workspace {
  readonly mode: Meta['mode'];
  readonly environments: Meta['environments'];
  readonly store: Store;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
  /** Live collection status, computed on demand by the collection engine (FR-COLL-11, HM-030). */
  readonly collection?: () => Collection;
  /**
   * The Airflow web server URL as the collectors know it now (live mode): it replaces `airflow_uri` in the
   * meta answer, because Composer reports it only once `composer.config` has run (FR-UI-04).
   */
  readonly airflowUri?: (envId: string) => string | null;
  /** Present in setup mode only; the UI then explains what to fix. */
  readonly setup?: SetupState;
}
