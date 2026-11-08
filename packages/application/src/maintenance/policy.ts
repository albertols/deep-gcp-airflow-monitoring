/**
 * The retention an environment's data gets: its own setting per class, else the workspace's, else the §17.2
 * default (spec §9.4 FR-STORE-02: "all configurable per environment"), and the class of each stored family.
 *
 * @implements FR-STORE-02
 */
import {
  DEFAULT_DISK_BUDGET_GB,
  DEFAULT_RETENTION_DAYS,
  type RetentionClass,
  type RetentionDays,
} from '@dcam/domain';
import type { RetainedFamily, RetentionSettings, WorkspaceConfig } from '@dcam/ports';

/** The class each stored family belongs to (spec §9.4: raw task instances, raw metric points). */
export const FAMILY_CLASS: Readonly<Record<RetainedFamily, RetentionClass>> = {
  'task-tries': 'rawTaskInstancesDays',
  'ready-times': 'rawMetricPointsDays',
  snapshots: 'rawMetricPointsDays',
  'worker-samples': 'rawMetricPointsDays',
};

/** The workspace's retention and disk budget, defaults filled in. */
export function workspaceRetention(config: Pick<WorkspaceConfig, 'retention'>): RetentionSettings {
  return config.retention ?? { ...DEFAULT_RETENTION_DAYS, diskBudgetGb: DEFAULT_DISK_BUDGET_GB };
}

/**
 * The days each class of one environment's data is kept. An environment no longer in the configuration
 * keeps the workspace's retention, so its data expires instead of staying forever.
 */
export function effectiveRetention(
  config: Pick<WorkspaceConfig, 'retention' | 'environments'>,
  envId: string,
): RetentionDays {
  const w = workspaceRetention(config);
  const own = config.environments.find((e) => e.id === envId)?.retention ?? {};
  return {
    rawTaskInstancesDays: own.rawTaskInstancesDays ?? w.rawTaskInstancesDays,
    rawMetricPointsDays: own.rawMetricPointsDays ?? w.rawMetricPointsDays,
    rollup5mDays: own.rollup5mDays ?? w.rollup5mDays,
    rollup1hDays: own.rollup1hDays ?? w.rollup1hDays,
    logSignaturesDays: own.logSignaturesDays ?? w.logSignaturesDays,
    findingsDays: own.findingsDays ?? w.findingsDays,
  };
}
