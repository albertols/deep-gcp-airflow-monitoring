/**
 * How DCAM computes things (spec §15.1): why work waits (HM-006), schedule collisions (HM-009) and
 * sensor slot waste (HM-008). Facts: spec §8.3, §8.4, §13.5 and the "calls made" of feature 001.
 */
import { callout, code, codeBlock, h2, link, ol, p, table, ul, type WikiPage } from '../model';
import { WIKI_SLUGS } from '../slugs';
import { COMPOSER_2_AND_3, LAST_VERIFIED, SOURCES } from '../sources';

export const whyWorkWaits: WikiPage = {
  slug: WIKI_SLUGS.whyWorkWaits,
  title: 'Why work waits',
  section: 'How DCAM computes things',
  summary:
    'How DCAM attributes each waiting minute to the limit that binds (HM-006), with the 13 reasons in the order it checks them.',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2.11 (scheduler-order@2.11)' },
  lastVerified: LAST_VERIFIED,
  sources: [
    SOURCES.airflowScheduler211,
    SOURCES.airflowRestApi,
    SOURCES.airflowPools,
    SOURCES.airflowConfig,
    SOURCES.composerTroubleshootScheduling,
  ],
  signals: ['HM-006'],
  related: [WIKI_SLUGS.concurrencyStack, WIKI_SLUGS.scheduledVsQueued, WIKI_SLUGS.rb01],
  body: [
    p(
      'For each minute, DCAM attributes waiting time to the limit that prevented work from running: the binding limit. ',
      'The Bottlenecks page stacks these waiting task-minutes by reason and lists the top contributors for each.',
    ),
    h2('What counts as waiting'),
    ul(
      ['Run waiting: a DAG run in state ', code('queued'), '.'],
      'Task waiting: a task instance whose upstream dependencies are satisfied, but which is not running.',
    ),
    p('Task waiting has three phases:'),
    table(
      'Phases of task waiting',
      ['Phase', 'From → to', 'Who acts'],
      [
        ['Pre-queue', 'Ready → queued', 'The scheduler checks DAG limits, pools and parallelism'],
        ['Post-queue', 'Queued → running', 'The executor and workers'],
        ['Deferral', 'Deferred → resumed', 'The triggerer'],
      ],
    ),
    h2('Ready time'),
    ul(
      [
        "Airflow 3's REST API v2 returns ",
        code('scheduled_when'),
        " on task instances. When it is populated, DCAM uses the scheduler's own timestamp.",
      ],
      [
        'On Airflow 2 it is inferred as ',
        code('max(run start, latest end of direct upstream tries)'),
        '. It is labelled approximate for trigger rules other than ',
        code('all_success'),
        '.',
      ],
    ),
    h2('The 13 reasons'),
    p(
      'For each waiting minute, the first matching reason wins. Other matching reasons are kept as secondary evidence.',
    ),
    table(
      'Reasons in the order DCAM checks them (defaults)',
      ['#', 'Reason', 'Phase', 'Condition in that minute', 'Evidence shown'],
      [
        [
          '1',
          ['DAG ', code('max_active_runs')],
          'Run',
          ["The run is queued and the DAG's running runs ≥ ", code('max_active_runs')],
          'Run counts, limit',
        ],
        [
          '2',
          'Pool does not exist',
          'Pre-queue',
          [
            "The task's pool is not defined; ",
            code('GET /dagWarnings'),
            ' reports ',
            code('non-existent pool'),
            ' (the only warning type in Airflow 2.11)',
          ],
          'DAG warning, pool list',
        ],
        [
          '3',
          'Task larger than its pool',
          'Pre-queue',
          ["The task's ", code('pool_slots'), " exceed the pool's total slots, so it can never run"],
          'Task attributes, pool size',
        ],
        [
          '4',
          'Global parallelism',
          'Pre-queue',
          ['Executor running + queued ≥ parallelism (per scheduler; from overrides or HM-032)'],
          [code('executor/*'), ' metrics, HM-032'],
        ],
        [
          '5',
          'Pool exhausted',
          'Pre-queue',
          ["Pool open slots < the task's ", code('pool_slots'), ' (including zero open slots)'],
          [code('/pools'), ' history, ', code('pool/starving_tasks')],
        ],
        [
          '6',
          ['DAG ', code('max_active_tasks')],
          'Pre-queue',
          [
            "The DAG's running and queued task instances ≥ ",
            code('max_active_tasks'),
            ' (per DAG on Airflow 2, per DAG run on Airflow 3)',
          ],
          'HM-005',
        ],
        [
          '7',
          'Task-level limit',
          'Pre-queue',
          [
            'Running and queued tries of the task ≥ ',
            code('max_active_tis_per_dag'),
            ' or ',
            code('max_active_tis_per_dagrun'),
            '; from Airflow 3.2.2 deferred tries also count, and from 3.3 awaiting-input tries',
          ],
          'Task attributes, occupancy',
        ],
        [
          '8',
          'Scheduler throughput',
          'Pre-queue',
          'Reasons 1–7 do not apply, yet the try is not queued within 30 s of ready',
          ['HM-031, ', code('scheduler/tasks{starving}')],
        ],
        [
          '9',
          'Autoscaling lag',
          'Post-queue',
          [
            'Worker slots are full, workers < ',
            code('max_count'),
            ', and the scale target is above the current worker count',
          ],
          [code('num_celery_workers'), ', ', code('worker/scale_factor_target')],
        ],
        [
          '10',
          'Executor slots exhausted',
          'Post-queue',
          ['Worker slots are full and workers = ', code('max_count')],
          'HM-011',
        ],
        [
          '11',
          'Worker pickup',
          'Post-queue',
          "Free worker slots exist but the try stays queued for ≥ 60 s, or no worker consumes the try's queue",
          [code('executor/open_slots'), ', ', code('task_queue_length'), ' by queue'],
        ],
        [
          '12',
          'Triggerer capacity',
          'Deferral',
          "The try is deferred while running triggers ≥ 95 % of the triggerer's capacity",
          'HM-022',
        ],
        ['13', 'Unknown', 'Any', 'None of the above can be evaluated or matched', 'Gaps listed'],
      ],
      [0],
    ),
    h2('Why this order'),
    p(
      "The pre-queue reasons follow the order in which Airflow 2.11's scheduler checks them, so DCAM's answer is the limit the scheduler itself hit. ",
      'The source is ',
      code('SchedulerJobRunner._critical_section_enqueue_task_instances'),
      ' and ',
      code('_executable_task_instances_to_queued'),
      ' in ',
      code('airflow/jobs/scheduler_job_runner.py'),
      ' at ',
      code('v2-11-stable'),
      '. In each scheduler loop:',
    ),
    ol(
      [
        'The batch is capped at ',
        code('min(max_tis_per_query, parallelism − executor slots occupied)'),
        '. When the cap is zero, nothing is queued.',
      ],
      'If every pool is full, nothing is queued. Otherwise the batch is also capped at the free pool slots.',
      [
        'Candidates are scheduled task instances in running, non-backfill runs of unpaused DAGs, ordered by ',
        code('priority_weight'),
        ' (highest first), then logical date, then map index.',
      ],
      [
        'Each candidate is checked in turn for: pool missing; pool with no open slots; ',
        code('pool_slots'),
        ' larger than the pool; ',
        code('pool_slots'),
        ' larger than the open slots; DAG ',
        code('max_active_tasks'),
        '; ',
        code('max_active_tis_per_dag'),
        '; ',
        code('max_active_tis_per_dagrun'),
        '; executor slots.',
      ],
      [
        code('max_active_runs'),
        ' is enforced earlier, when ',
        code('_start_queued_dagruns'),
        ' refuses to start queued runs.',
      ],
    ),
    p(
      'Only running and queued tries count towards these limits on Airflow 2.11 (',
      code('EXECUTION_STATES'),
      '); deferred tries do not. ',
      'DCAM departs from the scheduler order in one place: it reports the two structural misconfigurations first, a missing pool and a task larger than its pool, because they never resolve on their own. ',
      'The classifier carries the version tag ',
      code('scheduler-order@2.11'),
      ', so Airflow 3 can use a different order once it is confirmed (VC-13).',
    ),
    h2('Waits that are not a platform limit'),
    ul(
      [
        'Dependency wait is reported separately, as "dependency wait (not a platform limit)": upstream tasks, ',
        code('depends_on_past'),
        ', sensors waiting for external events, and asset or dataset triggers.',
      ],
      'Normal latency: short waits below the thresholds above, under 30 s before queueing, or under 60 s after queueing while worker slots are free, are reported as "normal latency", outside the platform limits, like dependency wait.',
    ),
    callout(
      'verify',
      'A call made for feature 001',
      'The specification leaves the treatment of sub-threshold waits open. Reporting them as "normal latency" is a DCAM decision recorded in the feature 001 specification. ⚠️ VERIFY',
    ),
    h2('What DCAM can measure'),
    ul(
      [
        'Airflow 2.11 records no timestamp for entering ',
        code('scheduled'),
        ', so pre-queue reasons (2–8) are evaluated only from live snapshots taken while the work waits. ',
        'For older history, only the post-queue phase (',
        code('queued_when'),
        ' → ',
        code('start_date'),
        ') and run-level waits are available, and the pre-queue share is labelled "not observed".',
      ],
      'Each minute records which reasons could be evaluated. If a limit is unknown, for example parallelism before DCAM has inferred it with confidence, the reason is marked unevaluated rather than guessed.',
      'Demo mode does not cover the triggerer reason (12), and covers run-level waits (reason 1) only as far as the simulator models them.',
    ),
    p(
      'To act on the result, open ',
      link(WIKI_SLUGS.rb01, 'RB-01: Tasks stuck in queued or scheduled'),
      ', or see the ',
      link(WIKI_SLUGS.concurrencyStack, 'concurrency stack'),
      ' for what each limit controls.',
    ),
  ],
};

