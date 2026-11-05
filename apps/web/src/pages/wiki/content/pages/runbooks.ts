/**
 * Runbooks (spec §15.4, §15.5) in the order symptoms → checks → likely causes → fixes → links
 * (FR-WIKI-05). Checks reuse signal definitions; pre-evaluating them for a finding's scope arrives
 * with findings (FR-WIKI-05 acceptance). Facts: HM-006, HM-011, HM-012, §13.1, §13.5, §13.6, §14.4.
 *
 * @implements FR-WIKI-05
 */
import { callout, code, codeBlock, link, p, runbookBody, ul, type WikiPage } from '../model';
import { WIKI_SLUGS } from '../slugs';
import { COMPOSER_2_AND_3, LAST_VERIFIED, SOURCES } from '../sources';

const RESTART_NOTE = callout(
  'warning',
  'Before you apply a change',
  'Environment updates can restart components and take a while to complete. Apply production changes in a maintenance window, and note the previous value so you can roll back (⚠️ VERIFY which updates restart which components on Composer 3).',
);

export const rb01: WikiPage = {
  slug: WIKI_SLUGS.rb01,
  title: 'RB-01: Tasks stuck in queued or scheduled',
  section: 'Runbooks',
  summary: 'Queued task instances grow, runs start late, or workers sit idle while tasks wait.',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [
    SOURCES.composerTroubleshootScheduling,
    SOURCES.composerOptimize,
    SOURCES.composerAirflowConfigurations,
    SOURCES.airflowPools,
  ],
  runbook: {
    id: 'RB-01',
    relatedRules: ['REC-CAP-01', 'REC-CONC-01', 'REC-CONC-02', 'REC-DAG-01', 'REC-SCHED-01'],
  },
  body: runbookBody({
    symptoms: [
      'Queued task instances grow.',
      'Runs start late.',
      'Workers sit idle while tasks wait.',
      [
        'Alerts AL-05 (tasks queued while workers are at maximum), AL-06 (queue wait high) or AL-15 (pool starvation) fire.',
      ],
    ],
    checks: [
      {
        question: 'Which limit is binding?',
        signal: 'HM-006',
        how: [
          'Open Bottlenecks and read the answer line and the stacked chart of ',
          link(WIKI_SLUGS.whyWorkWaits, 'waiting task-minutes by reason'),
          '. The check passes when "unknown" explains less than 20 % of waiting task-minutes.',
        ],
      },
      {
        question: 'Are workers at max_count?',
        signal: 'HM-011',
        how: [
          'Look for ',
          link(WIKI_SLUGS.workerCapacity, 'capacity-bound minutes'),
          '. The check passes when there were no minutes at the maximum.',
        ],
      },
      {
        question: 'Is a pool starving?',
        signal: 'HM-006 reason 5',
        how: [
          'Look for a ',
          link(WIKI_SLUGS.pools, 'pool'),
          ' with zero open slots while it has queued or scheduled work.',
        ],
      },
      {
        question: 'Is the scheduler heartbeating?',
        signal: 'composer.scheduler_heartbeat',
        how: ['The check passes when the heartbeat has no gaps.'],
      },
      {
        question: 'Is the triggerer at capacity?',
        signal: 'HM-022',
        how: ['Only for deferred tasks: running triggers at 95 % or more of capacity hold resumption back.'],
      },
    ],
    causes: [
      [
        'Executor slots exhausted: workers are at ',
        code('max_count'),
        ' and every slot is busy (reason 10).',
      ],
      [
        'Autoscaling lag: slots are full and workers are being added, but not yet ready (reason 9). See ',
        link(WIKI_SLUGS.rb14, 'RB-14'),
        '.',
      ],
      [
        "Pool exhausted: the pool's open slots are fewer than the task's ",
        code('pool_slots'),
        ' (reason 5).',
      ],
      ['DAG ', code('max_active_tasks'), ': a fan-out DAG caps itself (reason 6).'],
      [
        'Global parallelism: ',
        code('core.parallelism'),
        ' × schedulers is below the worker capacity (reason 4).',
      ],
      [
        link(WIKI_SLUGS.scheduleCollisions, 'Schedule collisions'),
        ': many runs start in the same minute, often at round hours.',
      ],
      'Scheduler throughput: no limit applies, yet tries are not queued within 30 s of being ready (reason 8).',
      "Worker pickup: worker slots are free, but tries stay queued for 60 s or more, or no worker consumes the task's queue (reason 11).",
    ],
    fixes: [
      ul(
        [
          'Peaks driven by schedules: stagger the colliding schedules (',
          link(WIKI_SLUGS.advisorRules, 'REC-SCHED-01'),
          ').',
        ],
        [
          'Workers at maximum: raise ',
          code('max_count'),
          ', or raise ',
          code('worker_concurrency'),
          ' where CPU and memory allow (',
          link(WIKI_SLUGS.advisorRules, 'REC-CAP-01'),
          ').',
        ],
        [
          'A starving pool: raise its slots, split it by workload class, or review ',
          code('pool_slots'),
          ' per task (',
          link(WIKI_SLUGS.advisorRules, 'REC-CONC-02'),
          ').',
        ],
        [
          'A DAG throttled by its own limit: raise ',
          code('max_active_tasks'),
          ' if the environment has headroom (',
          link(WIKI_SLUGS.advisorRules, 'REC-DAG-01'),
          ').',
        ],
        [
          'Parallelism below capacity: raise ',
          code('core.parallelism'),
          ' (',
          link(WIKI_SLUGS.advisorRules, 'REC-CONC-01'),
          ').',
        ],
        'Scheduler throughput: add schedulers or scheduler resources.',
      ),
      p(
        'Airflow configuration overrides use ',
        code('section-key'),
        ' names. For example, on the fictitious environment ',
        code('acme-prod'),
        ':',
      ),
      codeBlock(
        'bash',
        'Raise core.parallelism with gcloud (example value)',
        'gcloud composer environments update acme-prod \\\n  --location europe-west1 \\\n  --update-airflow-configs=core-parallelism=64',
      ),
      RESTART_NOTE,
    ],
    links: [
      [link(WIKI_SLUGS.whyWorkWaits, 'Why work waits'), ': the 13 reasons and their order.'],
      [link(WIKI_SLUGS.concurrencyStack, 'The concurrency stack'), ': what each limit controls.'],
      [link(WIKI_SLUGS.scheduledVsQueued, 'Scheduled versus queued'), ': who holds waiting work.'],
      [
        link(WIKI_SLUGS.advisorRules, 'Advisor rules'),
        ': REC-CAP-01, REC-CONC-01, REC-CONC-02, REC-DAG-01, REC-SCHED-01.',
      ],
    ],
  }),
};

