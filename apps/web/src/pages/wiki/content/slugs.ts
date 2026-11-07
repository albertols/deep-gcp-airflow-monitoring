/**
 * Stable wiki page slugs, and maps from signal, rule and runbook IDs to the page that explains them.
 * Other pages import these (not the page content) to link into the wiki, for example from an (i)
 * explanation: `wiki: { href: wikiHref(WIKI_SLUGS.queueWait) }`. A test checks that every entry
 * resolves to a page (FR-WIKI-06).
 *
 * @implements FR-WIKI-06
 */
import { linkTo } from '../../../router';

export const WIKI_SLUGS = {
  startHere: 'start-here',
  concurrencyStack: 'concurrency-stack',
  pools: 'pools',
  scheduledVsQueued: 'scheduled-vs-queued',
  executorSlotSeconds: 'executor-slot-seconds',
  queueWait: 'queue-wait',
  whyWorkWaits: 'why-work-waits',
  workerCapacity: 'worker-capacity-and-autoscaling',
  scheduleCollisions: 'schedule-collisions',
  sensorSlotWaste: 'sensor-slot-waste',
  healthScore: 'health-score',
  advisorRules: 'advisor-rules',
  alertPack: 'default-alert-pack',
  rb01: 'rb-01-tasks-stuck',
  rb14: 'rb-14-autoscaling-lag',
  glossary: 'glossary',
} as const;

export type WikiSlug = (typeof WIKI_SLUGS)[keyof typeof WIKI_SLUGS];

/** The page that explains each signal (spec §8). */
export const SIGNAL_WIKI_PAGES = {
  'HM-001': WIKI_SLUGS.queueWait,
  'HM-003': WIKI_SLUGS.executorSlotSeconds,
  'HM-005': WIKI_SLUGS.concurrencyStack,
  'HM-006': WIKI_SLUGS.whyWorkWaits,
  'HM-008': WIKI_SLUGS.sensorSlotWaste,
  'HM-009': WIKI_SLUGS.scheduleCollisions,
  'HM-011': WIKI_SLUGS.workerCapacity,
  'HM-012': WIKI_SLUGS.workerCapacity,
  'HM-028': WIKI_SLUGS.healthScore,
} as const satisfies Record<string, WikiSlug>;

/** The best-practice page for each advisor rule (spec §13.6, FR-WIKI-06). */
export const RULE_WIKI_PAGES = {
  'REC-CAP-01': WIKI_SLUGS.advisorRules,
  'REC-CAP-05': WIKI_SLUGS.advisorRules,
  'REC-CAP-08': WIKI_SLUGS.advisorRules,
  'REC-CONC-01': WIKI_SLUGS.advisorRules,
  'REC-CONC-02': WIKI_SLUGS.advisorRules,
  'REC-CONC-03': WIKI_SLUGS.advisorRules,
  'REC-CONC-04': WIKI_SLUGS.advisorRules,
  'REC-DAG-01': WIKI_SLUGS.advisorRules,
  'REC-DAG-05': WIKI_SLUGS.advisorRules,
  'REC-SCHED-01': WIKI_SLUGS.advisorRules,
} as const satisfies Record<string, WikiSlug>;

export type AdvisorRuleId = keyof typeof RULE_WIKI_PAGES;

/** Runbooks written so far (spec §15.5). Alerts link to them by ID. */
export const RUNBOOK_WIKI_PAGES = {
  'RB-01': WIKI_SLUGS.rb01,
  'RB-14': WIKI_SLUGS.rb14,
} as const satisfies Record<string, WikiSlug>;

/**
 * A hash link to a wiki page without an environment, for static content such as the explanation
 * registry. Pages that have `linkTo` from their props should use it instead, to keep `?env=`.
 */
export const wikiHref = (slug: WikiSlug): string => linkTo({ page: 'wiki', slug }, null);
