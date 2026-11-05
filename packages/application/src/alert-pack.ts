/**
 * The default alert pack AL-01…AL-19 (spec §16.4): name, severity per tier, runbook and Cloud
 * Monitoring export, transcribed from the spec table. How each rule is evaluated lives in `alerts.ts`.
 *
 * @implements FR-ALRT-02
 */
import type { AlertRule, Severity } from '@dcam/contracts';
import type { Tier } from '@dcam/domain';

export const ALERT_RULE_IDS = [
  'AL-01',
  'AL-02',
  'AL-03',
  'AL-04',
  'AL-05',
  'AL-06',
  'AL-07',
  'AL-08',
  'AL-09',
  'AL-10',
  'AL-11',
  'AL-12',
  'AL-13',
  'AL-14',
  'AL-15',
  'AL-16',
  'AL-17',
  'AL-18',
  'AL-19',
] as const;

export type AlertRuleId = (typeof ALERT_RULE_IDS)[number];

export interface PackRule {
  readonly id: AlertRuleId;
  readonly name: string;
  /** Severity in production, then in every other tier (spec §16.4 "prod / non-prod"). */
  readonly severity: readonly [prod: Severity, other: Severity];
  /** Wiki slug of the runbook the spec names, for example `rb-01`. */
  readonly runbook: string | null;
  readonly export: AlertRule['export_cloud_monitoring'];
}

const rule = (
  id: AlertRuleId,
  name: string,
  severity: PackRule['severity'],
  runbook: string,
  exportable: PackRule['export'],
): PackRule => ({ id, name, severity, runbook: runbook.toLowerCase(), export: exportable });

export const ALERT_PACK: readonly PackRule[] = [
  rule('AL-01', 'Environment unhealthy', ['critical', 'warning'], 'RB-03', 'yes'),
  // "Yes (absence); completeness: No".
  rule('AL-02', 'Scheduler heartbeat missing', ['critical', 'warning'], 'RB-03', 'partial'),
  rule('AL-03', 'Stale DAG risk', ['warning', 'info'], 'RB-02', 'partial'),
  rule('AL-04', 'Import errors', ['warning', 'info'], 'RB-02', 'yes'),
  rule('AL-05', 'Tasks queued while workers are at maximum', ['warning', 'info'], 'RB-01', 'partial'),
  rule('AL-06', 'Queue wait high', ['warning', 'info'], 'RB-01', 'no'),
  rule('AL-07', 'Worker memory pressure', ['warning', 'info'], 'RB-04', 'yes'),
  rule('AL-08', 'Zombie or heartbeat-timeout tasks', ['warning', 'info'], 'RB-04', 'yes'),
  rule('AL-09', 'Failure spike', ['warning', 'info'], 'RB-11', 'partial'),
  rule('AL-10', 'Database CPU or memory high', ['warning', 'info'], 'RB-07', 'yes'),
  rule('AL-11', 'Database size runway', ['warning', 'info'], 'RB-07', 'no'),
  rule('AL-12', 'Airflow API unreachable from DCAM', ['warning', 'warning'], 'RB-10', 'no'),
  rule('AL-13', 'Triggerer saturated', ['warning', 'info'], 'RB-08', 'partial'),
  rule('AL-14', 'Timeliness target missed', ['warning', 'info'], 'RB-06', 'no'),
  rule('AL-15', 'Pool starvation', ['warning', 'info'], 'RB-01', 'no'),
  rule('AL-16', 'Environment operation failed', ['warning', 'warning'], 'RB-09', 'yes'),
  rule('AL-17', 'DCAM collection stale', ['info', 'info'], 'RB-10', 'no'),
  rule('AL-18', 'Database unhealthy', ['critical', 'warning'], 'RB-07', 'yes'),
  rule('AL-19', 'Worker restarts', ['warning', 'info'], 'RB-04', 'yes'),
];

export const severityFor = (r: PackRule, tier: Tier): Severity =>
  tier === 'prod' ? r.severity[0] : r.severity[1];
