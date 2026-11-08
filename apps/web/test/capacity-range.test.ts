import { describe, expect, it } from 'vitest';
import type { Range } from '@dcam/contracts';
import { capacityRangeOf } from '../src/pages/capacity/range';

describe('Capacity range mapping (FR-ENV-02, FR-UI-01)', () => {
  it.each<[Range, string]>([
    ['15m', '1h'],
    ['1h', '1h'],
    ['6h', '6h'],
    ['24h', '24h'],
    ['7d', '7d'],
    ['30d', '7d'],
    ['90d', '7d'],
  ])('FR-UI-01: the context bar range %s asks the capacity analysis for %s', (range, asked) => {
    expect(capacityRangeOf(range).range).toBe(asked);
  });

  it('FR-UI-01: a mapped range is never silent: the note names the range shown and why', () => {
    expect(capacityRangeOf('15m').note).toBe(
      'Capacity covers the last hour: the shortest range it analyses. The last 15 minutes you picked apply to the other pages.',
    );
    expect(capacityRangeOf('30d').note).toBe(
      'Capacity covers the last 7 days: the longest range it analyses, as it works minute by minute. The last 30 days you picked apply to the other pages.',
    );
    expect(capacityRangeOf('90d').note).toMatch(/^Capacity covers the last 7 days: /);
  });

  it('FR-UI-01: a supported range needs no note', () => {
    for (const r of ['1h', '6h', '24h', '7d'] as const) expect(capacityRangeOf(r).note).toBeNull();
  });
});
