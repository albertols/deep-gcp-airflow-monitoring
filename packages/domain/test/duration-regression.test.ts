import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DURATION_REGRESSION_RULE,
  compareDurations,
  dagDurationRegression,
  decideRegressions,
  durationDistribution,
  percentile,
  type DagTaskTry,
} from '../src/index';
import { H, T0, tryAt } from './fixtures';

const BASELINE = { from: T0, to: T0 + 24 * H };
const CURRENT = { from: T0 + 24 * H, to: T0 + 48 * H };
const runId = (hour: number) =>
  `scheduled__${new Date(T0 + hour * H).toISOString().replace('.000Z', '+00:00')}`;
/** A deterministic spread around 1: 0.9 … 1.13. */
const spread = (i: number) => 0.9 + ((i * 7) % 24) / 100;

describe('FR-TASK-01 duration distribution', () => {
  it('FR-TASK-01: min, quartiles, p95 and max of a sample; p95 is the max below 20 samples (§8.9)', () => {
    expect(durationDistribution([40, 10, 30, 20])).toEqual({
      samples: 4,
      min: 10,
      p25: 17.5,
      p50: 25,
      p75: 32.5,
      p95: 40,
      max: 40,
      lowSample: true,
    });
    const twenty = durationDistribution(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(twenty).toMatchObject({ samples: 20, p95: 19.05, max: 20, lowSample: false });
    expect(durationDistribution([])).toEqual({
      samples: 0,
      min: null,
      p25: null,
      p50: null,
      p75: null,
      p95: null,
      max: null,
      lowSample: true,
    });
  });
});

describe('HM-016 duration regression verdicts', () => {
  const baseline = Array.from({ length: 24 }, (_, i) => 60 * spread(i));
  const doubled = Array.from({ length: 18 }, (_, i) => 120 * spread(i + 3));

  it('HM-016: flags current p95 ≥ 1.3 × baseline p95 with ≥ 10 samples and a one-sided Mann–Whitney p < 0.01', () => {
    const current = [...doubled, ...baseline.slice(0, 6)];
    const [verdict] = decideRegressions([compareDurations(current, baseline)]);
    expect(verdict?.status).toBe('regression');
    expect(verdict?.ratio).toBeCloseTo(
      (percentile(current, 0.95) as number) / (percentile(baseline, 0.95) as number),
      12,
    );
    expect(verdict?.ratio).toBeGreaterThanOrEqual(DURATION_REGRESSION_RULE.margin);
    expect(verdict?.pValue).toBeLessThan(0.01);
    // A family of one: the adjusted value is the p-value.
    expect(verdict?.qValue).toBeCloseTo(verdict?.pValue as number, 12);
    expect(verdict?.current.samples).toBe(24);
    expect(verdict?.baseline.samples).toBe(24);
  });

  it('HM-016: fewer than 10 current samples is "low sample", fewer than 20 baseline samples "no baseline"', () => {
    const [low, none, both] = decideRegressions([
      compareDurations(doubled.slice(0, 9), baseline),
      compareDurations(doubled, baseline.slice(0, 19)),
      compareDurations(doubled.slice(0, 9), baseline.slice(0, 19)),
    ]);
    expect(low).toMatchObject({ status: 'low-sample', ratio: null, pValue: null, qValue: null });
    expect(none).toMatchObject({ status: 'no-baseline', ratio: null, pValue: null, qValue: null });
    expect(none?.baseline.samples).toBe(19);
    expect(both?.status).toBe('no-baseline');
  });

  it('HM-016: a ratio below the margin, or a p-value of 0.01 or more, stays within the baseline', () => {
    const slightlySlower = baseline.map((v) => v * 1.2);
    const [small] = decideRegressions([compareDurations(slightlySlower, baseline)]);
    expect(small?.status).toBe('within-baseline');
    expect(small?.ratio).toBeCloseTo(1.2, 9);
    // One slow outlier lifts the p95 above 1.3 × but the sample as a whole is not slower.
    const outlier = [...baseline.slice(0, 19), 1_000];
    const [tail] = decideRegressions([compareDurations(outlier, baseline)]);
    expect(tail?.ratio).toBeGreaterThan(1.3);
    expect(tail?.pValue).toBeGreaterThanOrEqual(0.01);
    expect(tail?.status).toBe('within-baseline');
  });

  it('HM-016: Benjamini–Hochberg across the family holds back a lone p = 0.009 among ten tests', () => {
    const tested = (pValue: number, ratio: number) => ({
      ...compareDurations(doubled, baseline),
      pValue,
      ratio,
    });
    const family = [tested(0.009, 1.5), ...Array.from({ length: 9 }, () => tested(0.5, 1))];
    const [held] = decideRegressions(family);
    expect(held?.qValue).toBeCloseTo(0.09, 12);
    expect(held?.status).toBe('within-baseline');
    expect(decideRegressions([tested(0.009, 1.5)])[0]?.status).toBe('regression');
  });

  it('HM-016: the verdict does not depend on the unit: scaling both samples keeps status, ratio and p-value', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 600 }), { minLength: 0, maxLength: 40 }),
        fc.array(fc.integer({ min: 1, max: 600 }), { minLength: 0, maxLength: 40 }),
        fc.integer({ min: 2, max: 1000 }),
        (current, base, k) => {
          const [a] = decideRegressions([compareDurations(current, base)]);
          const [b] = decideRegressions([
            compareDurations(
              current.map((v) => v * k),
              base.map((v) => v * k),
            ),
          ]);
          expect(b?.status).toBe(a?.status);
          if (a?.ratio === null) expect(b?.ratio).toBeNull();
          else expect(b?.ratio).toBeCloseTo(a?.ratio as number, 9);
          if (a?.status === 'regression') {
            expect(a.ratio).toBeGreaterThanOrEqual(DURATION_REGRESSION_RULE.margin);
            expect(a.current.samples).toBeGreaterThanOrEqual(DURATION_REGRESSION_RULE.minCurrentSamples);
            expect(a.baseline.samples).toBeGreaterThanOrEqual(DURATION_REGRESSION_RULE.minBaselineSamples);
            expect(a.pValue).toBeLessThan(DURATION_REGRESSION_RULE.alpha);
          }
        },
      ),
    );
  });
});

