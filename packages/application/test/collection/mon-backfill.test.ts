import { describe, expect, it } from 'vitest';
import type { MetricQuery, MetricSeries } from '@dcam/ports';
import { DAY_MS, MON_INGESTION_DELAY_MS, monBackfillCollector } from '../../src/index';
import {
  Budget,
  composerEntry,
  emulatorEntry,
  fakeContext,
  FakeMonitoring,
  MemoryStore,
  MIN,
  T0,
  type FakeContext,
} from './collectors-harness';

const M = 'composer.googleapis.com/';
const GIB = 1024 ** 3;
/** The boundary: now minus the ingestion delay, on a minute (T0 is on a minute). */
const B = T0 - MON_INGESTION_DELAY_MS;
const DAY = DAY_MS;

/** One series with a point at the end of every aligned interval after `from`, up to `to`. */
const aligned = (q: MetricQuery, value: (at: number) => number | undefined, resourceLabels = {}) => {
  const points: Array<{ at: number; value: number }> = [];
  const step = q.alignmentPeriodSeconds * 1000;
  for (let at = q.from + step; at <= q.to; at += step) {
    const v = value(at);
    if (v !== undefined) points.push({ at, value: v });
  }
  return { metricLabels: {}, resourceLabels, points };
};

/** Three workers at 2 vCPU and 8 GiB; metrics exist only after `since` (when the environment was created). */
function respond(since = -Infinity) {
  const values: Record<string, (at: number) => number | undefined> = {
    'environment/num_celery_workers': () => 3,
    'environment/worker/scale_factor_target': () => 1,
    'environment/executor/running_tasks': () => 10,
    'environment/executor/queued_tasks': () => 4,
    'workload/cpu/usage_time': () => 1,
    'workload/cpu/reserved_cores': () => 2,
    'workload/memory/bytes_used': () => 4 * GIB,
    'workload/memory/quota': () => 8 * GIB,
  };
  return (q: MetricQuery): MetricSeries[] => {
    const name = q.metricType.slice(M.length);
    const at = (f: (t: number) => number | undefined) => (t: number) => (t > since ? f(t) : undefined);
    if (q.groupBy?.includes('resource.labels.type'))
      return ['scheduler', 'celery-worker'].map((type) =>
        aligned(
          { ...q, from: q.to - MIN },
          at(() => GIB),
          { type },
        ),
      );
    const f = values[name];
    if (!f) return [];
    const series = aligned(q, at(f));
    return series.points.length ? [series] : [];
  };
}

const lastReport = (ctx: FakeContext) => ctx.reports.at(-1);

async function backfill(ctx: FakeContext, collector = monBackfillCollector(), cycles = 100) {
  for (let i = 0; i < cycles; i++) {
    await collector.collect(ctx);
    if (lastReport(ctx)?.state === 'complete') return i + 1;
    ctx.advance(MIN);
  }
  return cycles;
}

