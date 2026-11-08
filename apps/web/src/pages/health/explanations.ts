/**
 * (i) explanations for the DCAM health page (FR-UI-05, spec §12.9): one per panel and one per number
 * column of the collector and footprint tables.
 *
 * The local store panel has its own entries ({@link STORE_EXPLANATIONS}): it appears once, not per environment.
 *
 * @implements FR-UI-05, FR-SELF-01, FR-COLL-04, FR-COLL-11, HM-030, NFR-OBS-06, FR-STORE-02, FR-STORE-07
 */
import type { Explanation } from '@dcam/ui-kit';
import { COLLECTION_POLL_MS } from '../../components/collection';
import { WIKI_SLUGS, wikiHref } from '../wiki/content/slugs';

const ENGINE = "DCAM's collection engine";
const STORE = "DCAM's DuckDB store";
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
  'health-retention': {
    id: 'health-retention',
    title: 'Retention',
    summary:
      "How long DCAM keeps this environment's data: task tries, and live snapshots, worker samples and ready times (FR-STORE-02).",
    whyItMatters:
      'A page over a longer range has no data before that; it says from when, and never shows the gap as zero.',
    howToRead:
      'Set retention in dcam.config.yaml, for the workspace or for one environment, then restart DCAM. Expired data is deleted when DCAM starts and every 24 hours.',
    sources: ['dcam.config.yaml'],
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

  'health-backfill': {
    id: 'health-backfill',
    title: 'History backfill',
    summary:
      'When DCAM first collects an environment, it reads the history before that in the background: 7 days of finished task instances and 14 days of worker metrics by default (FR-COLL-04).',
    whyItMatters:
      'Until the backfill is complete, pages whose range starts earlier show only part of that range. The missing part is a gap, never zero.',
    howToRead:
      'Newest history comes first, so "covered from" moves back in time. The backfill yields to live collection and stays within the request budget; it resumes where it stopped after a restart.',
    caveats: [
      'Retried tries of a task instance before its last try are not backfilled; DCAM reads them only while it runs.',
      'To finish sooner, use the live profile for this environment for a while, or raise budgets.airflowApi.background in dcam.config.yaml.',
    ],
    sources: [ENGINE, 'dcam.config.yaml'],
    freshness: FRESHNESS,
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
      'A healthy lag stays close to one cadence, or to how often the data is refreshed where that is longer: the DAG inventory runs every few minutes but refreshes the whole list once an hour, so its lag is up to an hour while it is healthy. Finished task instances are read one minute after the fact (the settling delay), so the lag of af.facts is about a minute more than its cadence. Cloud Monitoring data is read only after its ingestion delay (FR-COLL-07), so its lag never drops below that delay.',
    sources: [ENGINE],
  },
  'health-cadence': {
    id: 'health-cadence',
    title: 'Cadence',
    summary: "How often the collector runs under this environment's profile.",
    howToRead:
      'A request budget can stretch the cadence for a while; the state then shows Degraded. A collector that reads its data in parts also says how often the whole is refreshed: the DAG inventory trickles one full listing across each hour (spec §7.5).',
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
  // Backfill columns.
  'health-backfill-days': {
    id: 'health-backfill-days',
    title: 'Days read',
    summary: 'Days of history read so far, of the days configured for this environment.',
    formula: 'days read = (where live collection starts − covered from) ÷ 1 day',
    howToRead:
      'Set backfill.taskInstancesDays and backfill.metricsDays for the environment in dcam.config.yaml; 0 turns a backfill off.',
    sources: [ENGINE, 'dcam.config.yaml'],
  },
  'health-backfill-covered': {
    id: 'health-backfill-covered',
    title: 'Covered from',
    summary:
      'History is complete from this time on. Before it, the pages of this environment have no data from the backfill yet.',
    howToRead: 'Hover over the time for the exact date and time (UTC).',
    sources: [ENGINE],
  },
  'health-backfill-rows': {
    id: 'health-backfill-rows',
    title: 'Rows read',
    summary:
      'Rows the backfill stored: task instance tries, or one-minute worker samples. Rows already collected live are stored once.',
    sources: [ENGINE],
  },
  'health-backfill-requests': {
    id: 'health-backfill-requests',
    title: 'Requests',
    summary:
      'Requests the backfill made so far, across restarts. They count against the request budget above.',
    sources: [REQUEST_LOG],
  },
  'health-backfill-eta': {
    id: 'health-backfill-eta',
    title: 'Time left',
    summary: 'When the backfill should finish at the pace it had over the last 30 minutes.',
    formula: 'time left = work left ÷ rate observed over the last 30 min',
    howToRead:
      '"Not known yet" until DCAM has seen 5 minutes of progress and has counted the work left. The pace changes with the budget and with how much live collection needs.',
    caveats: ['An estimate from the observed rate, not a promise.'],
    sources: [ENGINE],
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
/** Number columns of the backfill table, in order (FR-COLL-04). */
export const BACKFILL_COLUMNS = [
  'health-backfill-days',
  'health-backfill-covered',
  'health-backfill-rows',
  'health-backfill-requests',
  'health-backfill-eta',
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

/** (i) explanations of the local store panel (FR-UI-05). */
export const STORE_EXPLANATIONS = {
  'store-usage': {
    id: 'store-usage',
    title: 'Disk budget use',
    summary:
      "How much of its disk budget DCAM's store uses: the database blocks that hold data, plus the write-ahead log (FR-STORE-07).",
    formula: 'use = bytes in use ÷ (retention.diskBudgetGb × 10⁹)',
    whyItMatters:
      'From 90 % of the budget DCAM thins live snapshots older than 24 hours to one per 5 minutes, then deletes the oldest data, so its store never fills your disk.',
    howToRead:
      'The file on disk can be larger than what is in use: the space deleted data leaves is reused before the file grows, and the file does not shrink.',
    sources: [STORE, 'dcam.config.yaml'],
    freshness: 'Measured when DCAM starts and every hour',
    caveats: ['Decimal units: 1 GB is 1,000,000,000 bytes.'],
  },
  'store-maintenance': {
    id: 'store-maintenance',
    title: 'Maintenance',
    summary:
      'DCAM deletes data older than its retention when it starts and every 24 hours, and checks the disk budget every hour (FR-STORE-02).',
    howToRead:
      'Deletes run in small batches, each its own transaction, so collection never waits for long. A run that stops early is finished by the next one.',
    sources: [STORE],
  },
} as const satisfies Record<string, Explanation>;

export type StoreExplanationId = keyof typeof STORE_EXPLANATIONS;
/** Every explanation of the local store panel. */
export const STORE_PANELS = Object.keys(STORE_EXPLANATIONS) as StoreExplanationId[];
