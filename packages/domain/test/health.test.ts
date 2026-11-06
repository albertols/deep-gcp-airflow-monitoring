import { describe, expect, it } from 'vitest';
import { HEALTH_MIN_WEIGHT_COVERAGE, healthScore, type PlatformHealth } from '../src/index';

const healthy: PlatformHealth = {
  envHealthyRatio: 1,
  dbHealthyRatio: 1,
  heartbeatCompleteness: 1,
  webServerHealthyRatio: 1,
  dbCpuMemoryMax: 0.3,
  zombies24h: 0,
  workerRestarts24h: 0,
  importErrors: 0,
  parseLoopP95Seconds: 60,
};

describe('HM-028 explainable health score (spec L1370–1391)', () => {
  it('HM-028: all nine checks passing scores 100 and is healthy', () => {
    const h = healthScore(healthy);
    expect(h).toMatchObject({ score: 100, label: 'healthy', evaluated: 9, total: 9 });
    expect(h.checks.every((c) => c.state === 'pass')).toBe(true);
  });

  it('HM-028: subtracts the weights of failing checks', () => {
    const h = healthScore({ ...healthy, workerRestarts24h: 3, dbCpuMemoryMax: 0.85 });
    expect(h.score).toBe(100 - 5 - 10);
    expect(h.checks.find((c) => c.id === 'worker-restarts')).toMatchObject({
      state: 'fail',
      value: '3',
      weight: 5,
    });
  });

  it('HM-028: caps the score at 40 when a critical check fails', () => {
    const h = healthScore({ ...healthy, heartbeatCompleteness: 0.8 });
    expect(h.score).toBe(40);
    expect(h.label).toBe('unhealthy');
    expect(h.checks.find((c) => c.id === 'heartbeat')).toMatchObject({ state: 'fail', critical: true });
  });

  it('HM-028: checks without data are unknown, excluded from the score and shown in coverage', () => {
    const h = healthScore({ ...healthy, webServerHealthyRatio: null, importErrors: 4 });
    expect(h).toMatchObject({ score: 95, evaluated: 8, total: 9 });
    expect(h.checks.find((c) => c.id === 'web-server')).toMatchObject({ state: 'unknown', value: null });
  });

  it('HM-028: no data at all gives no score and an unknown label', () => {
    const none = Object.fromEntries(Object.keys(healthy).map((k) => [k, null])) as unknown as PlatformHealth;
    expect(healthScore(none)).toMatchObject({ score: null, label: 'unknown', evaluated: 0 });
  });

  it('labels 50–79 as degraded (bands are a feature-001 call; the spec leaves them open)', () => {
    const h = healthScore({
      ...healthy,
      dbCpuMemoryMax: 0.9,
      zombies24h: 3,
      workerRestarts24h: 2,
      importErrors: 1,
    });
    expect(h).toMatchObject({ score: 75, label: 'degraded' });
  });

  it('HM-028: below 80 % of the check weight with data the label is "partial" and there is no score', () => {
    expect(HEALTH_MIN_WEIGHT_COVERAGE).toBe(0.8);
    const none = Object.fromEntries(Object.keys(healthy).map((k) => [k, null])) as unknown as PlatformHealth;
    // One check of weight 5 with data, and it fails: not "healthy, 95".
    const h = healthScore({ ...none, importErrors: 1 });
    expect(h).toMatchObject({ score: null, label: 'partial', evaluated: 1, total: 9 });
    expect(h.checks.find((c) => c.id === 'import-errors')?.state).toBe('fail');
  });

  it('HM-028: at 80 % of the weight the score is labelled as usual', () => {
    // Without database CPU (10), web server (5) and parse loop (5): 80 of 100.
    const h = healthScore({
      ...healthy,
      dbCpuMemoryMax: null,
      webServerHealthyRatio: null,
      parseLoopP95Seconds: null,
    });
    expect(h).toMatchObject({ score: 100, label: 'healthy', evaluated: 6 });
  });

  it('HM-028: a failing critical check is unhealthy even at low coverage (the cap is definitive)', () => {
    const none = Object.fromEntries(Object.keys(healthy).map((k) => [k, null])) as unknown as PlatformHealth;
    expect(healthScore({ ...none, heartbeatCompleteness: 0.5 })).toMatchObject({
      score: 40,
      label: 'unhealthy',
      evaluated: 1,
    });
  });
});