describe('FR-COLL-04 mon.backfill: fourteen days of worker samples', () => {
  it('FR-COLL-04: reads 14 days before now minus the ingestion delay, newest first, one day a cycle at 60 s', async () => {
    const monitoring = new FakeMonitoring(respond());
    const store = new MemoryStore();
    const ctx = fakeContext({ store, monitoring });
    const cycles = await backfill(ctx);
    expect(cycles).toBe(14);
    // One sample per minute in (B − 14 days, B]: 20,160, none after B (FR-COLL-07).
    expect(store.samples.size).toBe(14 * 1_440);
    expect(Math.max(...store.samples.keys())).toBe(B);
    expect(Math.min(...store.samples.keys())).toBe(B - 14 * DAY + MIN);
    const sampleQueries = monitoring.queries.filter((q) => q.metricType.endsWith('num_celery_workers'));
    expect(sampleQueries.map((q) => [q.from, q.to, q.alignmentPeriodSeconds])[0]).toEqual([B - DAY, B, 60]);
    expect(sampleQueries).toHaveLength(14);
    // Discovery once, then two limits and six series a day: 113 queries and 113 series (NFR-OBS-06).
    expect(monitoring.queries).toHaveLength(1 + 14 * 8);
    expect(ctx.seriesCounted.reduce((a, b) => a + b, 0)).toBe(2 + 14 * 8);
    expect(lastReport(ctx)).toMatchObject({
      state: 'complete',
      days: 14,
      from: B - 14 * DAY,
      to: B,
      coveredFrom: B - 14 * DAY,
      itemsRead: 14 * 1_440,
      requestsUsed: 113,
      etaSeconds: 0,
    });
  });

  it('FR-COLL-06: a day cut short by the budget keeps the series it read and asks only for the rest', async () => {
    const monitoring = new FakeMonitoring(respond(), new Budget('monitoring', 0));
    const store = new MemoryStore();
    const ctx = fakeContext({
      store,
      monitoring,
      env: { ...composerEntry, backfill: { taskInstancesDays: 7, metricsDays: 2 } },
    });
    const collector = monBackfillCollector();
    for (let i = 0; i < 20 && lastReport(ctx)?.state !== 'complete'; i++) {
      monitoring.budget.limit = monitoring.budget.used + 5;
      await collector.collect(ctx);
      ctx.advance(MIN);
    }
    expect(lastReport(ctx)?.state).toBe('complete');
    expect(monitoring.queries).toHaveLength(1 + 2 * 8);
    expect(store.samples.size).toBe(2 * 1_440);
    expect(ctx.fidelity).toEqual([]);
  });

  it('NFR-DATA-03: days before the environment reported metrics stay a gap, never zeros', async () => {
    const monitoring = new FakeMonitoring(respond(B - 3 * DAY));
    const store = new MemoryStore();
    const ctx = fakeContext({ store, monitoring });
    await backfill(ctx);
    expect(store.samples.size).toBe(3 * 1_440);
    expect(Math.min(...store.samples.keys())).toBe(B - 3 * DAY + MIN);
    expect(lastReport(ctx)).toMatchObject({ state: 'complete', coveredFrom: B - 14 * DAY });
  });

  it('FR-COLL-04: an empty worker discovery is asked again next cycle, not kept until a restart', async () => {
    let visible = false;
    const answer = respond();
    const monitoring = new FakeMonitoring((q) =>
      q.groupBy?.includes('resource.labels.type') && !visible ? [] : answer(q),
    );
    const store = new MemoryStore();
    const ctx = fakeContext({ store, monitoring });
    const collector = monBackfillCollector();
    await collector.collect(ctx);
    expect(ctx.fidelity.at(-1)).toMatch(/No Celery worker workload metrics/);
    visible = true;
    ctx.advance(MIN);
    expect(await backfill(ctx, collector)).toBeLessThan(100);
    expect(store.samples.size).toBe(14 * 1_440);
  });

  it('FR-COLL-03: a restart resumes at the covered start with the same boundary', async () => {
    const monitoring = new FakeMonitoring(respond());
    const store = new MemoryStore();
    const ctx = fakeContext({ store, monitoring });
    const first = monBackfillCollector();
    for (let i = 0; i < 3; i++) {
      await first.collect(ctx);
      ctx.advance(MIN);
    }
    expect((await store.backfill('acme-prod', 'mon.backfill'))?.coveredFrom).toBe(B - 3 * DAY);
    ctx.advance(3 * 60 * MIN);
    const seen = monitoring.queries.length;
    await backfill(ctx, monBackfillCollector());
    const next = monitoring.queries.slice(seen).find((q) => q.metricType.endsWith('num_celery_workers'));
    expect([next?.from, next?.to]).toEqual([B - 4 * DAY, B - 3 * DAY]);
    expect(store.samples.size).toBe(14 * 1_440);
    expect(lastReport(ctx)).toMatchObject({ state: 'complete', to: B });
  });

  it('FR-COLL-04: 0 days turns it off', async () => {
    const monitoring = new FakeMonitoring(respond());
    const ctx = fakeContext({
      monitoring,
      env: { ...composerEntry, backfill: { taskInstancesDays: 7, metricsDays: 0 } },
    });
    await monBackfillCollector().collect(ctx);
    expect(monitoring.queries).toEqual([]);
    expect(lastReport(ctx)).toMatchObject({ state: 'disabled', days: 0 });
  });

  it('FR-COLL-01: declares a background Monitoring backfill for Composer environments only', async () => {
    expect(monBackfillCollector().manifest).toMatchObject({
      id: 'mon.backfill',
      source: 'SRC-MON',
      api: 'monitoring',
      priority: 'background',
      outputs: ['samples'],
      sourceKinds: ['composer'],
      backfill: 'metrics',
    });
    await expect(monBackfillCollector().collect(fakeContext({ env: emulatorEntry }))).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });
});
