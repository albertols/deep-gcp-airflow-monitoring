import { describe, expect, it } from 'vitest';
import { BACKFILL_MAXIMA, DEFAULT_BACKFILL, ProgressRate, backfillDays } from '../../src/index';
import { composerEntry, MIN, T0 } from './collectors-harness';

describe('FR-COLL-04 backfill days and ETA', () => {
  it('FR-COLL-04: 7 days of task instances and 14 days of metrics by default, clamped to the maxima', () => {
    expect(DEFAULT_BACKFILL).toEqual({ taskInstancesDays: 7, metricsDays: 14 });
    expect(BACKFILL_MAXIMA).toEqual({ taskInstancesDays: 90, metricsDays: 42 });
    expect(backfillDays(composerEntry)).toEqual({ taskInstancesDays: 7, metricsDays: 14 });
    expect(backfillDays({ ...composerEntry, backfill: { taskInstancesDays: 400, metricsDays: -3 } })).toEqual(
      { taskInstancesDays: 90, metricsDays: 0 },
    );
  });

  it('FR-COLL-04: no ETA until five minutes of progress are observed, then the remaining work at the observed rate', () => {
    const rate = new ProgressRate();
    rate.record(T0, 0);
    rate.record(T0 + 2 * MIN, 200);
    expect(rate.eta(T0 + 2 * MIN, 10_000)).toBeNull();
    rate.record(T0 + 5 * MIN, 500);
    // 100 items a minute: 10,000 left take 100 minutes.
    expect(rate.eta(T0 + 5 * MIN, 10_000)).toBe(6_000);
    expect(rate.eta(T0 + 5 * MIN, null)).toBeNull();
    expect(rate.eta(T0 + 5 * MIN, 0)).toBe(0);
  });

  it('FR-COLL-04: the rate is the last 30 minutes, so a slower phase shows in the ETA', () => {
    const rate = new ProgressRate();
    for (let m = 0; m <= 60; m++) rate.record(T0 + m * MIN, m <= 30 ? m * 100 : 3_000 + (m - 30) * 10);
    // The last 30 minutes ran at 10 items a minute.
    expect(rate.eta(T0 + 60 * MIN, 600)).toBe(3_600);
  });

  it('FR-COLL-04: no progress in the window means no ETA, never a made-up one', () => {
    const rate = new ProgressRate();
    for (let m = 0; m <= 10; m++) rate.record(T0 + m * MIN, 100);
    expect(rate.eta(T0 + 10 * MIN, 1_000)).toBeNull();
  });
});
