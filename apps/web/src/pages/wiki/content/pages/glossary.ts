/**
 * Glossary (spec §6.2 seed, plus the terms the other wiki pages define). `GLOSSARY` is exported on
 * its own so that hover definitions across the app can use it later (FR-WIKI-07).
 *
 * @implements FR-WIKI-07
 */
import { code, definitions, p, type GlossaryTerm, type WikiPage } from '../model';
import { WIKI_SLUGS } from '../slugs';
import { COMPOSER_2_AND_3, LAST_VERIFIED, SOURCES } from '../sources';

/** Alphabetical; a test keeps it that way. */
export const GLOSSARY: readonly GlossaryTerm[] = [
  {
    term: 'Binding limit',
    definition: ['The limit that currently prevents more tasks from running (HM-006).'],
    see: WIKI_SLUGS.whyWorkWaits,
  },
  {
    term: 'Capacity-bound minute',
    definition: [
      'A minute in which workers are at ',
      code('max_count'),
      ' and queued task instances ≥ max(10, 20 % of capacity) (HM-011).',
    ],
    see: WIKI_SLUGS.workerCapacity,
  },
  {
    term: 'Collision index',
    definition: ['The share of daily scheduled starts that fall in the busiest minute-of-hour (HM-009).'],
    see: WIKI_SLUGS.scheduleCollisions,
  },
  {
    term: 'Critical path',
    definition: [
      'The longest dependency chain in a DAG run, measured by actual durations. It determines the run duration.',
    ],
  },
  {
    term: 'DCU',
    definition: [
      'Data Compute Unit, the Composer 3 billing unit for environment compute, billed in DCU-hours. Google does not publish a conversion from workload sizes to DCUs, so DCAM uses billing data or rates you enter (HM-021).',
    ],
  },
  {
    term: 'Deferral',
    definition: [
      'A task releases its worker slot and waits in the triggerer for an event. Deferrable operators work this way.',
    ],
    see: WIKI_SLUGS.sensorSlotWaste,
  },
  {
    term: 'Dependency wait',
    definition: [
      'Waiting for upstream tasks, ',
      code('depends_on_past'),
      ', sensors waiting for external events, or asset and dataset triggers. DCAM reports it separately, because it is not a platform limit.',
    ],
    see: WIKI_SLUGS.whyWorkWaits,
  },
  {
    term: 'Effective concurrency',
    definition: [
      'The minimum of all applicable limits at a moment: ',
      code('core.parallelism'),
      ' per scheduler, executor slots, pool open slots, DAG ',
      code('max_active_tasks'),
      ', ',
      code('max_active_runs'),
      ' and task-level limits such as ',
      code('max_active_tis_per_dag'),
      '.',
    ],
    see: WIKI_SLUGS.concurrencyStack,
  },
  {
    term: 'Executor slots',
    definition: [
      'Workers × ',
      code('celery.worker_concurrency'),
      ': the upper bound for running Celery task instances at a moment.',
    ],
    see: WIKI_SLUGS.workerCapacity,
  },
  {
    term: 'Health score',
    definition: ['A 0–100 score per environment, built from explicit checks (HM-028).'],
    see: WIKI_SLUGS.healthScore,
  },
  {
    term: 'Noisy neighbour',
    definition: ['A DAG whose activity measurably increases the queue wait or failures of other DAGs.'],
  },
  {
    term: 'Observer budget',
    definition: ['The maximum load DCAM may impose on a monitored environment and its APIs.'],
  },
  {
    term: 'Parse loop',
    definition: ['One full pass of the DAG processor over all DAG files.'],
  },
  {
    term: 'Pool',
    definition: [
      'A named limit on how many task instances can run at the same time across DAGs. A running task instance occupies ',
      code('pool_slots'),
      ' slots of its pool.',
    ],
    see: WIKI_SLUGS.pools,
  },
  {
    term: 'Post-queue wait',
    definition: ['Waiting between queued and running, while the executor and workers act.'],
    see: WIKI_SLUGS.scheduledVsQueued,
  },
  {
    term: 'Pre-queue wait',
    definition: [
      'Waiting between ready and queued, while the scheduler checks DAG limits, pools and parallelism.',
    ],
    see: WIKI_SLUGS.scheduledVsQueued,
  },
  {
    term: 'Provenance',
    definition: [
      'Where an effective configuration value comes from: observed, environment variable, override, inferred, Composer default or Airflow default.',
    ],
  },
  {
    term: 'Queue wait',
    definition: [
      'Time between a task instance being queued and starting (',
      code('start_date − queued_when'),
      ').',
    ],
    see: WIKI_SLUGS.queueWait,
  },
  {
    term: 'Scheduling delay',
    definition: [
      'Time between when a DAG run should start (the end of the data interval, for scheduled runs) and when it actually starts.',
    ],
  },
  {
    term: 'Slot',
    definition: [
      'A unit of execution capacity. Celery slots = workers × ',
      code('celery.worker_concurrency'),
      '. Pool slots limit concurrency per pool; a task instance occupies ',
      code('pool_slots'),
      ' slots of its pool while running.',
    ],
    see: WIKI_SLUGS.concurrencyStack,
  },
  {
    term: 'Slot-seconds',
    definition: [
      'Running time summed over task instance tries: the base unit of DAG resource accounting (HM-003). Executor slot-seconds count one worker slot per running try; pool slot-seconds multiply by ',
      code('pool_slots'),
      '.',
    ],
    see: WIKI_SLUGS.executorSlotSeconds,
  },
  {
    term: 'Source lag',
    definition: ['The delay between an event happening and DCAM being able to read it from a source.'],
  },
  {
    term: 'Stale DAG',
    definition: [
      'A DAG not seen by the DAG processor for longer than ',
      code('dag_stale_not_seen_duration'),
      '. It may be deactivated.',
    ],
  },
  {
    term: 'Tenant project',
    definition: [
      "A Google-managed project that hosts Composer 3 infrastructure, such as the cluster and the database, on the customer's behalf.",
    ],
  },
  {
    term: 'Zombie (heartbeat timeout)',
    definition: ['A running task instance whose heartbeat stopped. The scheduler fails it.'],
  },
];

export const glossary: WikiPage = {
  slug: WIKI_SLUGS.glossary,
  title: 'Glossary',
  section: 'Glossary',
  summary: 'The terms DCAM uses, in plain words, with a link to the page that explains each one.',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [SOURCES.composerArchitecture, SOURCES.airflowConfig, SOURCES.airflowPools],
  body: [
    p('Terms are listed alphabetically. Where a page explains a term in depth, its definition links to it.'),
    definitions(GLOSSARY),
  ],
};
