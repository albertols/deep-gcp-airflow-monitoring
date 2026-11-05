/**
 * (i) explanations for the advisor page (FR-UI-05, spec §12.9).
 */
import type { Explanation } from '@dcam/ui-kit';

const RULES_DOC = {
  title: 'Managed Airflow (Gen 3): optimize environment performance and costs',
  url: 'https://docs.cloud.google.com/composer/docs/composer-3/optimize-environments',
};
const SOURCES = ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'];

export const ADVISOR_EXPLANATIONS = {
  'adv-top-actions': {
    id: 'adv-top-actions',
    title: 'Top actions',
    summary:
      'The findings to act on first, at most 10 per environment, from rules evaluated over the last 24 hours.',
    whyItMatters: 'A few changes usually remove most of the waiting; start at the top and work down.',
    howToRead:
      'Critical findings come first. The rest are ordered by priority score, then by the number of affected DAGs, then by how recently the condition was seen.',
    sources: SOURCES,
    freshness: 'Evaluated when the page loads, over the last 24 hours',
    caveats: [
      'Findings are evaluated on demand; acknowledging, snoozing and verifying them comes with the finding lifecycle.',
    ],
    docs: [RULES_DOC],
  },
  'adv-other': {
    id: 'adv-other',
    title: 'Other findings',
    summary: 'Findings ranked below the top 10.',
    sources: SOURCES,
  },
  'adv-priority': {
    id: 'adv-priority',
    title: 'Priority score',
    summary: 'How much acting on a finding is worth, relative to the effort it takes.',
    formula: 'priority = tier weight × impact × confidence ÷ effort',
    howToRead:
      'Tier weight: production 1.0, test 0.6, development 0.3. Impact: 1 (minor) to 5 (severe). Confidence: 0 to 1. Effort: 1 configuration, 2 sizing, 3 DAG change, 5 multi-DAG refactor. Every factor is shown, so you can disagree with the ranking in an informed way.',
    sources: SOURCES,
    caveats: ['Critical findings always rank above others, whatever their score.'],
  },
  'adv-impact': {
    id: 'adv-impact',
    title: 'Impact',
    summary: 'The measured consequence of the finding on a 1–5 log scale.',
    formula:
      'hours per day of waiting task-time (or of wasted slot time): < 1 → 1, 1–10 → 2, 10–100 → 3, 100–1,000 → 4, ≥ 1,000 → 5',
    sources: SOURCES,
    caveats: ['The breakpoints are DCAM defaults: the specification names the scale but not its steps.'],
  },
  'adv-confidence': {
    id: 'adv-confidence',
    title: 'Confidence',
    summary: 'How sure DCAM is, from 0 to 1.',
    formula:
      'coverage (share of the window with data) × sample factor (rises to 1 at 30 supporting observations) × agreement of independent signals',
    sources: SOURCES,
    caveats: ['Rules whose data covers less than 80 % of the window produce no finding at all.'],
  },
  'adv-effort': {
    id: 'adv-effort',
    title: 'Effort',
    summary: 'What applying the remediation takes.',
    howToRead: '1 configuration override, 2 sizing change, 3 single-DAG code change, 5 multi-DAG refactor.',
    sources: ['SRC-COMPOSER'],
  },
  'adv-evidence': {
    id: 'adv-evidence',
    title: 'Evidence',
    summary:
      'The values the rule measured, the thresholds it compared them with and where each value comes from.',
    sources: SOURCES,
    caveats: ['In demo mode every value comes from the simulated demo workspace.'],
  },
  'adv-why': {
    id: 'adv-why',
    title: 'Why am I seeing this?',
    summary: 'The rule’s condition with this environment’s actual values, thresholds and the data used.',
    sources: SOURCES,
  },
  'adv-remediation': {
    id: 'adv-remediation',
    title: 'Remediation',
    summary:
      'Copy-only snippets (gcloud, Terraform, DAG changes) rendered with this environment’s values. DCAM never runs them.',
    whyItMatters:
      'Review each snippet, replace placeholders such as LOCATION, and apply it through your own change process, in a maintenance window for production.',
    sources: ['SRC-COMPOSER'],
    caveats: [
      'Lines marked VERIFY state facts DCAM has not confirmed for every Composer version; check them against the linked documentation.',
    ],
    docs: [
      {
        title: 'gcloud composer environments update',
        url: 'https://cloud.google.com/sdk/gcloud/reference/composer/environments/update',
      },
      {
        title: 'Managed Airflow: Airflow configuration overrides',
        url: 'https://docs.cloud.google.com/composer/docs/airflow-configurations',
      },
    ],
  },
} as const satisfies Record<string, Explanation>;

export type AdvisorExplanationId = keyof typeof ADVISOR_EXPLANATIONS;
export const ADVISOR_PANELS = Object.keys(ADVISOR_EXPLANATIONS) as AdvisorExplanationId[];
