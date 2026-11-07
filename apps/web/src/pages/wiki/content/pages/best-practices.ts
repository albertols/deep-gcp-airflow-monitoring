/**
 * Best practices (spec §15.1): the advisor rules with their trigger and action, cross-linked with
 * the pages that explain what they measure (FR-WIKI-06). Facts: spec §13.1, §13.4, §13.5, §13.6.
 */
import { code, codeBlock, h2, link, p, table, ul, type Block, type WikiPage } from '../model';
import { ADVISOR_RULES, RULE_CATEGORIES } from '../rules';
import { WIKI_SLUGS, type WikiSlug } from '../slugs';
import { COMPOSER_2_AND_3, LAST_VERIFIED, SOURCES } from '../sources';
import { workerCapacity } from './capacity-signals';
import { scheduleCollisions, sensorSlotWaste } from './bottleneck-signals';
import { concurrencyStack, pools } from './concepts';

const TOPICS: ReadonlyMap<WikiSlug, string> = new Map(
  [workerCapacity, scheduleCollisions, sensorSlotWaste, concurrencyStack, pools].map((pg) => [
    pg.slug,
    pg.title,
  ]),
);

const ruleTables: Block[] = RULE_CATEGORIES.flatMap((category) => [
  h2(category),
  table(
    `${category}: rules, triggers and actions`,
    ['Rule', 'Triggers when (defaults)', 'Suggested action', 'Learn more'],
    ADVISOR_RULES.filter((r) => r.category === category).map((r) => [
      [code(r.id), ` ${r.title}`],
      r.trigger,
      r.action,
      link(r.learnMore, TOPICS.get(r.learnMore) ?? 'Related page'),
    ]),
  ),
]);

export const advisorRules: WikiPage = {
  slug: WIKI_SLUGS.advisorRules,
  title: 'Advisor rules',
  section: 'Best practices',
  summary: "When each of the advisor's rules triggers, and what it suggests you change.",
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [
    SOURCES.composerOptimize,
    SOURCES.composerScaling,
    SOURCES.composerAirflowConfigurations,
    SOURCES.airflowPools,
    SOURCES.airflowConfig,
    SOURCES.celeryConfig,
    SOURCES.airflowBestPractices,
  ],
  related: [WIKI_SLUGS.rb01, WIKI_SLUGS.rb14, WIKI_SLUGS.whyWorkWaits],
  body: [
    p(
      'The advisor turns signals into findings. Each finding reads observation → impact → action, shows the evidence it used, and offers snippets that you copy and apply yourself: DCAM never applies them.',
    ),
    ul(
      'Thresholds are starting points. You can configure them per environment and tier.',
      [
        'Findings are ranked by ',
        code('priority = tier weight × impact × confidence ÷ effort'),
        ', critical first. Tier weights: prod 1.0, test 0.6, dev 0.3. Effort: 1 for a configuration change, 2 for sizing, 3 for a DAG change, 5 for a refactor.',
      ],
      [
        'REC-CAP-01 inhibits REC-CAP-05: when both apply to the same scope, you see only REC-CAP-01, whose action already covers raising ',
        code('worker_concurrency'),
        '.',
      ],
    ),
    ...ruleTables,
    h2('What a snippet looks like'),
    p(
      "Snippets are rendered with your environment's values. For example, raising the worker maximum (REC-CAP-01) on the fictitious environment ",
      code('acme-prod'),
      ':',
    ),
    codeBlock(
      'bash',
      'Workload sizing with gcloud',
      'gcloud composer environments update acme-prod \\\n  --location europe-west1 \\\n  --max-workers 8',
    ),
    p(
      'Every snippet lists its risks and a rollback. A higher maximum increases peak cost, and more concurrent tasks increase the load on the metadata database and on external systems. ',
      'Environment updates can restart components, so apply production changes in a maintenance window (⚠️ VERIFY which updates restart which components on Composer 3).',
    ),
  ],
};
