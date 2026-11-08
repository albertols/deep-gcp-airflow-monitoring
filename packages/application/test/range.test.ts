import { describe, expect, it } from 'vitest';
import type { Range } from '@dcam/contracts';
import { CHART_BUCKET_MS, RANGES, RANGE_MS } from '../src/index';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('time range presets (FR-UI-01)', () => {
  it('FR-UI-01: offers presets from 15 minutes to 90 days, shortest first', () => {
    expect(RANGES).toEqual(['15m', '1h', '6h', '24h', '7d', '30d', '90d']);
    const lengths: Record<Range, number> = {
      '15m': 15 * MIN,
      '1h': HOUR,
      '6h': 6 * HOUR,
      '24h': DAY,
      '7d': 7 * DAY,
      '30d': 30 * DAY,
      '90d': 90 * DAY,
    };
    expect(RANGE_MS).toEqual(lengths);
  });

  it('NFR-PERF-06: chart buckets keep every range between 15 and 360 points, on whole minutes', () => {
    for (const range of RANGES) {
      const points = RANGE_MS[range] / CHART_BUCKET_MS[range];
      expect(Number.isInteger(points), range).toBe(true);
      expect(points, range).toBeGreaterThanOrEqual(15);
      expect(points, range).toBeLessThanOrEqual(360);
      expect(CHART_BUCKET_MS[range] % MIN, range).toBe(0);
    }
  });

  it('NFR-PERF-06: keeps the existing buckets and uses hours for the long ranges', () => {
    expect(CHART_BUCKET_MS).toEqual({
      '15m': MIN,
      '1h': MIN,
      '6h': 5 * MIN,
      '24h': 15 * MIN,
      '7d': HOUR,
      '30d': 3 * HOUR,
      '90d': 6 * HOUR,
    });
  });
});
