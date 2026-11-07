import { describe, expect, it } from 'vitest';
import {
  clause,
  formatBytes,
  formatCadence,
  formatDuration,
  formatSchedule,
  formatQuantile,
  formatShare,
  formatSlotHours,
} from '../src/components/format';

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

  it('HM-030: formats byte counts in decimal units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(3_100)).toBe('3.1 kB');
    expect(formatBytes(52_400_000)).toBe('52.4 MB');
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB');
  });
});

describe('plain-word schedules, cadences and messages (spec §12.12)', () => {
  it('§12.12: timedelta schedules read as "every …", cron stays as written', () => {
    expect(formatSchedule('0:07:00')).toEqual({ text: 'Every 7 min', code: false });
    expect(formatSchedule('1:30:00').text).toBe('Every 1 h 30 min');
    expect(formatSchedule('1 day, 0:00:00').text).toBe('Every 1 day');
    expect(formatSchedule('None')).toEqual({ text: 'No schedule: runs only when triggered', code: false });
    expect(formatSchedule('*/10 * * * *')).toEqual({ text: '*/10 * * * *', code: true });
  });

  it('§12.12: cadences and embedded messages', () => {
    expect(formatCadence(10)).toBe('10 s');
    expect(formatCadence(120)).toBe('2 min');
    expect(clause('No DAG "x" is known in environment "acme-emulator".')).toBe(
      'No DAG "x" is known in environment "acme-emulator"',
    );
  });
});