export const scheduleCollisions: WikiPage = {
  slug: WIKI_SLUGS.scheduleCollisions,
  title: 'Schedule collisions',
  section: 'How DCAM computes things',
  summary: 'How strongly planned run starts cluster in the same minutes (HM-009), and why staggering helps.',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [SOURCES.airflowRestApi, SOURCES.airflowBestPractices, SOURCES.composerOptimize],
  signals: ['HM-009'],
  related: [WIKI_SLUGS.workerCapacity, WIKI_SLUGS.rb14, WIKI_SLUGS.advisorRules],
  body: [
    p(
      'Schedule collision density shows how strongly planned run starts cluster in the same minutes. ',
      'When many DAGs start in the same minute, for example at the top of every hour, their tasks become ready together and compete for the same slots. ',
      'Work queues at the peak while capacity sits idle for the rest of the hour.',
    ),
    h2('How DCAM computes it'),
    ul(
      [
        "Enumerate the planned starts of every active DAG for the next 7 days. Cron schedules are expanded in the DAG's time zone, honouring daylight-saving transitions. Timetables use ",
        code('next_dagrun'),
        ' data and history.',
      ],
      'Build a minute-of-hour × hour-of-week density.',
      'Collision cost: Σ expected slot demand of the starts in a minute, from historical occupancy profiles.',
    ),
    codeBlock(
      'text',
      'Collision index (HM-009)',
      'collision index = daily starts in the busiest minute-of-hour ÷ all daily starts',
    ),
    h2('What to do about it'),
    p(
      'Spreading start times flattens the peak, so the same work runs without buying capacity for it. ',
      'The advisor raises ',
      link(WIKI_SLUGS.advisorRules, 'REC-SCHED-01'),
      ' when at least 20 % of daily scheduled starts fall in one minute-of-hour and that minute coincides with queueing.',
    ),
    p(
      "Planned: stagger suggestions that assign offsets to minimise peak demand, within each DAG's tolerance (±15 minutes by default) and its timeliness target.",
    ),
    h2('Caveats'),
    ul('Asset-triggered and manual runs are approximated by hour-of-week baselines.'),
  ],
};

