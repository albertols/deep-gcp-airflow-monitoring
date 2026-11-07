/**
 * The advisor rules engine (spec §13.2): evaluates every rule over one environment's signals, applies
 * the data quality gates and inhibitions, and ranks the findings (§13.4). Evaluation is stateless: it
 * produces exactly one finding per rule and scope for the window (FR-ADV-01); hysteresis and the
 * finding lifecycle need stored evaluations and come with FR-ADV-05.
 *
 * Not evaluated yet: REC-CONC-04 (priority starvation) needs 28-day per-band baselines (HM-023), and the
 * long-wait part of REC-DAG-05 needs per-try CPU (HM-004 Method A).
 *
 * @implements FR-ADV-01, FR-ADV-04, FR-ADV-08
 */
import {
  applyInhibitions,
  rankFindings,
  type AdvisorFinding,
  type Inhibition,
  type RuleId,
} from './advisor-model';
import { MIN_COVERAGE, MIN_SAMPLES, toFinding, type RuleDefinition, type RuleInput } from './advisor-rule';
import { REC_CAP_01, REC_CAP_05, REC_CAP_08 } from './advisor-rules-capacity';
import { REC_CONC_01, REC_CONC_02, REC_CONC_03 } from './advisor-rules-concurrency';
import { REC_DAG_01, REC_DAG_05, REC_SCHED_01 } from './advisor-rules-dag';
import type { EnvironmentSignals } from './advisor-signals';
import type { WaitReasonId } from './model';

/** The rules evaluated in this version, in catalog order. */
export const ADVISOR_RULES: readonly RuleDefinition[] = [
  REC_CAP_01,
  REC_CAP_05,
  REC_CAP_08,
  REC_CONC_01,
  REC_CONC_02,
  REC_CONC_03,
  REC_DAG_01,
  REC_DAG_05,
  REC_SCHED_01,
];

export interface InsufficientData {
  readonly ruleId: RuleId;
  readonly reason: string;
}

export interface AdvisorResult {
  /** Ranked: critical first, then priority score, affected DAGs and recency. */
  readonly findings: readonly AdvisorFinding[];
  readonly inhibited: readonly Inhibition[];
  /** Rules that produced no finding because their data was incomplete (spec §13.2). */
  readonly insufficient: readonly InsufficientData[];
}

const INPUT_NAMES: Readonly<Record<RuleInput, string>> = {
  snapshots: 'live snapshots',
  samples: 'worker samples',
  tries: 'task instance history',
};

/** Where each input comes from, for a source that has no data at all (spec §8.1: no data is not 0 %). */
const NO_DATA: Readonly<Record<RuleInput, string>> = {
  snapshots:
    'No data: needs live snapshots from the Airflow REST API, and none were collected in the window.',
  samples: 'No data: needs Cloud Monitoring worker samples, and none were collected in the window.',
  tries:
    'No data: needs task instance history from the Airflow REST API, and none was collected in the window.',
};

/** What the §13.2 data quality gate reads. */
export type DataQuality = Pick<EnvironmentSignals, 'coverage' | 'snapshotCount' | 'sampleCount'>;

/** §13.2 data quality gate: the reason a rule with these inputs cannot be evaluated, or `null`. */
export function dataGap(s: DataQuality, inputs: readonly RuleInput[]): string | null {
  for (const input of inputs) {
    const coverage = s.coverage[input];
    const count = input === 'snapshots' ? s.snapshotCount : input === 'samples' ? s.sampleCount : Infinity;
    if (coverage === 0 || count === 0) return NO_DATA[input];
    if (coverage < MIN_COVERAGE)
      return `Only ${Math.round(coverage * 100)}% of the window has ${INPUT_NAMES[input]}; the rule needs ${MIN_COVERAGE * 100}%.`;
    if (count < MIN_SAMPLES)
      return `Only ${count} ${INPUT_NAMES[input]} in the window; the rule needs at least ${MIN_SAMPLES}.`;
  }
  return null;
}

/** The advisor rule that acts on each HM-006 reason; the Bottlenecks headline points to it. */
export const REASON_RULES: Readonly<Partial<Record<WaitReasonId, RuleId>>> = {
  parallelism: 'REC-CONC-01',
  'pool-exhausted': 'REC-CONC-02',
  'dag-max-active-tasks': 'REC-DAG-01',
  'executor-slots-exhausted': 'REC-CAP-01',
  'autoscaling-lag': 'REC-CAP-01',
};

/**
 * Why advice on a reason is withheld: the data gate of the rule behind it, or of live snapshots for a
 * reason without a rule (the waiting itself comes from snapshots). `null` when advice may be shown, so a
 * headline never recommends what the advisor reports as not evaluated.
 */
export function adviceGap(s: DataQuality, reason: WaitReasonId): string | null {
  const ruleId = REASON_RULES[reason];
  const inputs = ADVISOR_RULES.find((r) => r.id === ruleId)?.inputs ?? ['snapshots'];
  return dataGap(s, inputs);
}

export function evaluateAdvisor(
  s: EnvironmentSignals,
  rules: readonly RuleDefinition[] = ADVISOR_RULES,
): AdvisorResult {
  const insufficient: InsufficientData[] = [];
  const findings: AdvisorFinding[] = [];
  for (const rule of rules) {
    const gap = dataGap(s, rule.inputs);
    if (gap) {
      insufficient.push({ ruleId: rule.id, reason: gap });
      continue;
    }
    const outcome = rule.evaluate(s);
    if (outcome.kind === 'insufficient') insufficient.push({ ruleId: rule.id, reason: outcome.reason });
    else findings.push(...outcome.findings.map((m) => toFinding(s, rule, m)));
  }
  const inhibits = Object.fromEntries(rules.map((r) => [r.id, r.inhibits ?? []]));
  const { kept, inhibited } = applyInhibitions(findings, inhibits);
  return { findings: rankFindings(kept), inhibited, insufficient };
}
