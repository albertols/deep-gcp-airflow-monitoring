/**
 * Explanation registry for the (i) pattern (spec §12.9). M0 keeps entries here; from M2 they move to
 * the metrics pack next to each signal definition (ADR-0011).
 *
 * @implements FR-UI-05
 */
import type { Explanation } from '@dcam/ui-kit';

const POOLS_DOC = {
  title: 'Airflow documentation: pools',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html',
};
const OPTIMIZE_DOC = {
  title: 'Managed Airflow (Gen 3): optimize environment performance',
  url: 'https://docs.cloud.google.com/composer/docs/composer-3/optimize-environments',
};

export const EXPLANATIONS = {
  'hm-003-slot-seconds': {
    id: 'hm-003-slot-seconds',
    title: 'Executor slot-hours',
    summary: 'Total time task instance tries held a worker slot in the selected range, in hours.',
    whyItMatters:
      'The best available measure of how much worker capacity the environment, or a DAG, consumes.',
    formula: 'Σ (end − start) over task instance tries, clipped to the range; running tries end at "now"',
    sources: ['SRC-AF-API'],
    freshness: '≤ 2 × the task instance cadence (60 s by default)',
    caveats: [
      'Deferred time is excluded: the triggerer, not a worker slot, holds a deferred task.',
      'Pool slot-seconds (weighted by pool_slots) are a separate measure, used for pool contention.',
    ],
    docs: [POOLS_DOC],
  },
  'hm-011-peak-concurrency': {
    id: 'hm-011-peak-concurrency',
    title: 'Peak concurrency',
    summary:
      'The highest number of task instance tries running at the same time, in any minute of the range.',
    whyItMatters:
      'Compare it with the worker slots (workers × worker_concurrency) to see how close the environment came to its ceiling.',
    sources: ['SRC-AF-API'],
    freshness: '≤ 2 × the task instance cadence',
    docs: [OPTIMIZE_DOC],
  },
  'fr-dagx-03-pareto': {
    id: 'fr-dagx-03-pareto',
    title: 'DAGs using 80 % of capacity',
    summary: 'The smallest number of DAGs whose combined slot-hours reach 80 % of the environment total.',
    whyItMatters: 'A small number means a few DAGs drive most of the load: tuning them pays off first.',
    howToRead: 'Compare it with the number of active DAGs. 20 of 2,000 is a strong concentration.',
    sources: ['SRC-AF-API'],
  },
  'top-dags': {
    id: 'top-dags',
    title: 'Top DAGs by slot-hours',
    summary:
      'The ten DAGs that consumed the most executor slot-hours in the range, with their share of the total.',
    howToRead:
      'Shares matter more than absolute hours. The full league table with filters arrives in milestone M2.',
    sources: ['SRC-AF-API'],
    docs: [POOLS_DOC],
  },
} as const satisfies Record<string, Explanation>;

export type ExplanationId = keyof typeof EXPLANATIONS;
