/**
 * Concepts (spec §15.1): the concurrency stack, pools, and scheduled versus queued.
 * Facts: spec §2 (Composer 3 limits), §6.2, §7.5, HM-001, HM-003, HM-005, HM-006, §14.3, §14.4, §15.3
 * and Appendix D.
 */
import { callout, code, codeBlock, h2, link, p, table, ul, type WikiPage } from '../model';
import { WIKI_SLUGS } from '../slugs';
import { COMPOSER_2_AND_3, LAST_VERIFIED, SOURCES } from '../sources';

export const concurrencyStack: WikiPage = {
  slug: WIKI_SLUGS.concurrencyStack,
  title: 'The concurrency stack',
  section: 'Concepts',
  summary:
    'The limits between "a task is ready" and "a task runs": parallelism, pools, DAG and task limits, and worker slots.',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2.11; Airflow 3 differences noted' },
  lastVerified: LAST_VERIFIED,
  sources: [
    SOURCES.airflowConfig,
    SOURCES.celeryConfig,
    SOURCES.airflowPools,
    SOURCES.composerAirflowConfigurations,
    SOURCES.composerOptimize,
    SOURCES.airflowScheduler211,
  ],
  signals: ['HM-005'],
  related: [WIKI_SLUGS.pools, WIKI_SLUGS.whyWorkWaits, WIKI_SLUGS.workerCapacity],
  body: [
    p(
      "A task instance whose upstream tasks are done doesn't always start right away. Several limits stand between ready and running. ",
      'Each one caps how many task instances can run at the same time. The lowest one at a given moment is the ',
      link(WIKI_SLUGS.whyWorkWaits, 'binding limit'),
      ': raising any other limit changes nothing until that one moves.',
    ),
    codeBlock(
      'text',
      'Effective concurrency, evaluated per scope and per minute',
      'effective concurrency = min(core.parallelism × schedulers,\n                            executor slots,\n                            open pool slots,\n                            DAG and task limits …)',
    ),
    h2('The limits, from the environment down to the task'),
    table(
      'Limits in the concurrency stack, with their defaults',
      ['Limit', 'Scope', 'Airflow default', 'Composer default', 'What it caps'],
      [
        [
          code('core.parallelism'),
          'Per scheduler',
          '32',
          'Matches the maximum worker concurrency',
          'Running task instances per scheduler',
        ],
        [
          'Pool slots',
          'Per pool',
          [code('default_pool'), ': 128 (', code('core.default_pool_task_slot_count'), ')'],
          '―',
          ['Running task instances in the pool, each weighted by its ', code('pool_slots')],
        ],
        [
          [code('max_active_runs'), ' (DAG)'],
          'Per DAG',
          ['16 (', code('core.max_active_runs_per_dag'), ')'],
          '25',
          'Concurrent runs of the DAG',
        ],
        [
          [code('max_active_tasks'), ' (DAG)'],
          'Per DAG on Airflow 2, per DAG run on Airflow 3',
          ['16 (', code('core.max_active_tasks_per_dag'), ')'],
          '16',
          'Running and queued task instances of the DAG',
        ],
        [
          [code('max_active_tis_per_dag'), ', ', code('max_active_tis_per_dagrun')],
          'Per task',
          '―',
          '―',
          'Running and queued tries of one task',
        ],
        [
          'Executor slots',
          'Environment',
          [code('celery.worker_concurrency'), ' 16 per worker'],
          [code('auto'), ' on Composer 3 (calculated by Composer); override range 1–24'],
          ['Running Celery task instances: workers × ', code('worker_concurrency')],
        ],
      ],
    ),
    p(
      "The order in which Airflow's scheduler checks these limits decides which one DCAM reports as binding. See ",
      link(WIKI_SLUGS.whyWorkWaits, 'why work waits'),
      ' for the full decision table.',
    ),
    h2('Parallelism applies per scheduler'),
    p(
      'In each loop, the Airflow 2.11 scheduler caps the batch it queues at ',
      code('min(max_tis_per_query, parallelism − executor slots occupied)'),
      '. When the cap is zero, nothing is queued. With two schedulers, the global limit is twice ',
      code('core.parallelism'),
      '.',
    ),
    p(
      "Composer's default for ",
      code('core.parallelism'),
      ' matches the maximum worker concurrency (⚠️ VERIFY for Airflow 3). Composer 3 neither blocks nor limits overrides of ',
      code('[core] parallelism'),
      '.',
    ),
    h2('Pools'),
    p(
      'A pool caps concurrency across DAGs for one kind of work. A running task instance occupies ',
      code('pool_slots'),
      ' slots of its pool. See ',
      link(WIKI_SLUGS.pools, 'pools'),
      '.',
    ),
    h2('DAG and task limits'),
    ul(
      [
        code('max_active_runs'),
        " is enforced when runs start: the scheduler doesn't start a queued run while the DAG already has that many running runs.",
      ],
      [
        code('max_active_tasks'),
        ' counts running and queued task instances. On Airflow 2 it counts them across all active runs of the DAG. On Airflow 3 it counts them per DAG run, so a DAG with several active runs can use up to ',
        code('max_active_runs × max_active_tasks'),
        ' slots.',
      ],
      [
        'Task-level limits (',
        code('max_active_tis_per_dag'),
        ', ',
        code('max_active_tis_per_dagrun'),
        ') count running and queued tries of one task. From Airflow 3.2.2 deferred tries also count, and from 3.3 awaiting-input tries.',
      ],
      'On Airflow 2.11 only running and queued tries count towards these limits. Deferred tries do not.',
    ),
    p(
      'DCAM measures how often a DAG is held back by its own limits as DAG self-throttling (HM-005): the minutes in which the DAG is at ',
      code('max_active_tasks'),
      ' while it has ready work that is not queued, divided by the minutes the DAG was active.',
    ),
    h2('Worker slots'),
    p(
      'Executor slots = workers × ',
      code('celery.worker_concurrency'),
      '. The ceiling for planning is ',
      code('max_count × worker_concurrency'),
      '. See ',
      link(WIKI_SLUGS.workerCapacity, 'worker capacity and autoscaling'),
      '.',
    ),
    callout(
      'info',
      'A limit that can never bind',
      'A limit above every limit upstream of it never binds, for example a DAG ',
      code('max_active_tasks'),
      " above the environment's capacity. Raising it has no effect; find the limit that binds instead.",
    ),
  ],
};

