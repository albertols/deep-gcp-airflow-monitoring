import { describe, expect, it } from 'vitest';
import { slotSeconds } from '@dcam/domain';
import { groundTruthKey, simulateEnvironment, acmeScenario, type SimulationResult } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOUR = 3_600_000;

// One shared run per scenario keeps the suite fast; each test reads a different property.
const cache = new Map<string, SimulationResult>();
const sim = (env: 'acme-prod' | 'acme-test' | 'acme-dev', hours = 6, seed = 42) => {
  const key = `${env}/${hours}/${seed}`;
  let result = cache.get(key);
  if (!result) {
    result = simulateEnvironment({ seed, now: NOW, hours, scenario: acmeScenario(env) });
    cache.set(key, result);
  }
  return result;
};

describe('FR-EMU-01 / FR-EMU-03 scheduler simulator', { timeout: 60_000 }, () => {
  it('FR-EMU-01: is deterministic for a given seed and "now"', () => {
    const a = simulateEnvironment({ seed: 7, now: NOW, hours: 2, scenario: acmeScenario('acme-dev') });
    const b = simulateEnvironment({ seed: 7, now: NOW, hours: 2, scenario: acmeScenario('acme-dev') });
    const c = simulateEnvironment({ seed: 8, now: NOW, hours: 2, scenario: acmeScenario('acme-dev') });
    expect(a.tries).toEqual(b.tries);
    expect(a.snapshots).toEqual(b.snapshots);
    expect(c.tries).not.toEqual(a.tries);
  });

  it('FR-EMU-01: produces consistent tries: ready ≤ queued ≤ start ≤ end ≤ now, running tries end at null', () => {
    const { tries } = sim('acme-prod');
    expect(tries.length).toBeGreaterThan(1_000);
    const bad = tries.filter(
      (t) =>
        t.envId !== 'acme-prod' ||
        t.startAt === null ||
        t.queuedAt === null ||
        t.readyAt === null ||
        t.readyAt > t.queuedAt ||
        t.queuedAt > t.startAt ||
        t.startAt > NOW ||
        (t.endAt === null ? t.state !== 'running' : t.endAt < t.startAt || t.endAt > NOW),
    );
    expect({ count: bad.length, first: bad.slice(0, 2) }).toEqual({ count: 0, first: [] });
  });

  it('never exceeds a configured limit at any snapshot (pools, max_active_tasks, parallelism, worker slots)', () => {
    const { snapshots, config, dags } = sim('acme-prod');
    const limitOf = new Map(dags.map((d) => [d.dagId, d.maxActiveTasks]));
    const violations: string[] = [];
    for (const s of snapshots) {
      for (const p of s.pools) {
        if (p.running + p.queued > p.slots) violations.push(`${s.at} pool ${p.name}`);
        if (p.open !== Math.max(0, p.slots - p.running - p.queued)) violations.push(`${s.at} open ${p.name}`);
      }
      for (const [dagId, active] of Object.entries(s.dagActive))
        if (active > (limitOf.get(dagId) ?? Infinity)) violations.push(`${s.at} dag ${dagId}`);
      // Each scheduler enforces `parallelism` on its own executor; the simulator models their sum.
      if (s.executor.running + s.executor.queued > config.parallelism * config.schedulers)
        violations.push(`${s.at} parallelism`);
      if (s.executor.running > s.workers.current * config.workerConcurrency) violations.push(`${s.at} slots`);
      if (s.workers.current > config.maxWorkers || s.workers.current < config.minWorkers)
        violations.push(`${s.at} workers ${s.workers.current}`);
    }
    expect(violations.slice(0, 5)).toEqual([]);
  });

  it('FR-EMU-03: records a ground-truth reason for every waiting task instance in every snapshot', () => {
    const { snapshots, groundTruth } = sim('acme-prod');
    const waiting = snapshots.flatMap((s) =>
      [...s.scheduled, ...s.queued].map((ti) => groundTruthKey(s.at, ti)),
    );
    expect(waiting.length).toBeGreaterThan(100);
    expect(waiting.filter((k) => !groundTruth.has(k))).toEqual([]);
  });

  it('takes a snapshot every 30 s and a worker sample every minute, inside the window', () => {
    const { snapshots, workerSamples } = sim('acme-dev', 2);
    expect(snapshots).toHaveLength(2 * 120);
    expect(workerSamples).toHaveLength(2 * 60);
    expect(snapshots[0]?.at).toBe(NOW - 2 * HOUR);
    expect(snapshots.at(-1)?.at).toBe(NOW - 30_000);
  });

  it('FR-EMU-03 acme-prod: workers hit max_count, the external_api pool starves, a DAG hits max_active_tasks', () => {
    const { groundTruth, workerSamples, config, tries } = sim('acme-prod');
    const reasons = new Set(groundTruth.values());
    expect(reasons).toContain('executor-slots-exhausted');
    expect(reasons).toContain('autoscaling-lag');
    expect(reasons).toContain('pool-exhausted');
    expect(reasons).toContain('dag-max-active-tasks');
    expect(workerSamples.some((w) => w.workers === config.maxWorkers)).toBe(true);
    expect(tries.some((t) => t.operator?.endsWith('Sensor'))).toBe(true);
  });

  it('FR-EMU-03 acme-test: parallelism binds before worker capacity', () => {
    const { groundTruth, config } = sim('acme-test');
    expect(config.parallelism * config.schedulers).toBeLessThan(config.maxWorkers * config.workerConcurrency);
    expect(new Set(groundTruth.values())).toContain('parallelism');
  });

  it('FR-EMU-01: concentrates load on a few DAGs, like real environments (Pareto)', () => {
    const { tries } = sim('acme-prod');
    const window = { from: NOW - 6 * HOUR, to: NOW, now: NOW };
    const { byDag, totalExecutorSlotSeconds } = slotSeconds(tries, window);
    const shares = [...byDag.values()]
      .map((d) => d.executorSlotSeconds / totalExecutorSlotSeconds)
      .sort((a, b) => b - a);
    const top20pct = shares.slice(0, Math.ceil(shares.length * 0.2)).reduce((s, x) => s + x, 0);
    expect(byDag.size).toBeGreaterThan(100); // daily DAGs run once a day, so not all are active in 6 h
    expect(top20pct).toBeGreaterThan(0.5);
  });

  it('describes every DAG and pool the tries refer to', () => {
    const { tries, dags, config } = sim('acme-prod');
    const dagIds = new Set(dags.map((d) => d.dagId));
    const pools = new Set(config.pools.map((p) => p.name));
    expect(tries.filter((t) => !dagIds.has(t.dagId) || !pools.has(t.pool))).toEqual([]);
  });
});

