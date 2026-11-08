import { describe, expect, it } from 'vitest';
import {
  TIER_WEIGHTS,
  applyInhibitions,
  confidenceOf,
  impactFromHours,
  priorityScore,
  rankFindings,
  type AdvisorFinding,
} from '../src/index';

const AT = Date.UTC(2026, 10, 5, 12, 0, 0);

const finding = (over: Partial<AdvisorFinding> = {}): AdvisorFinding => ({
  id: 'acme-prod:REC-DAG-01:dag:orders_daily',
  ruleId: 'REC-DAG-01',
  title: 'DAG throttled by max_active_tasks',
  category: 'dag',
  scope: { kind: 'dag', id: 'orders_daily' },
  severity: 'warning',
  impact: 3,
  confidence: 0.9,
  effort: 3,
  tierWeight: 1,
  priorityScore: 0.9,
  observation: 'o',
  impactText: 'i',
  action: 'a',
  why: 'w',
  evidence: [],
  remediation: [],
  risks: [],
  rollback: 'r',
  verify: 'v',
  affectedDags: ['orders_daily'],
  links: { wiki: null, docs: [] },
  detectedAt: AT,
  ...over,
});

describe('§13.3 impact, confidence and tier weight', () => {
  it('FR-ADV-04: impact is a log scale of hours per day, from 1 (minor) to 5 (severe)', () => {
    expect([0, 0.99, 1, 9.9, 10, 99, 100, 999, 1000, 1e6].map(impactFromHours)).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4, 5, 5,
    ]);
  });

  it('FR-ADV-04: confidence = coverage × sample factor × agreement, saturating at 30 observations', () => {
    expect(confidenceOf({ coverage: 1, observations: 30, agreement: 1 })).toBe(1);
    expect(confidenceOf({ coverage: 1, observations: 300, agreement: 1 })).toBe(1);
    expect(confidenceOf({ coverage: 0.9, observations: 15, agreement: 1 })).toBeCloseTo(0.45);
    expect(confidenceOf({ coverage: 1, observations: 30, agreement: 0.75 })).toBeCloseTo(0.75);
    expect(confidenceOf({ coverage: 1.4, observations: -3, agreement: 1 })).toBe(0);
  });

  it('FR-ADV-04: default tier weights are production 1.0, test 0.6, development 0.3', () => {
    expect(TIER_WEIGHTS.prod).toBe(1);
    expect(TIER_WEIGHTS.test).toBe(0.6);
    expect(TIER_WEIGHTS.dev).toBe(0.3);
  });

  it('FR-ADV-04: priority_score = tier_weight × impact × confidence ÷ effort', () => {
    expect(priorityScore({ tierWeight: 0.6, impact: 4, confidence: 0.5, effort: 2 })).toBeCloseTo(0.6);
    expect(priorityScore({ tierWeight: 1, impact: 5, confidence: 1, effort: 1 })).toBe(5);
  });
});

describe('§13.4 ranking (FR-ADV-04)', () => {
  it('FR-ADV-04: critical findings rank above others regardless of score', () => {
    const ranked = rankFindings([
      finding({ id: 'high', priorityScore: 4 }),
      finding({ id: 'crit', severity: 'critical', priorityScore: 0.1 }),
      finding({ id: 'low', priorityScore: 1 }),
    ]);
    expect(ranked.map((f) => f.id)).toEqual(['crit', 'high', 'low']);
  });

  it('FR-ADV-04: ties are broken by the number of affected DAGs, then by recency', () => {
    const ranked = rankFindings([
      finding({ id: 'old', affectedDags: ['a', 'b'], detectedAt: AT - 60_000 }),
      finding({ id: 'one-dag', affectedDags: ['a'], detectedAt: AT }),
      finding({ id: 'new', affectedDags: ['a', 'b'], detectedAt: AT }),
    ]);
    expect(ranked.map((f) => f.id)).toEqual(['new', 'old', 'one-dag']);
  });
});

describe('§13.2 inhibition', () => {
  it('REC-CAP-01: inhibits REC-CAP-05 for the same scope and records why', () => {
    const cap01 = finding({
      id: 'c1',
      ruleId: 'REC-CAP-01',
      scope: { kind: 'environment', id: 'acme-prod' },
    });
    const cap05 = finding({
      id: 'c5',
      ruleId: 'REC-CAP-05',
      scope: { kind: 'environment', id: 'acme-prod' },
    });
    const other = finding({
      id: 'c5-elsewhere',
      ruleId: 'REC-CAP-05',
      scope: { kind: 'environment', id: 'x' },
    });
    const { kept, inhibited } = applyInhibitions([cap01, cap05, other], { 'REC-CAP-01': ['REC-CAP-05'] });
    expect(kept.map((f) => f.id)).toEqual(['c1', 'c5-elsewhere']);
    expect(inhibited).toEqual([{ ruleId: 'REC-CAP-05', scopeId: 'acme-prod', by: 'REC-CAP-01' }]);
  });
});