export const pools: WikiPage = {
  slug: WIKI_SLUGS.pools,
  title: 'Pools',
  section: 'Concepts',
  summary: 'How pools cap concurrency for a kind of work, what pool_slots does, and how a pool starves.',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [SOURCES.airflowPools, SOURCES.airflowConfig, SOURCES.airflowRestApi, SOURCES.composerMetrics],
  related: [WIKI_SLUGS.concurrencyStack, WIKI_SLUGS.whyWorkWaits, WIKI_SLUGS.advisorRules],
  body: [
    p(
      'A pool is a named limit on how many task instances can run at the same time, across DAGs. ',
      'Each pool has a number of slots, and a running task instance occupies ',
      code('pool_slots'),
      ' slots of its pool.',
    ),
    p(
      'Airflow creates ',
      code('default_pool'),
      ' with ',
      code('core.default_pool_task_slot_count'),
      ' slots, 128 by default. When most work runs in ',
      code('default_pool'),
      ', one busy workload can starve all the others.',
    ),
    h2('When a pool holds work back'),
    table(
      'Pool reasons in why work waits',
      ['Reason', 'Condition', 'Resolves on its own?'],
      [
        [
          link(WIKI_SLUGS.whyWorkWaits, 'Pool does not exist'),
          [
            'The task names a pool that is not defined. Airflow 2.11 reports a DAG warning of type ',
            code('non-existent pool'),
            '.',
          ],
          'No: create the pool or fix the task',
        ],
        [
          link(WIKI_SLUGS.whyWorkWaits, 'Task larger than its pool'),
          ["The task's ", code('pool_slots'), " exceed the pool's total slots, so it can never run."],
          ['No: raise the pool size or lower ', code('pool_slots')],
        ],
        [
          link(WIKI_SLUGS.whyWorkWaits, 'Pool exhausted'),
          [
            "The pool's open slots are fewer than the task's ",
            code('pool_slots'),
            ', including zero open slots.',
          ],
          'Yes, when running tasks in the pool finish',
        ],
      ],
    ),
    p(
      'If every pool is full, the Airflow 2.11 scheduler queues nothing in that loop. Otherwise it also caps the batch at the free pool slots.',
    ),
    h2('Priority when slots are scarce'),
    p(
      'When slots are scarce, the scheduler considers scheduled task instances in order of ',
      code('priority_weight'),
      ' (highest first), then logical date, then map index. ',
      'Low-priority work can then wait much longer than usual while higher-priority work runs. DCAM flags it when it waits at least 3 × its median queue wait (REC-CONC-04).',
    ),
    h2('Pool slot-seconds'),
    p(
      'Pool slot-seconds = Σ running time × ',
      code('pool_slots'),
      ', per pool. When the pool counts deferred tasks (',
      code('include_deferred'),
      '), deferred time is added. Use them for pool contention; ',
      link(WIKI_SLUGS.executorSlotSeconds, 'executor slot-seconds'),
      ' measure worker capacity instead.',
    ),
    h2('What DCAM watches'),
    ul(
      [
        'Live pool counts from ',
        code('GET /pools'),
        ': running, queued, scheduled, open and deferred slots for every pool, in one request.',
      ],
      ['The Cloud Monitoring metrics ', code('pool/open_slots'), ' and ', code('pool/starving_tasks'), '.'],
      [
        'Pool starvation (',
        link(WIKI_SLUGS.advisorRules, 'REC-CONC-02'),
        '): zero open slots with queued or scheduled work for at least 30 minutes a day.',
      ],
      [
        code('default_pool'),
        ' overload (',
        link(WIKI_SLUGS.advisorRules, 'REC-CONC-03'),
        '): at least 70 % of slot-seconds run in ',
        code('default_pool'),
        ' and it starves.',
      ],
      [
        'Alert AL-15 (',
        link(WIKI_SLUGS.alertPack, 'default alert pack'),
        '): a pool has no open slots with queued work for 30 minutes.',
      ],
    ),
  ],
};

