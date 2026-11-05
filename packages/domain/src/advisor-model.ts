/**
 * Advisor model (spec §13): findings with scope, severity, impact, confidence, effort and evidence,
 * and the scales that rank them (§13.3, §13.4). Remediation snippets are text that people review
 * and apply themselves; DCAM never runs them (FR-ADV-03).
 *
 * Calls made where the spec leaves values open (⚠️ spec §13.3 names the scales but not their
 * breakpoints): impact uses decades of hours per day (< 1 h → 1, 1–10 h → 2, 10–100 h → 3,
 * 100–1,000 h → 4, ≥ 1,000 h → 5); the sample factor rises linearly to 1 at 30 supporting
 * observations (the rule model's `minSamples`); tiers without a spec default (`uat`, `other`) use the
 * test and development weights.
 *
 * @implements FR-ADV-01, FR-ADV-04, FR-ADV-08
 */
import type { Tier } from './model';

export type Severity = 'info' | 'warning' | 'critical';
export type Impact = 1 | 2 | 3 | 4 | 5;
/** 1 configuration override, 2 sizing change, 3 single-DAG code change, 5 multi-DAG refactor. */
export type Effort = 1 | 2 | 3 | 5;
export type FindingCategory = 'capacity' | 'concurrency' | 'dag' | 'scheduling';
export type ScopeKind = 'environment' | 'pool' | 'dag' | 'task';
/** Where an evidence value comes from (spec §7). */
export type EvidenceSource = 'SRC-AF-API' | 'SRC-MON' | 'SRC-COMPOSER';

export type RuleId =
  | 'REC-CAP-01'
  | 'REC-CAP-05'
  | 'REC-CAP-08'
  | 'REC-CONC-01'
  | 'REC-CONC-02'
  | 'REC-CONC-03'
  | 'REC-DAG-01'
  | 'REC-DAG-05'
  | 'REC-SCHED-01';

export interface EvidenceRow {
  readonly label: string;
  /** Observed value with its unit. */
  readonly value: string;
  /** The rule's threshold with its unit, or `null` for context rows. */
  readonly threshold: string | null;
  readonly source: EvidenceSource;
}

export interface Snippet {
  readonly kind: 'gcloud' | 'terraform' | 'airflow-config' | 'dag-diff';
  readonly title: string;
  readonly language: 'bash' | 'hcl' | 'ini' | 'diff' | 'python';
  readonly code: string;
}

export interface DocLink {
  readonly title: string;
  readonly url: string;
}

export interface AdvisorFinding {
  /** Stable key: environment, rule and scope (one finding per rule and scope, FR-ADV-01). */
  readonly id: string;
  readonly ruleId: RuleId;
  readonly title: string;
  readonly category: FindingCategory;
  readonly scope: { readonly kind: ScopeKind; readonly id: string };
  readonly severity: Severity;
  readonly impact: Impact;
  readonly confidence: number;
  readonly effort: Effort;
  readonly tierWeight: number;
  readonly priorityScore: number;
  /** Observation → impact → action (spec §12.12), with the actual numbers and units. */
  readonly observation: string;
  readonly impactText: string;
  readonly action: string;
  /** "Why am I seeing this?": values, thresholds and data used (FR-ADV-08). */
  readonly why: string;
  readonly evidence: readonly EvidenceRow[];
  readonly remediation: readonly Snippet[];
  readonly risks: readonly string[];
  readonly rollback: string;
  readonly verify: string;
  /** DAGs the finding is about, largest contribution first. */
  readonly affectedDags: readonly string[];
  readonly links: { readonly wiki: string | null; readonly docs: readonly DocLink[] };
  /** Latest time the condition was observed (epoch ms); used for recency in ranking. */
  readonly detectedAt: number;
}

/** Default tier weights (spec §13.3). */
export const TIER_WEIGHTS: Readonly<Record<Tier, number>> = {
  prod: 1,
  uat: 0.6,
  test: 0.6,
  dev: 0.3,
  other: 0.3,
};

/** Supporting observations at which the sample factor reaches 1 (the rule model's `minSamples`). */
export const SAMPLE_SATURATION = 30;

/** Impact 1–5 on a log scale of hours per day (task-hours waiting or slot-hours wasted). */
export function impactFromHours(hoursPerDay: number): Impact {
  if (!(hoursPerDay >= 1)) return 1;
  return Math.min(5, 2 + Math.floor(Math.log10(hoursPerDay) + 1e-9)) as Impact;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Confidence (spec §13.3): share of the window with data × a sample factor that saturates at
 * {@link SAMPLE_SATURATION} supporting observations × agreement of independent signals.
 */
export function confidenceOf(c: {
  readonly coverage: number;
  readonly observations: number;
  readonly agreement: number;
}): number {
  return round2(clamp01(c.coverage) * clamp01(c.observations / SAMPLE_SATURATION) * clamp01(c.agreement));
}

/** `priority_score = tier_weight × impact × confidence ÷ effort` (spec §13.4). */
export function priorityScore(f: {
  readonly tierWeight: number;
  readonly impact: Impact;
  readonly confidence: number;
  readonly effort: Effort;
}): number {
  return round2((f.tierWeight * f.impact * f.confidence) / f.effort);
}

/**
 * FR-ADV-04 ranking: critical first, then priority score, then number of affected DAGs, then the
 * most recent observation; the ID keeps the order deterministic.
 */
export function rankFindings(findings: readonly AdvisorFinding[]): AdvisorFinding[] {
  const critical = (f: AdvisorFinding) => (f.severity === 'critical' ? 1 : 0);
  return [...findings].sort(
    (a, b) =>
      critical(b) - critical(a) ||
      b.priorityScore - a.priorityScore ||
      b.affectedDags.length - a.affectedDags.length ||
      b.detectedAt - a.detectedAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export interface Inhibition {
  readonly ruleId: RuleId;
  readonly scopeId: string;
  readonly by: RuleId;
}

/** Drops findings inhibited by another finding for the same scope (spec §13.2). */
export function applyInhibitions(
  findings: readonly AdvisorFinding[],
  inhibits: Partial<Readonly<Record<RuleId, readonly RuleId[]>>>,
): { kept: AdvisorFinding[]; inhibited: Inhibition[] } {
  const key = (ruleId: RuleId, f: AdvisorFinding) => `${ruleId}\u0000${f.scope.kind}\u0000${f.scope.id}`;
  const blockedBy = new Map<string, RuleId>();
  for (const f of findings)
    for (const target of inhibits[f.ruleId] ?? []) blockedBy.set(key(target, f), f.ruleId);
  const kept: AdvisorFinding[] = [];
  const inhibited: Inhibition[] = [];
  for (const f of findings) {
    const by = blockedBy.get(key(f.ruleId, f));
    if (by) inhibited.push({ ruleId: f.ruleId, scopeId: f.scope.id, by });
    else kept.push(f);
  }
  return { kept, inhibited };
}
