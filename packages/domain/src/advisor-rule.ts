/**
 * Rule definitions and default thresholds of the first rules (spec §13.6), and the factory that turns
 * a rule's measurements into a scored finding (§13.3, §13.4).
 *
 * Thresholds come from the spec catalog; values the spec leaves open are marked ⚠️ and listed in
 * `specs/001-m2-m7-demo-pages/spec.md` open questions when the feature closes.
 *
 * @implements FR-ADV-01, FR-ADV-04
 */
import {
  TIER_WEIGHTS,
  confidenceOf,
  impactFromHours,
  priorityScore,
  type AdvisorFinding,
  type Effort,
  type FindingCategory,
  type RuleId,
  type ScopeKind,
  type Severity,
} from './advisor-model';
import type { EnvironmentSignals } from './advisor-signals';

export const DAY_MS = 24 * 3_600_000;

/** Default thresholds (spec §13.6; units in the names). */
export const RULE_THRESHOLDS = {
  'REC-CAP-01': { minMinutesPerDay: 15, devMinMinutesPerDay: 60, criticalMinutes: 120 },
  /** ⚠️ The spec gives no duration for "slots exhausted"; REC-CAP-01's 15 minutes are used. */
  'REC-CAP-05': { cpuP95Below: 0.3, memoryP95Below: 0.4, minMinutesPerDay: 15, maxConcurrency: 24 },
  /** ⚠️ The spec gives no duration; REC-CAP-01's 15 minutes are used. */
  'REC-CAP-08': { loadP95AtLeast: 0.85, minMinutesPerDay: 15, maxConcurrency: 24 },
  'REC-CONC-01': { minWaitingShare: 0.2 },
  'REC-CONC-02': { minStarvedMinutesPerDay: 30 },
  /** "It starves" uses REC-CONC-02's 30 minutes per day. */
  'REC-CONC-03': { minSlotSecondsShare: 0.7, minStarvedMinutesPerDay: 30 },
  'REC-DAG-01': { minAtLimitShare: 0.1 },
  'REC-DAG-05': { minSlotHoursPerDay: 1 },
  /**
   * ⚠️ "Coinciding with queueing" is not quantified by the spec: DCAM requires at least half of the
   * platform waiting in the 15 minutes from the busiest minute (HM-009's ±15 min stagger tolerance),
   * twice that window's share of an hour.
   */
  'REC-SCHED-01': { minCollisionIndex: 0.2, windowMinutes: 15, minWaitingShare: 0.5 },
} as const;

/** §13.2 data quality gates (rule model defaults `minCoverage` and `minSamples`). */
export const MIN_COVERAGE = 0.8;
export const MIN_SAMPLES = 30;

export type RuleInput = 'snapshots' | 'samples' | 'tries';

/** What a rule measured for one scope; the factory adds the scores. */
export interface RuleMeasurement {
  readonly scope: { readonly kind: ScopeKind; readonly id: string };
  readonly severity: Severity;
  /** Task-hours waiting, or slot-hours wasted, per day: the impact model (§13.3). */
  readonly impactHoursPerDay: number;
  /** Supporting observations for the sample factor (minutes, snapshots or tries). */
  readonly observations: number;
  /** Agreement of independent signals, 0–1 (1 when one signal is used). */
  readonly agreement: number;
  readonly coverage: number;
  readonly effort: Effort;
  readonly observation: string;
  readonly impactText: string;
  readonly action: string;
  readonly why: string;
  readonly evidence: AdvisorFinding['evidence'];
  readonly remediation: AdvisorFinding['remediation'];
  readonly risks: readonly string[];
  readonly rollback: string;
  readonly verify: string;
  readonly affectedDags: readonly string[];
  readonly docs: AdvisorFinding['links']['docs'];
  readonly detectedAt: number;
}

export type RuleOutcome =
  | { readonly kind: 'evaluated'; readonly findings: readonly RuleMeasurement[] }
  | { readonly kind: 'insufficient'; readonly reason: string };

export interface RuleDefinition {
  readonly id: RuleId;
  readonly title: string;
  readonly category: FindingCategory;
  readonly inputs: readonly RuleInput[];
  /** Wiki page slug (FR-WIKI-06). */
  readonly wiki: string;
  readonly inhibits?: readonly RuleId[];
  evaluate(s: EnvironmentSignals): RuleOutcome;
}

export const evaluated = (findings: readonly RuleMeasurement[]): RuleOutcome => ({
  kind: 'evaluated',
  findings,
});

/** Scales a window total to a per-day rate. */
export const perDay = (s: EnvironmentSignals, value: number) => (value * DAY_MS) / Math.max(1, s.to - s.from);

export function toFinding(s: EnvironmentSignals, rule: RuleDefinition, m: RuleMeasurement): AdvisorFinding {
  const tierWeight = TIER_WEIGHTS[s.config.tier];
  const impact = impactFromHours(m.impactHoursPerDay);
  const confidence = confidenceOf({
    coverage: m.coverage,
    observations: m.observations,
    agreement: m.agreement,
  });
  return {
    id: `${s.config.envId}:${rule.id}:${m.scope.kind}:${m.scope.id}`,
    ruleId: rule.id,
    title: rule.title,
    category: rule.category,
    scope: m.scope,
    severity: m.severity,
    impact,
    confidence,
    effort: m.effort,
    tierWeight,
    priorityScore: priorityScore({ tierWeight, impact, confidence, effort: m.effort }),
    observation: m.observation,
    impactText: m.impactText,
    action: m.action,
    why: m.why,
    evidence: m.evidence,
    remediation: m.remediation,
    risks: m.risks,
    rollback: m.rollback,
    verify: m.verify,
    affectedDags: m.affectedDags,
    links: { wiki: rule.wiki, docs: m.docs },
    detectedAt: m.detectedAt,
  };
}
