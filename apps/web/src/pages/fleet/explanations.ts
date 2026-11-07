/**
 * (i) explanations for the fleet page (FR-UI-05, spec §12.9).
 */
import type { Explanation } from '@dcam/ui-kit';
import { WIKI_SLUGS, wikiHref } from '../wiki/content/slugs';

export const FLEET_EXPLANATIONS = {
  'fleet-health': {
    id: 'fleet-health',
    wiki: { href: wikiHref(WIKI_SLUGS.healthScore) },
    title: 'Health score',
    summary: 'An explainable score out of 100 from nine platform checks (HM-028).',
    formula: '100 − Σ weights of failing checks; capped at 40 when a critical check fails',
    howToRead:
      '80 or more is healthy, 50–79 degraded, under 50 unhealthy. Checks without data are unknown and excluded; coverage shows how many were evaluated. With data for less than 80 % of the check weight there is no score: the card says "Partial: n of 9 checks", unless a critical check fails.',
    sources: ['SRC-MON', 'SRC-COMPOSER'],
    caveats: [
      'The label bands are DCAM’s choice; the specification leaves them open. Thresholds are defaults to verify per environment.',
    ],
  },
  'fleet-load': {
    id: 'fleet-load',
    title: 'Running and queued',
    summary: 'Task instances running and queued in the executor in the latest live snapshot.',
    sources: ['SRC-AF-API'],
    freshness: 'The live snapshot cadence (10 s, 30 s or 120 s by collection profile)',
  },
  'fleet-workers': {
    id: 'fleet-workers',
    wiki: { href: wikiHref(WIKI_SLUGS.workerCapacity) },
    title: 'Workers',
    summary: 'Current Celery workers against the environment’s autoscaling maximum.',
    whyItMatters: 'At the maximum, the autoscaler cannot add capacity for queued work.',
    sources: ['SRC-MON', 'SRC-COMPOSER'],
  },
  'fleet-activity': {
    id: 'fleet-activity',
    title: 'Last 24 hours',
    summary: 'Executor slot-hours used, task-hours spent waiting on platform limits, and failed tries.',
    sources: ['SRC-AF-API'],
  },
  'fleet-bottleneck': {
    id: 'fleet-bottleneck',
    wiki: { href: wikiHref(WIKI_SLUGS.whyWorkWaits) },
    title: 'Main bottleneck',
    summary: 'The limit that caused most waiting task-time in the last 24 hours (HM-006).',
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
  },
  'fleet-findings': {
    id: 'fleet-findings',
    wiki: { href: wikiHref(WIKI_SLUGS.advisorRules) },
    title: 'Top findings',
    summary: 'The highest-priority advisor findings for the environment.',
    formula: 'priority = tier weight × impact × confidence ÷ effort',
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
  },
} as const satisfies Record<string, Explanation>;

export type FleetExplanationId = keyof typeof FLEET_EXPLANATIONS;
export const FLEET_PANELS = Object.keys(FLEET_EXPLANATIONS) as FleetExplanationId[];