/** Longest stretch of consecutive `true` values. */
const longestStretch = (xs: readonly boolean[]) =>
  xs.reduce((acc, x) => ({ run: x ? acc.run + 1 : 0, max: Math.max(acc.max, x ? acc.run + 1 : 0) }), {
    run: 0,
    max: 0,
  }).max;

describe('FR-EMU-03 acme-prod nightly batch window', { timeout: 120_000 }, () => {
  // Prod's workers-at-maximum story (REC-CAP-01, AL-05) must show in every 24 h window, whatever the hour
  // the demo starts: in the afternoon, and in the middle of the night's batch window.
  it.each([
    ['in the afternoon', NOW, 42],
    ['during the batch window', Date.UTC(2026, 10, 5, 2, 0, 0), 42],
    ['with another seed', NOW, 7],
  ])('REC-CAP-01 / AL-05: workers stay at max_count with tasks queued, %s', (_label, now, seed) => {
    const { workerSamples, config } = simulateEnvironment({
      seed,
      now,
      hours: 24,
      scenario: acmeScenario('acme-prod'),
    });
    const slots = config.maxWorkers * config.workerConcurrency;
    // REC-CAP-01's bound minute: workers at max_count and ≥ max(10, 20 % of worker slots) queued.
    const bound = workerSamples.map(
      (w) => w.workers === config.maxWorkers && w.queued >= Math.max(10, 0.2 * slots),
    );
    // AL-05's condition: workers at max_count and ≥ 10 queued, for 15 min.
    const al05 = workerSamples.map((w) => w.workers === config.maxWorkers && w.queued >= 10);
    expect(bound.filter(Boolean).length).toBeGreaterThanOrEqual(30);
    expect(longestStretch(al05)).toBeGreaterThanOrEqual(20);
  });
});