export const rb14: WikiPage = {
  slug: WIKI_SLUGS.rb14,
  title: 'RB-14: Autoscaling not keeping up',
  section: 'Runbooks',
  summary: 'Tasks queue at peaks while workers are added too slowly, or workers stay at their maximum.',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [
    SOURCES.composerScaling,
    SOURCES.composerScaleEnvironments,
    SOURCES.composerOptimize,
    SOURCES.celeryConfig,
  ],
  runbook: { id: 'RB-14', relatedRules: ['REC-CAP-01', 'REC-CAP-06', 'REC-CAP-08'] },
  body: runbookBody({
    symptoms: [
      'Queued tasks grow at recurring peaks while the worker count is still rising.',
      ['Workers reach ', code('max_count'), ' and stay there while tasks are queued.'],
      'The worker count stays flat while slots are full and CPU or memory is high.',
    ],
    checks: [
      {
        question: 'How long is the scale-up lag?',
        signal: 'HM-012',
        how: [
          'Read the lag to the first added worker and to the target, at recurring peaks. Lags shorter than 2 sampling periods are below resolution.',
        ],
      },
      {
        question: 'How long are workers at max_count?',
        signal: 'HM-011, HM-012',
        how: ['Read the time at ', code('max_count'), ' per day and the capacity-bound minutes.'],
      },
      {
        question: 'How much work queues during scale-up?',
        signal: 'HM-006 reason 9',
        how: [
          'Read the share of waiting task-minutes attributed to ',
          link(WIKI_SLUGS.whyWorkWaits, 'autoscaling lag'),
          '.',
        ],
      },
      {
        question: 'Is worker_concurrency above the supported ceiling?',
        signal: 'HM-027',
        how: [
          'Compare it with ',
          code('min(24, 12 × worker vCPU, 8 × worker memory GB)'),
          ' (⚠️ VERIFY the sizing guidance).',
        ],
      },
    ],
    causes: [
      [
        link(WIKI_SLUGS.scheduleCollisions, 'Schedule collisions'),
        ': many runs start in the same minute, and new workers take minutes to become ready.',
      ],
      ['The peak needs more than ', code('max_count × worker_concurrency'), ' slots.'],
      [
        'A high ',
        code('worker_concurrency'),
        ' suppresses scale-out: few workers appear to have room, so the autoscaler adds none.',
      ],
      ['Peaks are frequent and ', code('min_count'), ' is low, so every peak starts with a scale-up.'],
    ],
    fixes: [
      ul(
        [
          'Stagger schedules (',
          link(WIKI_SLUGS.advisorRules, 'REC-SCHED-01'),
          '). REC-CAP-06 (autoscaling lag p95 ≥ 5 min at recurring peaks) suggests the same first.',
        ],
        ['Raise ', code('min_count'), ' if peaks are frequent, or smooth bursts with pools (REC-CAP-06).'],
        [
          'Raise ',
          code('max_count'),
          ', or raise ',
          code('worker_concurrency'),
          ' where CPU and memory allow (',
          link(WIKI_SLUGS.advisorRules, 'REC-CAP-01'),
          ').',
        ],
        [
          'Lower ',
          code('worker_concurrency'),
          ' towards the ceiling so that the autoscaler adds workers. For many short tasks, raise ',
          code('min_count'),
          ' instead (',
          link(WIKI_SLUGS.advisorRules, 'REC-CAP-08'),
          ').',
        ],
      ),
      codeBlock(
        'bash',
        'Raise the worker maximum with gcloud (example value)',
        'gcloud composer environments update acme-prod \\\n  --location europe-west1 \\\n  --max-workers 8',
      ),
      p(
        'A higher maximum increases peak cost. More concurrent tasks also increase the load on the metadata database and on external systems.',
      ),
      RESTART_NOTE,
    ],
    links: [
      [
        link(WIKI_SLUGS.workerCapacity, 'Worker capacity and autoscaling'),
        ': how DCAM measures lag and capacity.',
      ],
      [
        link(WIKI_SLUGS.rb01, 'RB-01: Tasks stuck in queued or scheduled'),
        ': when the binding limit is not the workers.',
      ],
      [link(WIKI_SLUGS.advisorRules, 'Advisor rules'), ': REC-CAP-01, REC-CAP-08 and REC-SCHED-01.'],
    ],
  }),
};
