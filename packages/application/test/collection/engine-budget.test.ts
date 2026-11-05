import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError } from '../../src/index';
import { BudgetGate, HARD_MAXIMA, TokenBucket, effectiveBudgets } from '../../src/collection/budget';
import { FakeTime, T0, composerEnv, maxInWindow, workspace } from './engine-harness';

describe('TokenBucket (FR-COLL-06)', () => {
  it('NFR-OBS-01: never admits more than the per-minute budget in any 60 s window', () => {
    let rate = 12;
    const bucket = new TokenBucket(() => rate);
    const taken: number[] = [];
    // Try to take a token every 100 ms for 10 minutes, halving the rate half-way (patient mode).
    for (let t = T0; t < T0 + 600_000; t += 100) {
      if (t === T0 + 300_000) rate = 6;
      if (bucket.available(t) >= 1) {
        bucket.take(t);
        taken.push(t);
      }
    }
    expect(maxInWindow(taken.filter((t) => t < T0 + 300_000))).toBe(12);
    expect(maxInWindow(taken.filter((t) => t >= T0 + 360_000))).toBe(6);
    expect(taken.length).toBeGreaterThanOrEqual(5 * 12 + 4 * 6);
  });

  it('FR-COLL-06: tells when the requested number of tokens is back', () => {
    const bucket = new TokenBucket(() => 4);
    bucket.take(T0);
    bucket.take(T0 + 1_000);
    bucket.take(T0 + 2_000);
    expect(bucket.available(T0 + 2_000)).toBe(1);
    expect(bucket.availableAt(T0 + 2_000, 1)).toBe(T0 + 2_000);
    expect(bucket.availableAt(T0 + 2_000, 2)).toBe(T0 + 60_000);
    expect(bucket.availableAt(T0 + 2_000, 4)).toBe(T0 + 62_000);
    expect(bucket.availableAt(T0 + 2_000, 5)).toBe(Infinity);
  });

  it('FR-COLL-06: a budget below one request per minute spaces requests out', () => {
    const bucket = new TokenBucket(() => 0.5);
    bucket.take(T0);
    expect(bucket.available(T0 + 60_000)).toBe(0);
    expect(bucket.availableAt(T0, 1)).toBe(T0 + 120_000);
    expect(new TokenBucket(() => 0).availableAt(T0, 1)).toBe(Infinity);
  });
});

