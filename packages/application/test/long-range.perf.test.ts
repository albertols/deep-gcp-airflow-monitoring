/**
 * NFR-PERF-01 benchmark at the first target profile: the DAG league and the bottleneck analysis over 7, 30
 * and 90 days for 2,000 DAGs and about 20,000 tries a day, from a synthetic store that answers like DuckDB.
 * Opt-in (`pnpm --filter @dcam/application test:perf`), because it generates millions of tries and its
 * timings depend on the machine; plain `vitest run` skips it. It prints the measured times and heap.
 */
import { describe, expect, it } from 'vitest';
import type { Range } from '@dcam/contracts';
import { getBottlenecks, getDagLeague } from '../src/index';
import { syntheticEnvironment } from './support/synthetic';

interface NodeProcess {
  readonly env: Readonly<Record<string, string | undefined>>;
  memoryUsage(): { heapUsed: number };
}
const proc = (globalThis as { process?: NodeProcess }).process;
const enabled = proc?.env['DCAM_PERF'] === '1';
/** 30 and 90 days generate 1.2 and 3.6 million tries: only with DCAM_PERF_LONG=1. */
const long = proc?.env['DCAM_PERF_LONG'] === '1';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const DAY = 86_400_000;
/** Target on the maintainer's Intel Mac (spec NFR-PERF-01 asks ≤ 500 ms p95 at reference scale, later with rollups). */
const BUDGET_MS = 2_000;
const heapMb = () => Math.round((proc?.memoryUsage().heapUsed ?? 0) / 1e6);

async function measure(range: Range, days: number) {
  const env = syntheticEnvironment({ now: NOW, days: 2 * days });
  const deps = { store: env.store, model: env.model, clock: { now: () => NOW } };
  const q = { envId: 'acme-prod', range, sources: ['DEMO' as const] };
  const heapBefore = heapMb();
  const t0 = performance.now();
  const league = await getDagLeague(deps, q);
  const t1 = performance.now();
  const bottlenecks = await getBottlenecks(deps, q);
  const t2 = performance.now();
  const result = {
    range,
    tries: env.tries.length,
    leagueMs: Math.round(t1 - t0),
    bottlenecksMs: Math.round(t2 - t1),
    heapBeforeMb: heapBefore,
    heapAfterMb: heapMb(),
  };
  console.log(`NFR-PERF-01 ${JSON.stringify(result)}`);
  return { league, bottlenecks, result };
}

describe.skipIf(!enabled)('NFR-PERF-01 long ranges at 2,000 DAGs', () => {
  it('NFR-PERF-01: the 7-day league and bottlenecks take under 2 s each at 2,000 DAGs and 20,000 tries a day', async () => {
    const { league, bottlenecks, result } = await measure('7d', 7);
    expect(league.rows).toHaveLength(2_000);
    expect(league.active_dag_count).toBe(2_000);
    expect(bottlenecks.series).toHaveLength(168);
    expect(result.leagueMs).toBeLessThan(BUDGET_MS);
    expect(result.bottlenecksMs).toBeLessThan(BUDGET_MS);
  });

  it.skipIf(!long)('NFR-PERF-01: measures the 30-day league and bottlenecks', async () => {
    const { league, bottlenecks } = await measure('30d', 30);
    expect(league.rows).toHaveLength(2_000);
    expect(bottlenecks.series).toHaveLength(240);
  });

  it.skipIf(!long)('NFR-PERF-01: measures the 90-day league and bottlenecks', async () => {
    const { league, bottlenecks } = await measure('90d', 90);
    expect(league.rows).toHaveLength(2_000);
    expect(bottlenecks.series).toHaveLength(360);
  });
});

// Keeps the generator honest at a small size in every run: about 20,000 tries a day across 2,000 DAGs.
describe('synthetic environment for NFR-PERF-01', () => {
  it('NFR-PERF-01: generates about 20,000 tries a day across 2,000 DAGs', () => {
    const env = syntheticEnvironment({ now: NOW, days: 1 });
    expect(env.dags).toHaveLength(2_000);
    expect(env.tries.length).toBeGreaterThan(18_000);
    expect(env.tries.length).toBeLessThan(22_000);
    expect(new Set(env.tries.map((t) => t.dagId)).size).toBe(2_000);
    expect(env.tries.every((t) => (t.startAt ?? 0) >= NOW - DAY && (t.startAt ?? 0) < NOW)).toBe(true);
  });
});
