/**
 * How DCAM computes things (spec §15.1): executor slot-seconds (HM-003), queue wait (HM-001), and
 * worker capacity and autoscaling (HM-011, HM-012). Facts: spec §2, §8.3, §8.9, §14.4 and Appendix D.
 */
import { callout, code, codeBlock, h2, link, p, strong, table, ul, type WikiPage } from '../model';
import { WIKI_SLUGS } from '../slugs';
import { COMPOSER_2_AND_3, LAST_VERIFIED, SOURCES } from '../sources';

export const executorSlotSeconds: WikiPage = {
  slug: WIKI_SLUGS.executorSlotSeconds,
  title: 'Executor slot-seconds',
  section: 'How DCAM computes things',
  summary:
    'How DCAM measures the worker capacity each DAG consumes, and why deferred time never counts (HM-003).',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [SOURCES.airflowPools, SOURCES.airflowRestApi],
  signals: ['HM-003'],
  related: [WIKI_SLUGS.pools, WIKI_SLUGS.workerCapacity, WIKI_SLUGS.sensorSlotWaste],
  body: [
    p(
      'Executor slot-seconds measure how much execution capacity a DAG consumed: the running time of its task instance tries, summed. ',
      'A running try occupies one worker slot, whatever its ',
      code('pool_slots'),
      '. The DAG league table ranks DAGs by their share of this total.',
    ),
    codeBlock(
      'text',
      'Executor slot-seconds (HM-003)',
      'executor slot-seconds = Σ (end − start) over task instance tries\n                         clipped to the selected range; running tries end at "now"',
    ),
    p(
      'DCAM computes it with an occupancy sweep over running intervals, and aggregates it per DAG, task, pool, team and environment. ',
      'Displays use slot-hours: 3,600 slot-seconds are 1 slot-hour.',
    ),
    h2('Two variants for two questions'),
    table(
      'Executor and pool slot-seconds',
      ['Variant', 'Formula', 'Use it for'],
      [
        ['Executor slot-seconds', 'Σ running time per try', 'Worker capacity and cost allocation'],
        [
          'Pool slot-seconds',
          [
            'Σ running time × ',
            code('pool_slots'),
            ', per pool; plus deferred time when the pool sets ',
            code('include_deferred'),
          ],
          [link(WIKI_SLUGS.pools, 'Pool'), ' contention'],
        ],
      ],
    ),
    h2('What never counts'),
    ul('Deferred time. The triggerer, not a worker slot, holds a deferred task.', [
      'Time in ',
      code('awaiting_input'),
      ' (Airflow 3.3 and later). It never occupies pool slots either.',
    ]),
    h2('Concentration'),
    p(
      'The figure "N of M DAGs = 80 % of slot-seconds" is the smallest number of DAGs whose combined slot-seconds reach 80 % of the total. ',
      'A small N means a few DAGs drive most of the load, so tuning them pays off first. The Gini coefficient summarises the same concentration in one number between 0 and 1.',
    ),
    h2('Caveats'),
    ul(
      [
        'Sensors in reschedule mode: Airflow keeps the first start date across reschedules, so end − start overstates occupancy. DCAM subtracts the time it observed in ',
        code('up_for_reschedule'),
        ' and labels the value approximate (⚠️ VERIFY in M1).',
      ],
      'Mapped tasks count every map index.',
      'A cost share based on slot-seconds is always labelled an estimate, with its method and price source (HM-021).',
    ),
  ],
};

export const queueWait: WikiPage = {
  slug: WIKI_SLUGS.queueWait,
  title: 'Queue wait',
  section: 'How DCAM computes things',
  summary: 'How long a task instance try waits for a worker after it is queued (HM-001).',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [SOURCES.airflowRestApi, SOURCES.composerMetrics, SOURCES.composerTroubleshootScheduling],
  signals: ['HM-001'],
  related: [WIKI_SLUGS.scheduledVsQueued, WIKI_SLUGS.whyWorkWaits, WIKI_SLUGS.workerCapacity],
  body: [
    p(
      'Queue wait is how long a task instance try waits after it is queued for the executor, until it starts.',
    ),
    codeBlock('text', 'Queue wait (HM-001)', 'queue wait = start_date − queued_when'),
    p(
      'Airflow records the queued time as ',
      code('queued_dttm'),
      '; the REST API exposes it as ',
      code('queued_when'),
      '.',
    ),
    h2('How DCAM computes it'),
    ul(
      'Exactly, per try, from finished task instances.',
      ['Live, for tries still queued: ', code('now − queued_when'), '.'],
      'Aggregated per pool, queue, DAG, task, hour of day and team, as p50, p95 and maximum, each with its sample count.',
      'A p95 needs at least 20 samples. With fewer, DCAM shows the maximum and marks it as a low sample.',
    ),
    h2('How to read it'),
    ul(
      [
        'Queue wait covers only the executor phase. Waiting before queueing, held back by pools, DAG limits or parallelism, is pre-queue wait: see ',
        link(WIKI_SLUGS.scheduledVsQueued, 'scheduled versus queued'),
        '.',
      ],
      [
        'A long queue wait while workers are at ',
        code('max_count'),
        ' points to ',
        link(WIKI_SLUGS.workerCapacity, 'worker capacity'),
        '. A long queue wait with free worker slots points to worker pickup.',
      ],
      [
        'Alert AL-06 fires when p95 queue wait reaches 10 minutes over 15 minutes (',
        link(WIKI_SLUGS.alertPack, 'default alert pack'),
        ').',
      ],
    ),
    h2('Cross-check and caveats'),
    ul(
      [
        "Cloud Monitoring's ",
        code('workflow/task_instance/queued_duration'),
        ' covers completed tries only. DCAM uses it as a cross-check and logs disagreements above 10 % as data-quality events.',
      ],
      'Sensors in reschedule mode re-enter the queue on each poke. Each poke counts.',
    ),
  ],
};