describe('HM-016 duration regression of one DAG', () => {
  /** One run per hour: extract, then transform, then load, each starting when the previous ends. */
  function hourlyRuns(hours: readonly number[], seconds: (task: string, i: number) => number): DagTaskTry[] {
    const tries: DagTaskTry[] = [];
    hours.forEach((hour, i) => {
      let at = hour * 60 + 1;
      for (const taskId of ['extract', 'transform', 'load']) {
        const end = at + seconds(taskId, i) / 60;
        tries.push(tryAt({ runId: runId(hour), taskId, start: at, end }));
        at = end;
      }
    });
    return tries;
  }
  const baselineHours = Array.from({ length: 24 }, (_, h) => h);
  const currentHours = Array.from({ length: 24 }, (_, h) => 24 + h);

  it('HM-016: per task, successful tries in the window against the 28 days before it', () => {
    const normal = (task: string, i: number) => (task === 'transform' ? 300 : 60) * spread(i);
    const slowTransform = (task: string, i: number) =>
      task === 'transform' && i >= 6 ? 2 * 300 * spread(i) : normal(task, i);
    const tries = [...hourlyRuns(baselineHours, normal), ...hourlyRuns(currentHours, slowTransform)];
    const result = dagDurationRegression(tries, CURRENT, BASELINE);
    expect(result.tasks.get('transform')?.status).toBe('regression');
    expect(result.tasks.get('extract')).toMatchObject({ status: 'within-baseline' });
    expect(result.tasks.get('extract')?.current.samples).toBe(24);
    expect(result.tasks.get('load')?.status).toBe('within-baseline');
    // The run is three tasks in a row: transform's doubling makes the whole run about 1.7 × slower.
    expect(result.run.status).toBe('regression');
    expect(result.run.current.samples).toBe(24);
  });

  it('HM-016: only successful tries are durations: a failed try and its retry count once, as the retry', () => {
    const tries = [
      ...baselineHours.map((h) =>
        tryAt({ runId: runId(h), taskId: 'extract', start: h * 60 + 1, end: h * 60 + 2 }),
      ),
      ...currentHours.flatMap((h) => [
        tryAt({ runId: runId(h), taskId: 'extract', start: h * 60 + 1, end: h * 60 + 31, state: 'failed' }),
        tryAt({ runId: runId(h), taskId: 'extract', tryNumber: 2, start: h * 60 + 32, end: h * 60 + 33 }),
      ]),
    ];
    const verdict = dagDurationRegression(tries, CURRENT, BASELINE).tasks.get('extract');
    expect(verdict?.current.samples).toBe(24);
    expect(verdict?.current.max).toBe(60);
    expect(verdict?.status).toBe('within-baseline');
  });

  it('HM-016: a run counts in the window its first try started in, and only successful runs count', () => {
    const tries = [
      ...hourlyRuns(baselineHours, () => 60),
      ...hourlyRuns(currentHours.slice(0, 5), () => 60),
      // A run that started in the baseline and ran into the current window is a baseline sample only.
      tryAt({ runId: runId(23.9), taskId: 'extract', start: 23.9 * 60, end: 24.5 * 60 }),
      tryAt({ runId: runId(30), taskId: 'extract', start: 30 * 60, end: 31 * 60, state: 'failed' }),
    ];
    const result = dagDurationRegression(tries, CURRENT, BASELINE);
    expect(result.run.current.samples).toBe(5);
    expect(result.run.baseline.samples).toBe(25);
    expect(result.run.status).toBe('low-sample');
  });

  it('HM-016: without history before the window there is no baseline', () => {
    const tries = hourlyRuns(currentHours, () => 60);
    const result = dagDurationRegression(tries, CURRENT, BASELINE);
    expect(result.run).toMatchObject({ status: 'no-baseline', ratio: null });
    expect(result.run.baseline.samples).toBe(0);
    expect([...result.tasks.values()].every((v) => v.status === 'no-baseline')).toBe(true);
  });

  it('HM-016: a mapped task is one sample per run, its longest map index (the HM-007 collapse rule)', () => {
    // One daily run over 28 baseline days and one run today, each with 30 map indexes; today 1.4 × slower.
    const current = { from: T0, to: T0 + 24 * H };
    const baseline = { from: T0 - 28 * 24 * H, to: T0 };
    const tries: DagTaskTry[] = [];
    const mapped = (run: string, start: number, minutes: number) => {
      for (let i = 0; i < 30; i++)
        tries.push(
          tryAt({ taskId: 'm', mapIndex: i, runId: run, start, end: start + minutes + (i % 5) * 0.1 }),
        );
    };
    for (let d = 1; d <= 28; d++) mapped(`scheduled__d${d}`, -d * 24 * 60 + 60, 10);
    mapped('scheduled__today', 60, 14);
    const verdict = dagDurationRegression(tries, current, baseline).tasks.get('m');
    expect(verdict?.current.samples).toBe(1);
    expect(verdict?.baseline.samples).toBe(28);
    expect(verdict?.status).toBe('low-sample');
    // The sample of a run is its longest map index: 14.4 min.
    expect(verdict?.current.max).toBeCloseTo(14.4 * 60, 6);
  });

  it('HM-016: the latest successful try of each map index counts, so a retried map index is one sample', () => {
    const tries = [
      ...baselineHours.map((h) =>
        tryAt({ runId: runId(h), taskId: 'm', start: h * 60 + 1, end: h * 60 + 2 }),
      ),
      ...currentHours.flatMap((h) => [
        tryAt({ runId: runId(h), taskId: 'm', mapIndex: 0, start: h * 60 + 1, end: h * 60 + 2 }),
        tryAt({
          runId: runId(h),
          taskId: 'm',
          mapIndex: 1,
          start: h * 60 + 1,
          end: h * 60 + 9,
          state: 'failed',
        }),
        tryAt({
          runId: runId(h),
          taskId: 'm',
          mapIndex: 1,
          tryNumber: 2,
          start: h * 60 + 10,
          end: h * 60 + 11,
        }),
      ]),
    ];
    const verdict = dagDurationRegression(tries, CURRENT, BASELINE).tasks.get('m');
    expect(verdict?.current.samples).toBe(24);
    expect(verdict?.current.max).toBe(60);
    expect(verdict?.status).toBe('within-baseline');
  });

  it('HM-016: tasks that did not run in the window get no verdict', () => {
    const tries = [
      ...hourlyRuns(baselineHours, () => 60),
      tryAt({ runId: runId(2), taskId: 'retired_task', start: 2 * 60 + 30, end: 2 * 60 + 31 }),
      ...hourlyRuns(currentHours, () => 60),
    ];
    expect(dagDurationRegression(tries, CURRENT, BASELINE).tasks.has('retired_task')).toBe(false);
  });
});
