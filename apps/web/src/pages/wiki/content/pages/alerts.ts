/**
 * Alerts: the default alert pack (spec §16.1, §16.2, §16.4, §16.7) and the read-only boundary
 * (spec §18.2). Runbooks that exist link to their page; the others show their ID.
 */
import { code, h2, link, p, table, ul, type Inline, type WikiPage } from '../model';
import { RUNBOOK_WIKI_PAGES, WIKI_SLUGS } from '../slugs';
import { COMPOSER_2_AND_3, LAST_VERIFIED, SOURCES } from '../sources';

type RunbookId = keyof typeof RUNBOOK_WIKI_PAGES;
const isWritten = (id: string): id is RunbookId => Object.hasOwn(RUNBOOK_WIKI_PAGES, id);
const runbook = (id: string): Inline => (isWritten(id) ? link(RUNBOOK_WIKI_PAGES[id], id) : id);

type Row = readonly [
  id: string,
  name: string,
  condition: readonly Inline[],
  severity: string,
  rb: string,
  exp: string,
];

/** IDs and names of the default alert pack, for the command palette (FR-UI-03). */
export interface AlertPackRule {
  readonly id: string;
  readonly name: string;
}

const PACK: readonly Row[] = [
  [
    'AL-01',
    'Environment unhealthy',
    [code('environment/healthy'), ' reports unhealthy for 10 min, or healthy < 90 % of the time over 4 h'],
    'critical / warning',
    'RB-03',
    'Yes',
  ],
  [
    'AL-02',
    'Scheduler heartbeat missing',
    ['No scheduler heartbeat for 5 min, or heartbeat completeness < 90 % over 4 h (HM-031)'],
    'critical / warning',
    'RB-03',
    'Yes (absence); completeness: No',
  ],
  [
    'AL-03',
    'Stale DAG risk',
    ['Parse loop ≥ 80 % of the stale threshold for 30 min'],
    'warning / info',
    'RB-02',
    'Partial (threshold must be a constant)',
  ],
  ['AL-04', 'Import errors', ['Import errors > 0 for 15 min'], 'warning / info', 'RB-02', 'Yes'],
  [
    'AL-05',
    'Tasks queued while workers are at maximum',
    ['Workers at maximum and ≥ 10 queued for 15 min'],
    'warning / info',
    'RB-01',
    'Partial (combined condition)',
  ],
  [
    'AL-06',
    'Queue wait high',
    ['p95 queue wait ≥ 10 min over 15 min'],
    'warning / info',
    'RB-01',
    'No (derived from the Airflow API)',
  ],
  [
    'AL-07',
    'Worker memory pressure',
    [
      'Worker memory ≥ 90 % of the limit for 10 min, or an OOM kill (',
      code('health/container_restart_count'),
      ', reason ',
      code('OOMKilled'),
      ')',
    ],
    'warning / info',
    'RB-04',
    'Yes',
  ],
  [
    'AL-08',
    'Zombie or heartbeat-timeout tasks',
    ['≥ 5 in 1 h (', code('zombie_task_killed_count'), '); production also reports > 1 per 24 h at info'],
    'warning / info',
    'RB-04',
    'Yes',
  ],
  [
    'AL-09',
    'Failure spike',
    ['Failed task instances ≥ 3 × the same-hour baseline over 1 h'],
    'warning / info',
    'RB-11',
    'Partial',
  ],
  [
    'AL-10',
    'Database CPU or memory high',
    ['Database CPU ≥ 90 % for 15 min, or CPU or memory ≥ 80 % over 12 h'],
    'warning / info',
    'RB-07',
    'Yes',
  ],
  [
    'AL-11',
    'Database size runway',
    ['Projected to reach the threshold within 14 days'],
    'warning / info',
    'RB-07',
    'No (forecast)',
  ],
  [
    'AL-12',
    'Airflow API unreachable from DCAM',
    ['Health checks fail for 5 min'],
    'warning / warning',
    'RB-10',
    'No (DCAM-local)',
  ],
  ['AL-13', 'Triggerer saturated', ['≥ 90 % of capacity for 15 min'], 'warning / info', 'RB-08', 'Partial'],
  [
    'AL-14',
    'Timeliness target missed',
    ['A DAG run misses its configured target (opt-in per DAG)'],
    'warning / info',
    'RB-06',
    'No',
  ],
  [
    'AL-15',
    'Pool starvation',
    ['A pool has no open slots with queued work for 30 min'],
    'warning / info',
    'RB-01',
    'No',
  ],
  [
    'AL-16',
    'Environment operation failed',
    ['A Composer update or upgrade operation ended in error'],
    'warning / warning',
    'RB-09',
    'Yes (via audit or operation logs)',
  ],
  [
    'AL-17',
    'DCAM collection stale',
    ['A collector has had no successful cycle for 10 min'],
    'info / info',
    'RB-10',
    'No (DCAM-local)',
  ],
  [
    'AL-18',
    'Database unhealthy',
    [code('database_health'), ' healthy < 95 % of the time over 4 h'],
    'critical / warning',
    'RB-07',
    'Yes',
  ],
  [
    'AL-19',
    'Worker restarts',
    ['> 1 worker container restart in 24 h, excluding scale-down and maintenance'],
    'warning / info',
    'RB-04',
    'Yes',
  ],
];

