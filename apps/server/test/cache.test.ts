import { describe, expect, it } from 'vitest';
import { createMemo } from '../src/cache';

describe('NFR-PERF-01 short-lived memo for aggregated views', () => {
  it('returns the same result for the same key within the TTL, and recomputes after it', async () => {
    let now = 0;
    let calls = 0;
    const memo = createMemo({ ttlMs: 15_000, now: () => now });
    const compute = async () => ++calls;
    expect(await memo('fleet', compute)).toBe(1);
    now = 14_999;
    expect(await memo('fleet', compute)).toBe(1);
    now = 15_000;
    expect(await memo('fleet', compute)).toBe(2);
    expect(await memo('other', compute)).toBe(3);
  });

  it('shares one computation between concurrent requests', async () => {
    let calls = 0;
    const memo = createMemo({ ttlMs: 1_000, now: () => 0 });
    const compute = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return 'x';
    };
    await Promise.all([memo('k', compute), memo('k', compute), memo('k', compute)]);
    expect(calls).toBe(1);
  });

  it('does not keep failures', async () => {
    let calls = 0;
    const memo = createMemo({ ttlMs: 1_000, now: () => 0 });
    await expect(memo('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await memo('k', async () => ++calls)).toBe(1);
  });

  it('bounds its size by dropping the oldest entries', async () => {
    const memo = createMemo({ ttlMs: 60_000, now: () => 0, maxEntries: 2 });
    let calls = 0;
    await memo('a', async () => ++calls);
    await memo('b', async () => ++calls);
    await memo('c', async () => ++calls);
    expect(await memo('a', async () => ++calls)).toBe(4);
  });
});
