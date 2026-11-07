import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  actualRunStarts,
  collidingMinutes,
  collidingSchedules,
  collisionDensity,
  dailyStartsByHourMinute,
  dailyStartsByMinute,
  plannedStarts,
  type DagMeta,
  type TaskTry,
} from '../src/index';

const dag = (dagId: string, schedule: string, paused = false): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme'],
  tags: [],
  team: 'acme',
  schedule,
  maxActiveTasks: 16,
  maxActiveRuns: 16,
  catchup: false,
  paused,
});
const at = (h: number, m: number) => h * 60 + m;

const DAGS = [
  dag('acme_orders_hourly', '0 * * * *'),
  dag('acme_billing_hourly', '0 * * * *'),
  dag('acme_finance_nightly', '30 2 * * *'),
  dag('acme_reports_daily', '@daily'),
  dag('acme_paused_hourly', '0 * * * *', true),
  dag('acme_manual', 'None'),
  dag('acme_quarter_hourly', '*/15 * * * 1-5'),
];

describe('HM-009 / FR-BOTL-03 planned start heatmap (hour of day × minute of hour, UTC)', () => {
  it('FR-BOTL-03: expands each cron schedule into starts per day per cell', () => {
    const cells = dailyStartsByHourMinute('30 2 * * *');
    expect(cells).toHaveLength(1_440);
    expect(cells?.[at(2, 30)]).toBe(1);
    expect(cells?.reduce((s, n) => s + n, 0)).toBe(1);
    const weekdays = dailyStartsByHourMinute('*/15 * * * 1-5');
    expect(weekdays?.[at(13, 45)]).toBeCloseTo(5 / 7);
    expect(dailyStartsByHourMinute('None')).toBeNull();
  });

  it('FR-BOTL-03: sums unpaused DAGs and lists the DAGs without a fixed start minute', () => {
    const p = plannedStarts(DAGS);
    expect(p.cells[at(0, 0)]).toBeCloseTo(2 + 1 + 5 / 7);
    expect(p.cells[at(5, 0)]).toBeCloseTo(2 + 5 / 7);
    expect(p.cells[at(2, 30)]).toBeCloseTo(1 + 5 / 7);
    expect(p.totalDailyStarts).toBeCloseTo(48 + 1 + 1 + (96 * 5) / 7);
    expect(p.scheduledDags).toBe(5);
    expect(p.unscheduled).toEqual(['acme_manual']);
  });

  it('HM-009: the heatmap adds up to the collision density, minute by minute', () => {
    const schedules = fc.constantFrom(
      '0 * * * *',
      '*/5 * * * *',
      '15 3 * * *',
      '0 0 * * 0',
      '0 0 1 * *',
      '10,40 9-17 * * 1-5',
      '@hourly',
      'None',
    );
    fc.assert(
      fc.property(fc.array(fc.tuple(schedules, fc.boolean()), { maxLength: 12 }), (specs) => {
        const dags = specs.map(([s, paused], i) => dag(`acme_${i}`, s, paused));
        const p = plannedStarts(dags);
        const d = collisionDensity(dags);
        expect(p.totalDailyStarts).toBeCloseTo(d.totalDailyStarts, 9);
        for (let m = 0; m < 60; m++) {
          const column = Array.from({ length: 24 }, (_, h) => p.cells[at(h, m)] ?? 0).reduce((a, b) => a + b);
          expect(column).toBeCloseTo(d.perMinute[m] ?? 0, 9);
        }
        for (const [s] of specs) {
          const cells = dailyStartsByHourMinute(s);
          const minutes = dailyStartsByMinute(s);
          expect(cells === null).toBe(minutes === null);
          if (cells && minutes)
            expect(cells.reduce((a, b) => a + b, 0)).toBeCloseTo(
              minutes.reduce((a, b) => a + b, 0),
              9,
            );
        }
      }),
    );
  });

  it('FR-BOTL-03: the most colliding minutes, with their share, DAGs and schedules', () => {
    const [top, next] = collidingMinutes(DAGS, 2);
    expect(top?.minute).toBe(0);
    expect(top?.startsPerDay).toBeCloseTo(48 + 1 + (24 * 5) / 7);
    expect(top?.share).toBeCloseTo((48 + 1 + (24 * 5) / 7) / (50 + (96 * 5) / 7));
    expect(top?.dags).toBe(4);
    expect(top?.schedules.map((s) => [s.schedule, s.dags])).toEqual([
      ['0 * * * *', 2],
      ['*/15 * * * 1-5', 1],
      ['@daily', 1],
    ]);
    expect(top?.topDags).toEqual([
      'acme_billing_hourly',
      'acme_orders_hourly',
      'acme_quarter_hourly',
      'acme_reports_daily',
    ]);
    expect(next?.minute).toBe(30);
  });

  it('FR-BOTL-03: the most colliding schedules are the schedules most unpaused DAGs share', () => {
    const same = [...DAGS, dag('acme_hourly_preset', '@hourly')];
    const [first, ...rest] = collidingSchedules(same);
    expect(first).toEqual({
      schedule: '0 * * * *',
      dags: 3,
      startsPerDay: 72,
      minutes: [0],
      exampleDags: ['acme_billing_hourly', 'acme_hourly_preset', 'acme_orders_hourly'],
    });
    expect(rest).toEqual([]);
  });
});

describe('FR-BOTL-03 actual run starts', () => {
  const T0 = Date.UTC(2026, 10, 5, 0, 0, 0);
  const SEC = 1_000;
  const tri = (runId: string, startSec: number | null, taskId = 't'): TaskTry => ({
    dagId: 'acme_orders_hourly',
    runId,
    taskId,
    mapIndex: -1,
    tryNumber: 1,
    pool: 'default_pool',
    poolSlots: 1,
    startAt: startSec === null ? null : T0 + startSec * SEC,
    endAt: null,
  });

  it('FR-BOTL-03: a run starts with its first try start; runs that started before the range are left out', () => {
    const a = actualRunStarts(
      [
        tri('r1', 300, 'second'),
        tri('r1', 20, 'first'),
        tri('r2', 5_459),
        tri('r3', -60),
        tri('r3', 30, 'late'),
        tri('r4', null),
      ],
      { from: T0, to: T0 + 86_400 * SEC },
    );
    expect(a.runs).toBe(2);
    expect(a.days).toBe(1);
    expect(a.cells[at(0, 0)]).toBe(1);
    expect(a.cells[at(1, 30)]).toBe(1);
    expect(a.cells.reduce((s, n) => s + n, 0)).toBe(2);
  });
});
