/**
 * How DCAM computes things (spec §15.1): the explainable health score (HM-028).
 * Facts: spec §7.2 (liveness DAG), HM-028, §16.4 and the health-label call of feature 001.
 */
import { callout, code, codeBlock, h2, link, p, table, ul, type WikiPage } from '../model';
import { WIKI_SLUGS } from '../slugs';
import { COMPOSER_2_AND_3, LAST_VERIFIED, SOURCES } from '../sources';

export const healthScore: WikiPage = {
  slug: WIKI_SLUGS.healthScore,
  title: 'Health score',
  section: 'How DCAM computes things',
  summary: 'A 0–100 score per environment, built from explicit checks you can inspect (HM-028).',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [SOURCES.composerMonitor, SOURCES.composerKeyMetrics, SOURCES.composerMetrics],
  signals: ['HM-028'],
  related: [WIKI_SLUGS.alertPack, WIKI_SLUGS.startHere],
  body: [
    p(
      'The fleet page gives each environment a score from 0 to 100. The score is made of explicit checks, and each check shows its state, threshold and evidence, so you can see why a score is low.',
    ),
    codeBlock(
      'text',
      'Health score (HM-028)',
      'score = 100 − Σ weights of the failing checks\nif any critical check fails: score = min(score, 40)',
    ),
    p(
      'The cap at 40 means many passing checks cannot hide a critical failure. ',
      "The checks follow Google's suggested alert thresholds where they exist (⚠️ VERIFY current values).",
    ),
    table(
      'Health checks, thresholds and weights',
      ['Check', 'Healthy when', 'Weight', 'Critical'],
      [
        [['Environment health (', code('environment/healthy'), ')'], '≥ 90 % healthy over 4 h', '25', 'Yes'],
        [['Database health (', code('database_health'), ')'], '≥ 95 % healthy over 4 h', '20', 'Yes'],
        ['Scheduler heartbeat completeness (HM-031)', '≥ 90 % over 4 h', '20', 'Yes'],
        ['Web server health', '≥ 95 % healthy over 4 h', '5', 'No'],
        ['Database CPU and memory', '< 80 % over 12 h', '10', 'No'],
        ['Zombie tasks', '≤ 1 per 24 h', '5', 'No'],
        ['Worker restarts (excluding scale-down)', '≤ 1 per 24 h', '5', 'No'],
        ['Import errors', '0 for 15 min', '5', 'No'],
        ['Parse loop', '< 5 min (p95 over 1 h)', '5', 'No'],
      ],
      [2],
    ),
    h2('Checks without data'),
    p(
      'A check without data is "unknown". It is left out of the score, and the score shows its coverage, for example "8 of 9 checks". ',
      'Weights can be configured per tier.',
    ),
    h2('Labels'),
    ul(
      '80 or more: healthy.',
      '50 to 79: degraded.',
      'Under 50: unhealthy.',
      'Partial: checks with data carry less than 80 % of the total weight, so DCAM shows no score, only "n of 9 checks". A failing critical check still makes the environment unhealthy.',
    ),
    callout(
      'verify',
      'A call made for feature 001',
      'The specification does not define label bands or a minimum coverage. The bands are a DCAM decision recorded in the feature 001 specification; the 80 % coverage gate reuses the minimum coverage DCAM applies to every signal (§8.9). ⚠️ VERIFY',
    ),
    h2('Good to know'),
    ul(
      [
        code('environment/healthy'),
        ' reflects a Composer-managed liveness DAG, ',
        code('airflow_monitoring'),
        '. DCAM tags it as a system DAG and leaves it out of DAG rankings by default.',
      ],
      [
        'Alerts AL-01 (environment unhealthy), AL-02 (scheduler heartbeat missing) and AL-18 (database unhealthy) watch the critical checks between visits: see the ',
        link(WIKI_SLUGS.alertPack, 'default alert pack'),
        '.',
      ],
    ),
  ],
};
