import { describe, expect, it } from 'vitest';
import { environmentLoad } from '@dcam/domain';
import type { StoredTaskTry } from '@dcam/ports';
import { openStore } from '../src/index';
import { ENV, T0, tryRow } from './fixtures';

const S = 1_000;
const M = 60 * S;
const H = 60 * M;

/** mulberry32: deterministic test data. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Tries around [T0, T0 + 6 h): some running, some never started, some ending before they start. */
function tries(seed: number, n: number): StoredTaskTry[] {
  const random = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const kind = random();
    const startAt = T0 - 2 * H + Math.floor(random() * 9 * H);
    const length = Math.floor(random() * 3 * H) - 5 * M;
    return tryRow({
      dagId: `acme_dag_${i % 7}`,
      runId: `scheduled__${i}`,
      taskId: `t${i}`,
      pool: random() < 0.3 ? 'etl' : 'default_pool',
      poolSlots: 1 + Math.floor(random() * 3),
      startAt: kind < 0.05 ? null : startAt,
      endAt: kind < 0.15 ? null : startAt + length,
      state: kind < 0.15 ? 'running' : 'success',
      envId: random() < 0.1 ? 'acme-test' : ENV,
    });
  });
}

describe('FR-DAGD-08 environment load in the store', { timeout: 60_000 }, () => {
  it('NFR-PERF / HM-003: the SQL aggregate equals the domain function on the same tries', async () => {
    const store = await openStore({ path: ':memory:' });
    const rows = tries(11, 2_000);
    await store.upsertTaskTries(rows);
    const stored = rows.filter((t) => t.envId === ENV);
    for (const [from, to, now, bucketMs] of [
      [T0, T0 + 6 * H, T0 + 6 * H, H],
      // A window start between hours, and "now" before the window end: later time has not happened.
      [T0 + 17 * M + 123, T0 + 5 * H, T0 + 4 * H + 31 * S, H],
      [T0 + 7 * S, T0 + 2 * H, T0 + 2 * H, 15 * M],
    ] as const) {
      const origin = Math.floor(from / bucketMs) * bucketMs;
      const expected = environmentLoad(stored, { from, to, now }, bucketMs, origin);
      const actual = await store.environmentLoad(ENV, from, to, now, bucketMs);
      expect(actual.origin).toBe(origin);
      expect(actual.bucketMs).toBe(bucketMs);
      expect(actual.executorSlotSeconds).toHaveLength(expected.executorSlotSeconds.length);
      actual.executorSlotSeconds.forEach((x, k) =>
        expect(x).toBeCloseTo(expected.executorSlotSeconds[k] ?? NaN, 6),
      );
      expect([...actual.poolSlotSeconds.keys()].sort()).toEqual([...expected.poolSlotSeconds.keys()].sort());
      for (const [pool, seconds] of expected.poolSlotSeconds)
        expect(actual.poolSlotSeconds.get(pool)).toBeCloseTo(seconds, 6);
    }
    store.close();
  });

  it('HM-003: an environment without tries has zero load in every bucket', async () => {
    const store = await openStore({ path: ':memory:' });
    const load = await store.environmentLoad('acme-dev', T0, T0 + 2 * H, T0 + 2 * H, H);
    expect(load).toEqual({
      origin: T0 - (T0 % H),
      bucketMs: H,
      executorSlotSeconds: [0, 0, 0],
      poolSlotSeconds: new Map(),
    });
    store.close();
  });
});