export const scheduledVsQueued: WikiPage = {
  slug: WIKI_SLUGS.scheduledVsQueued,
  title: 'Scheduled versus queued',
  section: 'Concepts',
  summary:
    'Two waiting states with different owners: the scheduler holds scheduled work, the executor and workers hold queued work.',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2.11; Airflow 3 differences noted' },
  lastVerified: LAST_VERIFIED,
  sources: [
    SOURCES.airflowRestApi,
    SOURCES.airflowConfig,
    SOURCES.composerAirflowConfigurations,
    SOURCES.composerTroubleshootScheduling,
  ],
  related: [WIKI_SLUGS.queueWait, WIKI_SLUGS.whyWorkWaits, WIKI_SLUGS.rb01],
  body: [
    p(
      'A task instance moves through states such as ',
      code('none'),
      ' → ',
      code('scheduled'),
      ' → ',
      code('queued'),
      ' → ',
      code('running'),
      ' → ',
      code('success'),
      ', ',
      code('failed'),
      ', ',
      code('up_for_retry'),
      ' or ',
      code('deferred'),
      '. Work waits in three of them, and each has a different owner.',
    ),
    table(
      'Waiting states and who holds them',
      ['State', 'Held by', 'Waits for', 'How DCAM measures it'],
      [
        [
          code('scheduled'),
          'The scheduler (pre-queue)',
          'DAG limits, pools and parallelism',
          'From live snapshots, while the work waits',
        ],
        [
          code('queued'),
          'The executor and workers (post-queue)',
          'A free worker slot',
          [link(WIKI_SLUGS.queueWait, 'Queue wait'), ': ', code('start_date − queued_when')],
        ],
        [
          code('deferred'),
          'The triggerer',
          'An external event; the worker slot is released',
          'Deferral phase of why work waits',
        ],
      ],
    ),
    h2('Why the difference matters'),
    p(
      'Work that waits in ',
      code('scheduled'),
      ' is held back by a limit the scheduler enforces, so more workers usually do not help. ',
      'Work that waits in ',
      code('queued'),
      ' has passed every scheduler check and waits for a worker, so raising a pool or DAG limit usually does not help. ',
      link(WIKI_SLUGS.whyWorkWaits, 'Why work waits'),
      ' names the exact limit.',
    ),
    h2('What can be measured afterwards'),
    ul(
      [
        'Airflow 2.11 records no timestamp for entering ',
        code('scheduled'),
        '. DCAM measures pre-queue wait only from its own live snapshots, taken while the work waits. Older history shows the pre-queue share as "not observed".',
      ],
      [
        "Airflow 3's REST API v2 returns ",
        code('scheduled_when'),
        ' on task instances. When it is populated, DCAM uses it (⚠️ VERIFY that Composer builds populate it, VC-12).',
      ],
      ['The REST API exposes the time a try was queued as ', code('queued_when'), '.'],
      'Sensors in reschedule mode re-enter the queue on each poke, so each poke counts as a separate queue wait.',
    ),
    h2('Queued for too long'),
    p(
      code('scheduler.task_queued_timeout'),
      ' fails task instances that stay queued longer than its value: 600 s in Airflow, 2,400 s by default on Composer.',
    ),
  ],
};
