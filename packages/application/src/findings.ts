/**
 * Use case: the advisor's findings for one environment (S-18). Reads the last 24 h from the stores,
 * computes the environment signals, evaluates the rules and maps the ranked findings to the contract.
 * Remediation snippets are text for people to review and apply; nothing here runs them.
 *
 * @implements FR-ADV-01, FR-ADV-03, FR-ADV-04, FR-ADV-08, FR-DAGX-02
 */
import type { Finding, Findings, SourceId } from '@dcam/contracts';
import { ADVISOR_RULES, environmentSignals, evaluateAdvisor, type AdvisorFinding } from '@dcam/domain';
import type { Clock, EnvironmentModelSource, TaskInstanceStore } from '@dcam/ports';
import { SNAPSHOT_INTERVAL_MS } from './bottlenecks';
import { RANGE_MS } from './range';

/** Findings cover the last 24 hours (the contract's window). */
export const FINDINGS_WINDOW_MS = RANGE_MS['24h'];

export interface FindingsDeps {
  readonly store: TaskInstanceStore;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
}

export interface FindingsQuery {
  readonly envId: string;
  readonly sources: readonly SourceId[];
}

const iso = (ms: number) => new Date(ms).toISOString();

function toContract(f: AdvisorFinding, demo: boolean): Finding {
  return {
    id: f.id,
    rule_id: f.ruleId,
    title: f.title,
    category: f.category,
    scope: { kind: f.scope.kind, id: f.scope.id },
    severity: f.severity,
    status: 'open',
    impact: f.impact,
    confidence: f.confidence,
    effort: f.effort,
    tier_weight: f.tierWeight,
    priority_score: f.priorityScore,
    observation: f.observation,
    impact_text: f.impactText,
    action: f.action,
    why: f.why,
    // In demo mode every value is simulated, so evidence says so instead of naming a real source.
    evidence: f.evidence.map((e) => ({ ...e, source: demo ? 'DEMO' : e.source })),
    remediation: f.remediation.map((r) => ({ ...r })),
    risks: [...f.risks],
    rollback: f.rollback,
    verify: f.verify,
    affected_dags: [...f.affectedDags],
    links: { wiki: f.links.wiki, docs: f.links.docs.map((d) => ({ ...d })) },
    detected_at: iso(f.detectedAt),
  };
}

export async function getFindings(deps: FindingsDeps, q: FindingsQuery): Promise<Findings> {
  const now = deps.clock.now();
  const from = now - FINDINGS_WINDOW_MS;
  const config = await deps.model.config(q.envId);
  // Before the first configuration cycle no rule can run: say so rather than fail (spec §13.2).
  if (!config)
    return {
      env_id: q.envId,
      data_as_of: null,
      sources: [...q.sources],
      findings: [],
      not_evaluated: ADVISOR_RULES.map((r) => ({
        rule_id: r.id,
        title: r.title,
        reason: 'The environment configuration has not been collected yet.',
      })),
    };
  const [dags, snapshots, workerSamples, tries] = await Promise.all([
    deps.model.dags(q.envId),
    deps.model.snapshots(q.envId, from, now),
    deps.model.workerSamples(q.envId, from, now),
    deps.store.taskTries(q.envId, from, now),
  ]);
  const signals = environmentSignals({
    config,
    dags,
    snapshots,
    workerSamples,
    tries,
    from,
    to: now,
    snapshotIntervalMs: SNAPSHOT_INTERVAL_MS,
    // ⚠️ Until the M1 collectors report their own coverage, stored task history counts as complete.
    triesCoverage: 1,
    // Worker CPU and memory sizes come with the composer.config collector (M1); REC-CAP-08 waits for them.
    workerResources: null,
  });
  const result = evaluateAdvisor(signals);
  const latest = Math.max(snapshots.at(-1)?.at ?? -Infinity, workerSamples.at(-1)?.at ?? -Infinity);
  const demo = q.sources.includes('DEMO');
  const titles = new Map(ADVISOR_RULES.map((r) => [r.id, r.title]));
  return {
    env_id: q.envId,
    // Never "now" when nothing was collected: missing data must not look fresh (spec §8.1).
    data_as_of: Number.isFinite(latest) ? iso(latest) : null,
    sources: [...q.sources],
    findings: result.findings.map((f) => toContract(f, demo)),
    not_evaluated: result.insufficient.map((x) => ({
      rule_id: x.ruleId,
      title: titles.get(x.ruleId) ?? x.ruleId,
      reason: x.reason,
    })),
  };
}

/** Open findings per DAG: how many findings name the DAG among their affected DAGs (league table). */
export function countFindingsByDag(findings: readonly Pick<Finding, 'affected_dags'>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings)
    for (const dagId of new Set(f.affected_dags)) counts.set(dagId, (counts.get(dagId) ?? 0) + 1);
  return counts;
}

export async function getFindingCountsByDag(
  deps: FindingsDeps,
  q: FindingsQuery,
): Promise<Map<string, number>> {
  return countFindingsByDag((await getFindings(deps, q)).findings);
}
