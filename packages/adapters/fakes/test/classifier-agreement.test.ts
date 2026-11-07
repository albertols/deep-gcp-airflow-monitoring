/**
 * FR-BOTL-01 acceptance: the HM-006 classifier, given only what DCAM observes (live snapshots and
 * configuration), must agree with the simulator's ground truth about why work waited.
 */
import { describe, expect, it } from 'vitest';
import { classifySnapshot, type WaitReasonId } from '@dcam/domain';
import { acmeScenario, groundTruthKey, simulateEnvironment, type AcmeEnvironment } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

function compare(env: AcmeEnvironment) {
  const sim = simulateEnvironment({ seed: 42, now: NOW, hours: 6, scenario: acmeScenario(env) });
  const ctx = {
    config: sim.config,
    dagMaxActiveTasks: new Map(sim.dags.map((d) => [d.dagId, d.maxActiveTasks])),
  };
  let total = 0;
  let agree = 0;
  const byTruth = new Map<WaitReasonId, { total: number; agree: number }>();
  const confusion = new Map<string, number>();
  for (const s of sim.snapshots) {
    for (const c of classifySnapshot(s, ctx)) {
      const truth = sim.groundTruth.get(groundTruthKey(s.at, c.ti));
      if (!truth) continue;
      total++;
      const t = byTruth.get(truth) ?? { total: 0, agree: 0 };
      t.total++;
      if (truth === c.reason) {
        agree++;
        t.agree++;
      } else confusion.set(`${truth} → ${c.reason}`, (confusion.get(`${truth} → ${c.reason}`) ?? 0) + 1);
      byTruth.set(truth, t);
    }
  }
  return { total, agreement: agree / total, byTruth, confusion };
}

describe('FR-BOTL-01 classifier agreement with simulator ground truth', { timeout: 60_000 }, () => {
  it('FR-BOTL-01: acme-prod: ≥ 90 % of waiting is attributed to the reason that actually bound', () => {
    const r = compare('acme-prod');
    expect(r.total).toBeGreaterThan(1_000);
    expect(r.agreement, JSON.stringify(Object.fromEntries(r.confusion))).toBeGreaterThanOrEqual(0.9);
  });

  it('FR-BOTL-01: acme-prod saturated pool: ≥ 90 % of pool-bound waiting is attributed to "pool exhausted"', () => {
    const pool = compare('acme-prod').byTruth.get('pool-exhausted');
    expect(pool?.total).toBeGreaterThan(100);
    expect((pool?.agree ?? 0) / (pool?.total ?? 1)).toBeGreaterThanOrEqual(0.9);
  });

  it('FR-BOTL-01: acme-test: parallelism-bound waiting is attributed to "global parallelism"', () => {
    const r = compare('acme-test');
    const par = r.byTruth.get('parallelism');
    expect(r.agreement, JSON.stringify(Object.fromEntries(r.confusion))).toBeGreaterThanOrEqual(0.9);
    expect((par?.agree ?? 0) / (par?.total ?? 1)).toBeGreaterThanOrEqual(0.9);
  });
});