export const ALERT_PACK_RULES: readonly AlertPackRule[] = PACK.map(([id, name]) => ({ id, name }));

export const alertPack: WikiPage = {
  slug: WIKI_SLUGS.alertPack,
  title: 'Default alert pack',
  section: 'Alerts',
  summary: 'The alert rules DCAM evaluates while it runs: conditions, severities and the runbook for each.',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [SOURCES.composerKeyMetrics, SOURCES.composerMonitor, SOURCES.composerMetrics],
  related: [WIKI_SLUGS.healthScore, WIKI_SLUGS.rb01, WIKI_SLUGS.rb14],
  body: [
    p(
      'DCAM evaluates alert rules locally, and only while it runs. It never creates or changes Cloud Monitoring alert policies. ',
      'For round-the-clock coverage, use Cloud Monitoring alert policies. The planned policy export (Terraform or JSON, for conditions that Cloud Monitoring metrics can express) is copy-only: you review and apply it yourself.',
    ),
    h2('How an alert moves between states'),
    ul(
      [
        code('inactive'),
        ' → ',
        code('pending'),
        ' (the condition is true, but its ',
        code('for'),
        ' duration has not elapsed yet) → ',
        code('firing'),
        ' → ',
        code('resolved'),
        ' (the condition stayed false for ',
        code('clearFor'),
        ').',
      ],
      [
        code('unknown'),
        ": the rule's source is stale beyond 3 × its cadence. DCAM never alerts on data it does not have.",
      ],
      "Each rule is evaluated on its signal's live cadence, at most once every 10 seconds. There is exactly one alert per rule and scope.",
    ),
    h2('The default rules'),
    table(
      'Default alert pack (severity for prod / non-prod)',
      ['ID', 'Alert', 'Condition (defaults)', 'Severity', 'Runbook', 'Cloud Monitoring export'],
      PACK.map(([id, name, condition, severity, rb, exp]) => [
        id,
        name,
        condition,
        severity,
        runbook(rb),
        exp,
      ]),
    ),
    p(
      'Several defaults (AL-01, AL-02, AL-08, AL-10, AL-18 and AL-19) follow the alert thresholds Google suggests for Composer key metrics. DCAM adds faster, symptom-based variants for paging.',
    ),
    h2('Keeping alerts useful'),
    ul(
      'Alerts page on symptoms: unhealthy, heartbeat missing, capacity-bound with late runs. Causes become advisor findings, not pages.',
      'Every alert has a runbook and an owner label.',
    ),
  ],
};
