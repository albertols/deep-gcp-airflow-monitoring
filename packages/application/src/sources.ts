/**
 * Provenance (FR-UI-08): a page names only the sources that contributed data to it, not every source
 * DCAM could read. The caller passes the candidates (`DEMO` in demo mode, where every value is
 * simulated and kept as is); each use case reports what it actually read.
 *
 * - Airflow REST API (`SRC-AF-API`): live snapshots, task tries, DAG metadata, or import errors.
 * - Cloud Monitoring (`SRC-MON`): worker samples, or a platform-health reading other than import errors.
 * - Composer API (`SRC-COMPOSER`): a configuration read from Composer. A self-managed Airflow has its
 *   limits from the configuration file (every limit `configured`), so it has no Composer source.
 *
 * @implements FR-UI-08
 */
import type { SourceId } from '@dcam/contracts';
import type { EnvironmentConfig, PlatformHealth } from '@dcam/domain';

export interface SourceUse {
  readonly airflow: boolean;
  readonly monitoring: boolean;
  readonly composer: boolean;
}

export const NO_SOURCE_USE: SourceUse = { airflow: false, monitoring: false, composer: false };

/** True when the configuration came from the Composer API, not a self-managed Airflow's file. */
export function composerConfig(config: EnvironmentConfig | null): boolean {
  if (!config) return false;
  const sources = Object.values(config.limitSources ?? {});
  return sources.length > 0 && sources.some((s) => s !== 'configured');
}

/** True when a platform-health reading came from Cloud Monitoring (import errors come from Airflow). */
export function monitoringHealth(h: PlatformHealth): boolean {
  return (
    h.envHealthyRatio !== null ||
    h.dbHealthyRatio !== null ||
    h.heartbeatCompleteness !== null ||
    h.webServerHealthyRatio !== null ||
    h.dbCpuMemoryMax !== null ||
    h.zombies24h !== null ||
    h.workerRestarts24h !== null ||
    h.parseLoopP95Seconds !== null
  );
}

export const anyUse = (uses: readonly SourceUse[]): SourceUse => ({
  airflow: uses.some((u) => u.airflow),
  monitoring: uses.some((u) => u.monitoring),
  composer: uses.some((u) => u.composer),
});

/** The candidate sources that contributed data; demo data stays as it is. */
export function usedSources(candidates: readonly SourceId[], use: SourceUse): SourceId[] {
  return candidates.filter(
    (s) =>
      s === 'DEMO' ||
      (s === 'SRC-AF-API' && use.airflow) ||
      (s === 'SRC-MON' && use.monitoring) ||
      (s === 'SRC-COMPOSER' && use.composer),
  );
}