export const workerCapacity: WikiPage = {
  slug: WIKI_SLUGS.workerCapacity,
  title: 'Worker capacity and autoscaling',
  section: 'How DCAM computes things',
  summary:
    'Worker slot use against capacity, when an environment is capacity-bound (HM-011), and how fast workers follow demand (HM-012).',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [
    SOURCES.composerScaling,
    SOURCES.composerScaleEnvironments,
    SOURCES.composerOptimize,
    SOURCES.celeryConfig,
    SOURCES.composerMetrics,
  ],
  signals: ['HM-011', 'HM-012'],
  related: [WIKI_SLUGS.concurrencyStack, WIKI_SLUGS.rb14, WIKI_SLUGS.advisorRules],
  body: [
    h2('Capacity and utilisation (HM-011)'),
    codeBlock(
      'text',
      'Worker capacity',
      'capacity            = workers × worker_concurrency\ncapacity at maximum = max_count × worker_concurrency\nutilisation         = used ÷ capacity',
    ),
    ul(
      ['Used is ', code('executor/running_tasks'), ', cross-checked with live running task instances.'],
      [
        'When ',
        code('worker_concurrency'),
        ' is unknown, capacity = ',
        code('executor/open_slots'),
        ' + running tasks, inferred (HM-032).',
      ],
      [
        strong('Capacity-bound minutes'),
        ': workers = ',
        code('max_count'),
        ' and queued task instances ≥ max(10, 20 % of capacity).',
      ],
      [
        strong('Idle minimum'),
        ': utilisation p95 < 20 % in an hour while workers = ',
        code('min_count'),
        '.',
      ],
    ),
    h2('Autoscaling (HM-012)'),
    p(
      "Composer's autoscaler considers the current workers, queued Celery tasks, idle workers and ",
      code('worker_concurrency'),
      '. A high ',
      code('worker_concurrency'),
      ' can suppress scale-out, because few workers appear to have room (REC-CAP-08).',
    ),
    ul(
      'A scale-up episode starts when demand (running + queued Celery tasks) exceeds capacity. It ends when workers reach the autoscaler target or demand falls.',
      'Lag is the time to the first added worker, and the time to the target.',
      [
        'DCAM also reports the time at ',
        code('max_count'),
        ' per day, scale-down events, and failures within 5 minutes after them.',
      ],
      [
        code('worker/scale_factor_target'),
        ' is sampled every 30 s, so lags shorter than 2 sampling periods are reported as "below resolution".',
      ],
    ),
    h2('Composer 3 notes'),
    ul(
      'Composer 3 runs CeleryKubernetesExecutor. Tasks sent to the Kubernetes executor do not use Celery slots and are reported separately.',
      [
        'Unless you override it, Composer 3 derives ',
        code('celery.worker_concurrency'),
        " from the worker's CPU and memory, with a formula Google does not publish. Overrides must be between 1 and 24.",
      ],
      [
        "Google's guidance: concurrency should exceed peak concurrent tasks ÷ ",
        code('max_count'),
        ', and a value set too high can stop autoscaling from ever adding workers.',
      ],
      ['Worker counts (', code('minCount'), ' to ', code('maxCount'), ') are between 1 and 100.'],
      [
        'Workers can briefly drop below ',
        code('min_count'),
        ' during maintenance. DCAM flags these periods instead of treating them as misconfiguration.',
      ],
    ),
    callout(
      'verify',
      'Supported ceiling for worker_concurrency',
      'DCAM shows the ceiling ',
      code('min(24, 12 × worker vCPU, 8 × worker memory GB)'),
      " from Google's sizing guidance, next to the value it infers from metrics. Both are labelled. ⚠️ VERIFY the sizing guidance against the current documentation.",
    ),
    h2('Related rules, alerts and runbooks'),
    ul(
      [
        link(WIKI_SLUGS.advisorRules, 'REC-CAP-01, REC-CAP-05 and REC-CAP-08'),
        ': workers at maximum, under-packed workers, and scale-out suppressed by a high ',
        code('worker_concurrency'),
        '.',
      ],
      ['Alert AL-05: workers at maximum and at least 10 tasks queued for 15 minutes.'],
      [link(WIKI_SLUGS.rb14, 'RB-14: Autoscaling not keeping up'), '.'],
    ),
  ],
};
