/**
 * The advisor rules of feature 001 as wiki content: when each one triggers and what it suggests
 * (spec §13.6, thresholds as defaults). The best-practice page renders this list, and
 * `RULE_WIKI_PAGES` links each rule back to it (FR-WIKI-06).
 *
 * @implements FR-WIKI-06
 */
import { code, type Rich } from './model';
import { WIKI_SLUGS, type AdvisorRuleId, type WikiSlug } from './slugs';

export type RuleCategory =
  'Capacity and autoscaling' | 'Concurrency limits and pools' | 'DAG design' | 'Schedules';

export interface AdvisorRule {
  readonly id: AdvisorRuleId;
  readonly category: RuleCategory;
  readonly title: string;
  readonly trigger: Rich;
  readonly action: Rich;
  /** The concept or signal page that explains what the rule measures. */
  readonly learnMore: WikiSlug;
}

export const ADVISOR_RULES: readonly AdvisorRule[] = [
  {
    id: 'REC-CAP-01',
    category: 'Capacity and autoscaling',
    title: 'Workers at maximum while tasks are queued',
    trigger: [
      'Workers = ',
      code('max_count'),
      ' and executor-queued task instances ≥ max(10, 20 % of slots) for at least 15 minutes in 24 hours (60 minutes on dev). Critical from 120 minutes.',
    ],
    action: [
      'Stagger schedules if the peaks are schedule-driven. Otherwise raise ',
      code('max_count'),
      ', or raise ',
      code('worker_concurrency'),
      ' where CPU and memory allow.',
    ],
    learnMore: WIKI_SLUGS.workerCapacity,
  },
  {
    id: 'REC-CAP-05',
    category: 'Capacity and autoscaling',
    title: 'Under-packed workers',
    trigger: ['Executor slots exhausted while worker CPU p95 < 30 % and memory p95 < 40 %.'],
    action: [
      'Raise ',
      code('worker_concurrency'),
      ' for I/O-bound workloads, within the Composer 3 range (1–24) and the supported ceiling. REC-CAP-01 takes precedence when both apply.',
    ],
    learnMore: WIKI_SLUGS.workerCapacity,
  },
  {
    id: 'REC-CAP-08',
    category: 'Capacity and autoscaling',
    title: 'Scale-out suppressed by a high worker_concurrency',
    trigger: [
      'Workers < ',
      code('max_count'),
      ' and the scale target stays at the current worker count, while worker CPU or memory p95 ≥ 85 % with slots mostly occupied, and ',
      code('worker_concurrency'),
      ' is above the supported ceiling.',
    ],
    action: [
      'Lower ',
      code('worker_concurrency'),
      ' towards the ceiling so that the autoscaler adds workers. For many short tasks, raise ',
      code('min_count'),
      ' instead.',
    ],
    learnMore: WIKI_SLUGS.workerCapacity,
  },
  {
    id: 'REC-CONC-01',
    category: 'Concurrency limits and pools',
    title: 'Global parallelism is binding',
    trigger: [
      'Total ',
      code('core.parallelism'),
      ' (per scheduler × schedulers) < ',
      code('max_count'),
      ' × ',
      code('worker_concurrency'),
      ', and "global parallelism" explains at least 20 % of waiting task-minutes.',
    ],
    action: ['Raise ', code('core.parallelism'), '.'],
    learnMore: WIKI_SLUGS.concurrencyStack,
  },
  {
    id: 'REC-CONC-02',
    category: 'Concurrency limits and pools',
    title: 'Pool starvation',
    trigger: ['A pool has zero open slots with queued or scheduled work for at least 30 minutes a day.'],
    action: [
      'Raise the pool slots, split the pool by workload class, or review ',
      code('pool_slots'),
      ' per task.',
    ],
    learnMore: WIKI_SLUGS.pools,
  },
  {
    id: 'REC-CONC-03',
    category: 'Concurrency limits and pools',
    title: 'default_pool overload',
    trigger: ['At least 70 % of slot-seconds run in ', code('default_pool'), ', and it starves.'],
    action: ['Introduce dedicated pools per workload class or team.'],
    learnMore: WIKI_SLUGS.pools,
  },
  {
    id: 'REC-CONC-04',
    category: 'Concurrency limits and pools',
    title: 'Priority starvation',
    trigger: ['Low-priority DAGs wait at least 3 × their median queue wait while higher-priority work runs.'],
    action: ['Adjust ', code('priority_weight'), ' and ', code('weight_rule'), ', or separate pools.'],
    learnMore: WIKI_SLUGS.pools,
  },
  {
    id: 'REC-DAG-01',
    category: 'DAG design',
    title: 'DAG throttled by max_active_tasks',
    trigger: [
      'The DAG is at its ',
      code('max_active_tasks'),
      ' limit for at least 10 % of its active time, with its own tasks waiting (HM-005).',
    ],
    action: ['Raise ', code('max_active_tasks'), ' if the environment has headroom.'],
    learnMore: WIKI_SLUGS.concurrencyStack,
  },
  {
    id: 'REC-DAG-05',
    category: 'DAG design',
    title: 'Sensor slot waste',
    trigger: ['A poke-mode sensor or long-waiting task uses at least 1 slot-hour a day (HM-008).'],
    action: ['Use ', code('mode="reschedule"'), ' or a deferrable operator.'],
    learnMore: WIKI_SLUGS.sensorSlotWaste,
  },
  {
    id: 'REC-SCHED-01',
    category: 'Schedules',
    title: 'Schedule collisions',
    trigger: [
      'At least 20 % of daily scheduled starts fall in one minute-of-hour, and that minute coincides with queueing (HM-009, HM-006).',
    ],
    action: ['Stagger the colliding schedules.'],
    learnMore: WIKI_SLUGS.scheduleCollisions,
  },
];

export const RULE_CATEGORIES: readonly RuleCategory[] = [
  'Capacity and autoscaling',
  'Concurrency limits and pools',
  'DAG design',
  'Schedules',
];
