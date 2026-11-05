import { describe, expect, it } from 'vitest';
import { formatDuration, formatQuantile, formatShare, formatSlotHours } from '../src/components/format';

describe('number formatting (spec §12.7, §8.9)', () => {
  it('§12.7: humanises durations like "1h 12m"', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(42.4)).toBe('42s');
    expect(formatDuration(75)).toBe('1m 15s');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(4_320)).toBe('1h 12m');
    expect(formatDuration(90_000)).toBe('25h');
  });

  it('formats slot-hours with one decimal and shares as percentages', () => {
    expect(formatSlotHours(36_000)).toBe('10.0');
    expect(formatShare(0.2)).toBe('20%');
    expect(formatShare(0.1234)).toBe('12.3%');
    expect(formatShare(null)).toBe('—');
  });

  it('§8.9: marks a low-sample tail percentile as the max', () => {
    expect(formatQuantile({ value_seconds: 4_320, samples: 40, low_sample: false })).toBe('1h 12m');
    expect(formatQuantile({ value_seconds: 75, samples: 3, low_sample: true })).toBe('≤ 1m 15s');
    expect(formatQuantile({ value_seconds: null, samples: 0, low_sample: true })).toBe('—');
  });
});
