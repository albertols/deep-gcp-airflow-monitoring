import { describe, expect, it } from 'vitest';
import { dagRuns, dataIntervalEnd } from '../src/index';
import { M, T0, tryAt, windowOf } from './fixtures';

const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 10, 5, h, m, s);
const runId = (ms: number) => `scheduled__${new Date(ms).toISOString().replace('.000Z', '+00:00')}`;

describe('HM-002 data interval end (Airflow 2 timetables)', () => {
  it('HM-002: a cron schedule’s data interval ends at the next cron time after the logical date', () => {
    expect(dataIntervalEnd('*/10 * * * *', at(0, 20))).toBe(at(0, 30));
    expect(dataIntervalEnd('@hourly', at(5))).toBe(at(6));
    expect(dataIntervalEnd('0 6 * * *', at(6))).toBe(Date.UTC(2026, 10, 6, 6, 0, 0));
    // 2026-11-05 is a Thursday; the next weekday run is Friday.
    expect(dataIntervalEnd('30 2 * * 1-5', at(2, 30))).toBe(Date.UTC(2026, 10, 6, 2, 30, 0));
  });

  it('HM-002: a timedelta schedule (as the Airflow API prints it) ends one delta later', () => {
    expect(dataIntervalEnd('0:07:00', at(0))).toBe(at(0, 7));
    expect(dataIntervalEnd('1 day, 0:00:00', at(0))).toBe(Date.UTC(2026, 10, 6, 0, 0, 0));
  });

  it('HM-002: unknown when DCAM cannot derive the interval', () => {
    // A logical date the cron does not produce in UTC: the DAG runs in another time zone.
    expect(dataIntervalEnd('0 6 * * *', at(5))).toBeNull();
    expect(dataIntervalEnd('None', at(0))).toBeNull();
    expect(dataIntervalEnd('@once', at(0))).toBeNull();
    expect(dataIntervalEnd('relativedelta(months=+1)', at(0))).toBeNull();
    expect(dataIntervalEnd('Dataset', at(0))).toBeNull();
  });
});

describe('HM-002 start delay of DAG runs', () => {
  const W = windowOf(0, 120);
  // T0 is 00:00 UTC on 2026-11-05; fixture times are minutes after T0.
  const first = (dagRunId: string, start: number) =>
    tryAt({ runId: dagRunId, taskId: 'a', start, end: start + 1 });

  it('HM-002: a */10 run with logical date 00:20 that starts at 00:30:02 is 2 s late, not 10 min 2 s', () => {
    const [run] = dagRuns([first(runId(at(0, 20)), 30 + 2 / 60)], W, {}, '*/10 * * * *');
    expect(run).toMatchObject({ startDelaySeconds: 2, startDelayBasis: 'data_interval_end' });
  });

  it('HM-002: a run that starts before its interval ends has a trigger timetable: measured from the logical date', () => {
    const [run] = dagRuns([first(runId(at(0, 30)), 30 + 3 / 60)], W, {}, '*/10 * * * *');
    expect(run).toMatchObject({ startDelaySeconds: 3, startDelayBasis: 'trigger_time' });
  });

  it('HM-002: without a known data interval the delay is from the logical date, and labelled so', () => {
    const [run] = dagRuns([first(runId(at(1)), 61.5)], W, {}, 'Custom timetable');
    expect(run).toMatchObject({ startDelaySeconds: 90, startDelayBasis: 'logical_date' });
  });

  it('HM-002: manual and custom runs have no start delay (only scheduled runs count)', () => {
    const runs = dagRuns(
      [first('manual__2026-11-05T00:40:00+00:00', 41), first('nightly-rebuild', 50)],
      W,
      {},
      '*/10 * * * *',
    );
    for (const r of runs)
      expect(r).toMatchObject({ startDelaySeconds: null, startDelayBasis: 'not_scheduled' });
    expect(runs[0]?.startAt).toBe(T0 + 41 * M);
  });
});