describe('BudgetGate (FR-COLL-02, FR-COLL-06)', () => {
  const gate = (time: FakeTime, rate: number, maxConcurrent = Infinity, backgroundRate?: number) =>
    new BudgetGate({
      api: 'airflow',
      clock: time,
      sleeper: time,
      bucket: new TokenBucket(() => rate),
      ...(backgroundRate === undefined ? {} : { backgroundBucket: new TokenBucket(() => backgroundRate) }),
      maxConcurrent: () => maxConcurrent,
    });

  it('FR-COLL-02: serves the higher-priority collector first when a token comes back', async () => {
    const time = new FakeTime();
    const g = gate(time, 4);
    for (let i = 0; i < 4; i++) (await g.acquire({ priority: 'live', deadline: T0 }))();
    const order: string[] = [];
    const wait = (priority: 'live' | 'standard' | 'background') =>
      g.acquire({ priority, deadline: T0 + 300_000 }).then((release) => {
        order.push(`${priority}@${time.now() - T0}`);
        release();
      });
    const all = Promise.all([wait('background'), wait('standard'), wait('live')]);
    await time.settle(all);
    expect(order).toEqual(['live@60000', 'standard@60000', 'background@60000']);
  });

  it('FR-COLL-02: background work takes a token only while the bucket is at least half full', async () => {
    const time = new FakeTime();
    const g = gate(time, 4);
    for (let i = 0; i < 3; i++) (await g.acquire({ priority: 'live', deadline: T0 }))();
    const background = g.acquire({ priority: 'background', deadline: T0 + 300_000 }).then(() => time.now());
    // One token is left: live work gets it at once, background work waits for half the bucket.
    (await g.acquire({ priority: 'live', deadline: T0 }))();
    expect(await time.settle(background)).toBe(T0 + 60_000);
  });

  it('FR-COLL-06: background work also stays within the background budget class', async () => {
    const time = new FakeTime();
    const g = gate(time, 60, Infinity, 2);
    const at: number[] = [];
    const run = async () => {
      for (let i = 0; i < 6; i++) {
        (await g.acquire({ priority: 'background', deadline: T0 + 600_000 }))();
        at.push(time.now() - T0);
      }
    };
    await time.settle(run());
    expect(at).toEqual([0, 0, 60_000, 60_000, 120_000, 120_000]);
  });

  it('FR-COLL-06: a request that cannot get a token before its deadline fails with BudgetExhaustedError', async () => {
    const time = new FakeTime();
    const g = gate(time, 1);
    (await g.acquire({ priority: 'live', deadline: T0 }))();
    // The token comes back at T0 + 60 s, after the deadline: refused at once, without waiting.
    await expect(g.acquire({ priority: 'live', deadline: T0 + 10_000 })).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(time.now()).toBe(T0);
    // A standard request that would get it in time loses it to a live one, and gives up as soon as the
    // next token (T0 + 120 s) is known to come after its deadline.
    const standard = g.acquire({ priority: 'standard', deadline: T0 + 70_000 }).then(
      () => 'granted',
      (e: unknown) => `${e instanceof BudgetExhaustedError ? 'exhausted' : 'other'}@${time.now() - T0}`,
    );
    await time.advance(30_000);
    const live = g
      .acquire({ priority: 'live', deadline: T0 + 100_000 })
      .then(() => `live@${time.now() - T0}`);
    expect(await time.settle(Promise.all([standard, live]))).toEqual(['exhausted@60000', 'live@60000']);
    expect(time.pending).toBe(0);
  });

  it('NFR-OBS-01: limits concurrent requests', async () => {
    const time = new FakeTime();
    const g = gate(time, 100, 2);
    const first = await g.acquire({ priority: 'live', deadline: T0 });
    await g.acquire({ priority: 'live', deadline: T0 });
    let third = false;
    const pending = g.acquire({ priority: 'live', deadline: T0 + 10_000 }).then(() => {
      third = true;
    });
    await time.advance(1_000);
    expect(third).toBe(false);
    first();
    await time.settle(pending);
    expect(third).toBe(true);
    // Waiting for a free slot is bounded by the deadline as well.
    const late = g.acquire({ priority: 'live', deadline: time.now() + 10_000 }).then(
      () => 'granted',
      () => `exhausted@${time.now() - T0}`,
    );
    expect(await time.settle(late)).toBe('exhausted@11000');
  });

  it('FR-COLL-06: stopping rejects every waiter', async () => {
    const time = new FakeTime();
    const g = gate(time, 1);
    (await g.acquire({ priority: 'live', deadline: T0 }))();
    const waiting = g.acquire({ priority: 'live', deadline: T0 + 120_000 });
    g.rejectAll();
    await expect(waiting).rejects.toBeInstanceOf(BudgetExhaustedError);
    await time.advance(0);
    expect(time.pending).toBe(0);
  });
});

describe('effectiveBudgets (FR-COLL-06, §7.11 hard maxima)', () => {
  it('FR-COLL-06: clamps a configuration above the hard maxima', () => {
    const config = workspace([composerEnv('acme-prod', 'live')], {
      airflowApi: { live: 500, standard: 12, eco: 4, background: 300, maxConcurrent: 10 },
      monitoringPerProjectPerMinute: 1_000,
      composerApiPerMinute: 99,
    });
    expect(HARD_MAXIMA).toEqual({
      airflowPerMinute: 120,
      airflowConcurrent: 4,
      monitoringPerMinute: 120,
      composerPerMinute: 30,
    });
    expect(effectiveBudgets(config.budgets, 'live')).toEqual({
      airflow: 120,
      airflowBackground: 120,
      airflowConcurrent: 4,
      monitoring: 120,
      composer: 30,
    });
    expect(effectiveBudgets(config.budgets, 'standard').airflow).toBe(12);
    expect(effectiveBudgets(config.budgets, 'off')).toEqual({
      airflow: 0,
      airflowBackground: 0,
      airflowConcurrent: 4,
      monitoring: 0,
      composer: 0,
    });
  });
});
