/**
 * (i) explanations for the evidence panels of the bottlenecks page (FR-UI-05): top contributors, noisy
 * neighbours (HM-017), pool activity (FR-ENV-08) and priority fairness (HM-023).
 *
 * @implements FR-UI-05
 */
import type { Explanation } from '@dcam/ui-kit';
import { WIKI_SLUGS, wikiHref } from '../wiki/content/slugs';

const POOLS_DOC = {
  title: 'Airflow documentation: pools',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html',
};
const PRIORITY_DOC = {
  title: 'Airflow documentation: priority weights',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/priority-weight.html',
};

export const DEPTH_EXPLANATIONS = {
  'botl-top-contributors': {
    id: 'botl-top-contributors',
    wiki: { href: wikiHref(WIKI_SLUGS.whyWorkWaits) },
    title: 'Top contributors',
    summary: 'For the selected reason, the DAGs and the pools whose task instances waited the most.',
    whyItMatters: 'The few DAGs and pools at the top are where a change shortens the wait most.',
    formula:
      'share = waiting task-time of the DAG (or pool) for the reason ÷ all waiting task-time for the reason',
    howToRead:
      'The pool is the pool of the waiting task instance. For pool reasons it is the pool that was full; for worker reasons it only shows where the waiting work came from.',
    sources: ['SRC-AF-API'],
    caveats: [
      'Pre-queue waiting is measured only from DCAM’s own live snapshots; older history is not observed.',
    ],
  },
  'botl-noisy-neighbours': {
    id: 'botl-noisy-neighbours',
    wiki: { href: wikiHref(WIKI_SLUGS.whyWorkWaits) },
    title: 'Noisy neighbours',
    summary:
      'DAGs whose heavy running is associated with longer queue waits for other DAGs (HM-017). This is association, not proof of cause.',
    whyItMatters:
      'A DAG that fills worker slots at the same time every day can delay many others. Moving or capping it can help them all.',
    formula:
      'effect = median queue wait of other DAGs’ tries queued while the DAG held ≥ 10 % of worker slots − weighted median in matched minutes when it ran nothing (same hour of the week)',
    howToRead:
      'The interval is a bootstrap 95 % interval from 1,000 resamples. "High" means the interval stays above zero and almost all tries could be matched; "Low" means no clear association.',
    sources: ['SRC-AF-API', 'SRC-MON'],
    caveats: [
      'Only DAGs with at least 60 active minutes, 200 affected tries and 200 comparison tries are ranked.',
      'DAGs that share a schedule with the busy minutes can look associated; matching by hour of the week reduces this but does not remove it. Check the overlap windows.',
      'DCAM compares within the selected range (the specification uses 28 days); the bootstrap resamples at most 1,000 tries per group, so its interval is on the wide side.',
      'Ranking: effect × affected tries, the associated extra waiting in task-minutes.',
    ],
  },
  'botl-pools-activity': {
    id: 'botl-pools-activity',
    wiki: { href: wikiHref(WIKI_SLUGS.pools) },
    title: 'Pools',
    summary:
      'Per pool: slots, how many were used and queued, how much ready and queued work waited, when the pool starved, and which DAGs waited most (FR-ENV-08).',
    whyItMatters:
      'A pool that is full while work waits for it holds that work back no matter how many workers are free.',
    formula:
      'starved = time with zero open slots while ready work waited for the pool; running and queued slots are time-weighted means over the live snapshots',
    howToRead:
      'Ready work waits before it is queued (pre-queue); queued work waits for a worker. The bars show starved minutes per time bucket; an empty bucket had no snapshot.',
    sources: ['SRC-AF-API'],
    caveats: [
      'Deferred slots are not part of DCAM’s snapshots yet and are not shown.',
      'Each snapshot stands for the time until the next one, at most two cadences.',
    ],
    docs: [POOLS_DOC],
  },
  'botl-priority': {
    id: 'botl-priority',
    wiki: { href: wikiHref(WIKI_SLUGS.whyWorkWaits) },
    title: 'Priority fairness',
    summary:
      'Whether low-priority task instances wait longer than high-priority ones in the same pool (HM-023, observed part).',
    whyItMatters:
      'Airflow queues higher priority_weight first within a pool, so in a busy pool low-priority work can wait for a long time.',
    formula:
      'observed wait = last time a snapshot saw the try waiting − first time it was known to be ready or queued; bands are the low, middle and high thirds of the weights in the pool',
    howToRead:
      'Compare the bands of one pool. A p95 marked "≤" comes from fewer than 20 tries and is the maximum.',
    sources: ['SRC-AF-API'],
    caveats: [
      'The observed wait is a lower bound at snapshot resolution; tries that waited less than one cadence may not be seen.',
      'The starvation ratio (current p95 ÷ the band’s 28-day median) is not computed yet.',
      '⚠️ DCAM uses the weight the API reports per task instance; that it is the effective weight for every weight_rule is not verified yet.',
    ],
    docs: [PRIORITY_DOC, POOLS_DOC],
  },
} as const satisfies Record<string, Explanation>;
