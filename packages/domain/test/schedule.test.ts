import { describe, expect, it } from 'vitest';
import { collisionDensity, dailyStartsByMinute, withStartMinute, type DagMeta } from '../src/index';

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

describe('HM-009 daily starts by minute-of-hour', () => {
  it('HM-009: an hourly cron starts 24 times a day in its minute', () => {
    const starts = dailyStartsByMinute('5 * * * *');
    expect(starts?.[5]).toBe(24);
    expect(sum(starts ?? [])).toBe(24);
  });

  it('HM-009: expands lists, ranges and steps in the minute and hour fields', () => {
    expect(dailyStartsByMinute('*/15 * * * *')?.filter((n) => n > 0)).toEqual([24, 24, 24, 24]);
    const listed = dailyStartsByMinute('0,30 9-17 * * *');
    expect(listed?.[0]).toBe(9);
    expect(listed?.[30]).toBe(9);
    expect(sum(dailyStartsByMinute('10-14/2 0 * * *') ?? [])).toBe(3);
  });

  it('HM-009: presets map to their cron equivalents', () => {
    expect(dailyStartsByMinute('@hourly')?.[0]).toBe(24);
    expect(dailyStartsByMinute('@daily')?.[0]).toBe(1);
    expect(dailyStartsByMinute('@weekly')?.[0]).toBeCloseTo(1 / 7);
    // Airflow's presets include @quarterly: the first of every third month.
    const monthly = dailyStartsByMinute('@monthly')?.[0] ?? 0;
    expect(dailyStartsByMinute('@quarterly')?.[0]).toBeCloseTo(monthly / 3);
  });

  it('HM-009: day-of-week and month restrictions give an average per day', () => {
    expect(dailyStartsByMinute('0 6 * * 1-5')?.[0]).toBeCloseTo(5 / 7);
    expect(dailyStartsByMinute('0 6 * * MON,WED')?.[0]).toBeCloseTo(2 / 7);
    expect(dailyStartsByMinute('0 6 * JAN *')?.[0]).toBeCloseTo(1 / 12);
  });

  it('HM-009: schedules without a fixed start minute are not counted', () => {
    for (const s of ['@once', 'None', '', 'not a cron', '61 * * * *', '@continuous'])
      expect(dailyStartsByMinute(s)).toBeNull();
  });
});

const dag = (dagId: string, schedule: string, paused = false): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme'],
  tags: [],
  team: 'acme',
  schedule,
  maxActiveTasks: 16,
  maxActiveRuns: 25,
  catchup: false,
  paused,
});

describe('HM-009 collision density', () => {
  it('HM-009: the collision index is the share of daily starts in the busiest minute-of-hour', () => {
    const d = collisionDensity([
      dag('a_hourly', '0 * * * *'),
      dag('b_hourly', '0 * * * *'),
      dag('c_hourly', '30 * * * *'),
      dag('d_daily', '0 3 * * *'),
      dag('paused_hourly', '0 * * * *', true),
      dag('manual', 'None'),
    ]);
    expect(d.busiestMinute).toBe(0);
    expect(d.totalDailyStarts).toBe(73);
    expect(d.collisionIndex).toBeCloseTo(49 / 73);
    expect(d.dagsInBusiestMinute.map((x) => x.dagId)).toEqual(['a_hourly', 'b_hourly', 'd_daily']);
    expect(d.unscheduled).toEqual(['manual']);
  });

  it('HM-009: without scheduled DAGs there is no busiest minute', () => {
    const d = collisionDensity([dag('manual', 'None')]);
    expect(d.busiestMinute).toBeNull();
    expect(d.collisionIndex).toBe(0);
  });
});

describe('HM-009 stagger helper (FR-BOTL-04)', () => {
  it('REC-SCHED-01: moves a single fixed start minute and keeps the other fields', () => {
    expect(withStartMinute('0 * * * *', 7)).toBe('7 * * * *');
    expect(withStartMinute('0 3 * * 1-5', 12)).toBe('12 3 * * 1-5');
    expect(withStartMinute('@hourly', 7)).toBe('7 * * * *');
    expect(withStartMinute('@daily', 5)).toBe('5 0 * * *');
  });

  it('REC-SCHED-01: leaves schedules with several or no fixed minutes alone', () => {
    for (const s of ['*/15 * * * *', '0,30 * * * *', '0-5 * * * *', '@once', 'None'])
      expect(withStartMinute(s, 7)).toBeNull();
  });
});
