/**
 * (i) explanations for the DCAM health page (FR-UI-05, spec §12.9): one per panel and one per number
 * column of the collector and footprint tables.
 *
 * @implements FR-UI-05, FR-SELF-01, FR-COLL-11, HM-030, NFR-OBS-06
 */
import type { Explanation } from '@dcam/ui-kit';
import { COLLECTION_POLL_MS } from '../../components/collection';
import { WIKI_SLUGS, wikiHref } from '../wiki/content/slugs';

const ENGINE = "DCAM's collection engine";
const REQUEST_LOG = "DCAM's own request log";
const FRESHNESS = `Refreshed every ${COLLECTION_POLL_MS / 1000} s`;
/** The glossary defines the observer budget; there is no page of its own yet. */
const OBSERVER_BUDGET_WIKI = { href: wikiHref(WIKI_SLUGS.glossary), title: 'Glossary (observer budget)' };
/** Cloud Monitoring bills reads per time series returned (spec Appendix, NFR-OBS-06). */
const MONITORING_PRICING_DOC = {
  title: 'Google Cloud Observability pricing examples',
  url: 'https://cloud.google.com/stackdriver/observability-pricing-examples',
};

export const HEALTH_EXPLANATIONS = {
  'health-profile': {
    id: 'health-profile',
    title: 'Collection profile',
    summary:
      'How often DCAM collects from this environment: live, standard, eco or off (FR-SETUP-05). Faster profiles make more requests.',
    howToRead:
      'Production environments use standard by default, other tiers eco. To change it, set profile for the environment in dcam.config.yaml, then restart DCAM.',
    sources: ['dcam.config.yaml'],
  },
  'health-collectors': {
    id: 'health-collectors',
    title: 'Collectors',
    summary:
      'Each collector reads one source on its own cadence. The table shows its state, last success, next run, lag and failures (FR-COLL-11).',
    whyItMatters:
      'Pages are only as fresh as the collectors behind them. A failing collector leaves its pages with older data.',
    howToRead:
      'OK: the last cycle succeeded. Waiting: no cycle has finished yet. Degraded: the last cycle failed, or a request budget slowed it down. Failing: three or more failures in a row. Disabled: not used for this environment.',
    sources: [ENGINE],
    freshness: FRESHNESS,
  },
  'health-footprint': {
    id: 'health-footprint',
    title: 'Requests DCAM makes',
    summary:
      "DCAM's own requests to each API for this environment in the last hour and the last 24 hours, against its request budget (HM-030).",
    whyItMatters:
      'DCAM must never be the reason an environment is slow or a quota runs out (spec §7.11). Budgets cap its requests, and the hard maxima cannot be raised.',
    howToRead:
      'Budget use close to 100 % means the budget binds: DCAM then slows collection down rather than exceed it.',
    sources: [REQUEST_LOG],
    freshness: FRESHNESS,
    wiki: OBSERVER_BUDGET_WIKI,
  },
  'health-series': {
    id: 'health-series',
    title: 'Monitoring time series (24 h)',
    summary: 'Cloud Monitoring time series DCAM read for this environment in the last 24 hours (NFR-OBS-06).',
    whyItMatters: 'Cloud Monitoring bills API reads by the number of time series returned.',
    howToRead:
      '"Not used" means DCAM does not read Cloud Monitoring for this environment, for example the local emulator.',
    sources: [REQUEST_LOG],
    caveats: ['A monthly series budget and its month-to-date estimate come in a later release.'],
    docs: [MONITORING_PRICING_DOC],
  },

  // Collector columns.
  'health-last-success': {
    id: 'health-last-success',
    title: 'Last success',
    summary: 'How long before this status the collector last finished a cycle without an error.',
    howToRead:
      'Hover over the time for the exact date and time (UTC). "Never" means no cycle has succeeded yet.',
    sources: [ENGINE],
  },
  'health-next-run': {
    id: 'health-next-run',
    title: 'Next run',
    summary: 'When the scheduler plans the next cycle of this collector.',
    howToRead:
      '"Due now" means the cycle waits for its turn: the scheduler adds a little random delay and serves higher-priority collectors first (FR-COLL-02). "Not scheduled" means the collector does not run.',
    sources: [ENGINE],
  },
  'health-lag': {
    id: 'health-lag',
    title: 'Lag',
    summary: 'Age of the newest data this collector saved, at the time of this status.',
    whyItMatters: 'Pages for this environment are at least this old for the data this collector provides.',
    howToRead:
      'A healthy lag stays close to one cadence. Cloud Monitoring data is read only after its ingestion delay (FR-COLL-07), so its lag never drops below that delay.',
    sources: [ENGINE],
  },
  'health-cadence': {
    id: 'health-cadence',
    title: 'Cadence',
    summary: "How often the collector runs under this environment's profile.",
    howToRead: 'A request budget can stretch the cadence for a while; the state then shows Degraded.',
    sources: ['dcam.config.yaml', ENGINE],
  },
  'health-failures': {
    id: 'health-failures',
    title: 'Failures in a row',
    summary: 'Cycles that failed one after another since the last success.',
    howToRead:
      'At 3 the collector is failing, and the environment header shows "Collection failing" (FR-COLL-11). Read the last error and its fix in the same row.',
    sources: [ENGINE],
  },
  'health-error-rate': {
    id: 'health-error-rate',
    title: 'Error rate (1 h)',
    summary: 'Share of attempts by this collector in the last hour that failed.',
    howToRead: '"—" means the collector made no attempt in the last hour.',
    sources: [ENGINE],
  },

  // Footprint columns.
  'health-budget': {
    id: 'health-budget',
    title: 'Request budget',
    summary: 'The most requests per minute DCAM allows itself to this API for this environment (spec §7.11).',
    whyItMatters:
      'When the budget runs out, DCAM waits and collects less often instead of sending more requests.',
    sources: ['dcam.config.yaml', 'DCAM hard maxima (spec §7.11)'],
    caveats: ['The Cloud Monitoring budget applies per project: environments in the same project share it.'],
    wiki: OBSERVER_BUDGET_WIKI,
  },
  'health-requests-1h': {
    id: 'health-requests-1h',
    title: 'Requests (1 h)',
    summary: 'Requests DCAM sent to this API for this environment in the last hour.',
    formula: 'budget use = requests ÷ (budget per minute × 60)',
    caveats: ['Budget use is an average over the hour, so short bursts do not show.'],
    sources: [REQUEST_LOG],
  },
  'health-requests-24h': {
    id: 'health-requests-24h',
    title: 'Requests (24 h)',
    summary: 'Requests DCAM sent to this API for this environment in the last 24 hours.',
    formula: 'budget use = requests ÷ (budget per minute × 1,440)',
    caveats: ['Budget use is an average over the day, so bursts do not show.'],
    sources: [REQUEST_LOG],
  },
  'health-errors-24h': {
    id: 'health-errors-24h',
    title: 'Errors (24 h)',
    summary: 'Requests DCAM sent to this API in the last 24 hours that failed.',
    howToRead: 'The collectors table shows the last error of each collector and how to fix it.',
    sources: [REQUEST_LOG],
  },
  'health-bytes-24h': {
    id: 'health-bytes-24h',
    title: 'Data received (24 h)',
    summary: 'Size of the responses DCAM received from this API in the last 24 hours.',
    howToRead: 'Decimal units: 1 kB is 1,000 bytes, 1 MB is 1,000,000 bytes.',
    sources: [REQUEST_LOG],
  },
  'health-p95-latency': {
    id: 'health-p95-latency',
    title: 'p95 latency',
    summary: "95 % of DCAM's recent requests to this API finished within this time.",
    whyItMatters:
      'Rising latency on the Airflow API is a sign of distress; DCAM then backs off to protect the environment (spec §7.11).',
    howToRead: '"—" means DCAM has no latency to report yet, for example before its first request.',
    sources: [REQUEST_LOG],
  },
} as const satisfies Record<string, Explanation>;

export type HealthExplanationId = keyof typeof HEALTH_EXPLANATIONS;
/** Every explanation on the page; each environment section shows all of them. */
export const HEALTH_PANELS = Object.keys(HEALTH_EXPLANATIONS) as HealthExplanationId[];
/** Number columns of the collector table, in order. */
export const COLLECTOR_COLUMNS = [
  'health-last-success',
  'health-next-run',
  'health-lag',
  'health-cadence',
  'health-failures',
  'health-error-rate',
] as const satisfies readonly HealthExplanationId[];
/** Number columns of the footprint table, in order. */
export const FOOTPRINT_COLUMNS = [
  'health-budget',
  'health-requests-1h',
  'health-requests-24h',
  'health-errors-24h',
  'health-bytes-24h',
  'health-p95-latency',
] as const satisfies readonly HealthExplanationId[];
