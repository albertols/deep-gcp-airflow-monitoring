/**
 * (i) explanations for the alerts page (FR-UI-05, spec §12.9).
 */
import type { Explanation } from '@dcam/ui-kit';

const COMPOSER_METRICS_DOC = {
  title: 'Cloud Monitoring: Cloud Composer metrics',
  url: 'https://cloud.google.com/monitoring/api/metrics_gcp_c#gcp-composer',
};
const LOCAL_CAVEAT =
  'Alerts are evaluated by DCAM on this machine, only while it runs. They are not a replacement for Cloud Monitoring alert policies.';
const STATES =
  'inactive → pending (condition true, waiting for its "for" duration) → firing → resolved (condition false for 10 min). Unknown means the source is stale or not collected.';

export const ALERT_EXPLANATIONS = {
  'alerts-firing': {
    id: 'alerts-firing',
    title: 'Firing now',
    summary: 'Rules whose condition has held for its full "for" duration and has not cleared yet.',
    whyItMatters: 'Each one has a runbook: open it and follow the checks in order.',
    howToRead: STATES,
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
    freshness: 'Evaluated once per minute',
    caveats: [LOCAL_CAVEAT],
  },
  'alerts-pending': {
    id: 'alerts-pending',
    title: 'Pending',
    summary: 'Rules whose condition is true now but has not held for its "for" duration yet.',
    howToRead:
      'A pending alert that clears before its "for" duration ends returns to inactive without firing.',
    sources: ['SRC-AF-API', 'SRC-MON'],
    freshness: 'Evaluated once per minute',
  },
  'alerts-fired-24h': {
    id: 'alerts-fired-24h',
    title: 'Fired in 24 h',
    summary: 'How many times rules fired in the last 24 hours (spec §16.7).',
    whyItMatters: 'A rule that fires often and resolves on its own is noise: tune or remove it.',
    formula: 'count of "fired" events in the last 24 h',
    howToRead:
      'An alert firing now that fired before the last 24 h, or comes from a health reading without a start time, is listed below the count instead.',
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
  },
  'alerts-mttr': {
    id: 'alerts-mttr',
    title: 'Mean time to resolve',
    summary:
      'Average time from an alert firing to its resolution, over alerts that resolved in the last 24 hours.',
    formula: 'mean of (resolved − fired) per alert; alerts still firing are not counted',
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
    caveats: [
      'Resolution includes the 10-minute clear period (hysteresis), so short incidents read at least 10 minutes.',
      'The share of alerts with no follow-up action (spec §16.7) needs action tracking, which arrives later.',
    ],
  },
  'alerts-unknown': {
    id: 'alerts-unknown',
    title: 'Not evaluated',
    summary:
      'Rules DCAM cannot evaluate: their source is stale, not collected in this version, or lacks history.',
    whyItMatters: 'DCAM never alerts on data it does not have, so these rules stay quiet rather than guess.',
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
    freshness: 'A source older than 3 × its collection cadence counts as stale',
  },
  'alerts-rules': {
    id: 'alerts-rules',
    title: 'Alert rules',
    summary:
      'The default alert pack (AL-01 to AL-19, spec §16.4) for each environment: one alert per rule and environment.',
    howToRead: `${STATES} Severity depends on the tier: production first, other tiers are usually one level lower.`,
    formula: 'Each rule compares its signal with the threshold once per minute over the last 24 h',
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
    freshness:
      'Evaluated once per minute; health readings cover their own window (4 h, 12 h, 15 min or 24 h)',
    caveats: [
      LOCAL_CAVEAT,
      'Health readings already aggregate their window, so those rules fire on the first reading that breaches.',
      '"Export" says whether a rule can be expressed as a Cloud Monitoring alert policy. Export is copy-only and arrives later (FR-ALRT-07).',
    ],
    docs: [COMPOSER_METRICS_DOC],
  },
  'alerts-timeline': {
    id: 'alerts-timeline',
    title: 'Firing periods',
    summary: 'When each rule was firing over the last 24 hours, one row per rule and environment.',
    howToRead:
      'A bar starts when the rule fired and ends when it resolved. A bar that reaches the right edge is still firing.',
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
  },
  'alerts-history': {
    id: 'alerts-history',
    title: 'Alert history',
    summary: 'Every fired and resolved event of the last 24 hours, newest first (FR-ALRT-06).',
    howToRead: 'The value is the signal at the moment of the event, in the rule’s unit.',
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
    caveats: ['History covers the time DCAM ran; it is kept on this machine only.'],
  },
} as const satisfies Record<string, Explanation>;

export type AlertExplanationId = keyof typeof ALERT_EXPLANATIONS;
export const ALERT_PANELS = Object.keys(ALERT_EXPLANATIONS) as AlertExplanationId[];