export const sensorSlotWaste: WikiPage = {
  slug: WIKI_SLUGS.sensorSlotWaste,
  title: 'Sensor slot waste',
  section: 'How DCAM computes things',
  summary:
    'Executor slot-seconds spent waiting rather than working, and how reschedule mode or deferrable operators free them (HM-008).',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [SOURCES.airflowBestPractices, SOURCES.airflowRestApi],
  signals: ['HM-008'],
  related: [WIKI_SLUGS.executorSlotSeconds, WIKI_SLUGS.queueWait, WIKI_SLUGS.advisorRules],
  body: [
    p(
      'A sensor waits for something outside the DAG: a file, a partition, another system. How it waits decides whether it holds a worker slot while nothing happens.',
    ),
    table(
      'Sensor modes and how DCAM recognises them',
      ['Mode', 'While it waits', 'DCAM infers it from'],
      [
        ['Poke', 'Holds a worker slot for the whole wait', 'Neither of the states below is observed'],
        [
          'Reschedule',
          ['Frees the slot between pokes; the task is ', code('up_for_reschedule')],
          ['Observed ', code('up_for_reschedule')],
        ],
        ['Deferrable', 'Frees the slot; the triggerer waits for the event', ['Observed ', code('deferred')]],
      ],
    ),
    h2('How DCAM computes it'),
    ul(
      [
        'Sensors are operator classes whose names end in ',
        code('Sensor'),
        ', or classes listed in the knowledge base. Static analysis confirms the mode from M8.',
      ],
      'Waste = poke-mode slot-seconds, plus the poke time of reschedule-mode sensors.',
      'Long waits: non-sensor tries that run for at least 10 minutes with mean CPU under 5 %. These are typically synchronous operators that poll external jobs. Detecting them needs per-task CPU metrics; without them, only sensors are ranked.',
    ),
    h2('What to change'),
    p(
      'The advisor raises ',
      link(WIKI_SLUGS.advisorRules, 'REC-DAG-05'),
      ' when a poke-mode sensor or long-waiting task uses at least 1 slot-hour a day. Use ',
      code('mode="reschedule"'),
      ' or a deferrable operator:',
    ),
    codeBlock(
      'diff',
      'Example DAG change from the DCAM specification (§13.5)',
      '-wait_for_file = GCSObjectExistenceSensor(task_id="wait_for_file", bucket=BUCKET, object=OBJ, poke_interval=60, timeout=6 * 3600)\n+wait_for_file = GCSObjectExistenceSensor(task_id="wait_for_file", bucket=BUCKET, object=OBJ, deferrable=True, timeout=6 * 3600)',
    ),
    ul(
      [
        'Before suggesting ',
        code('deferrable=True'),
        ', DCAM checks its knowledge base, which records which installed provider operators support it.',
      ],
      [
        'In reschedule mode, each poke re-enters the queue, so ',
        link(WIKI_SLUGS.queueWait, 'queue wait'),
        ' counts each poke.',
      ],
    ),
  ],
};
