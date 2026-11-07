/**
 * Duration regression (HM-016, spec §8.4 L1262) and the duration distribution per task (FR-TASK-01): is a
 * DAG or task now slower than its own baseline? Pure; times are epoch ms, durations are seconds.
 *
 * - Samples: successful tries per task (end − start), and successful runs per DAG (last end − first start).
 *   A try counts in the window it started in; a run in the window its first try started in, so no run is in
 *   both samples.
 * - Current window: the selected range (FR-TASK-01). Baseline: the 28 days before it (HM-016), as far as DCAM
 *   has history; the caller states the coverage.
 * - Flag: current p95 ≥ 1.3 × baseline p95, ≥ 10 current samples, one-sided Mann–Whitney p < 0.01, and a
 *   Benjamini–Hochberg q ≤ 0.05 across the family tested together (the tasks of one DAG).
 * - Not done here: PELT change-point dating and maintenance-window exclusion (no source yet).
 *
 * @implements HM-016, FR-TASK-01, FR-DAGD-04 (baseline delta)
 */
import { summariseRun, triesByRun, type DagTaskTry, type RunOptions } from './dag-runs';
import { benjaminiHochberg, mannWhitneyGreater } from './significance';
import { MIN_SAMPLES_FOR_TAIL, percentileOfSorted, sortedFinite } from './stats';

export const DURATION_REGRESSION_RULE = {
  /** Baseline length before the current window (HM-016). */
  baselineDays: 28,
  /** Current p95 ÷ baseline p95 at or above this is a candidate regression (HM-016, REC-DAG-08). */
  margin: 1.3,
  minCurrentSamples: 10,
  /** A baseline p95 needs as many samples as any p95 (spec §8.9). */
  minBaselineSamples: MIN_SAMPLES_FOR_TAIL,
  /** One-sided Mann–Whitney U significance level. */
  alpha: 0.01,
  /** Benjamini–Hochberg false discovery rate. */
  fdr: 0.05,
} as const;

export type DurationRegressionRule = { readonly [K in keyof typeof DURATION_REGRESSION_RULE]: number };

/** A sample of durations in seconds. Below 20 samples `p95` is the maximum and `lowSample` is set (§8.9). */
export interface DurationDistribution {
  readonly samples: number;
  readonly min: number | null;
  readonly p25: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p95: number | null;
  readonly max: number | null;
  readonly lowSample: boolean;
}

export function durationDistribution(values: readonly number[]): DurationDistribution {
  return distributionOfSorted(sortedFinite(values));
}

function distributionOfSorted(sorted: readonly number[]): DurationDistribution {
  const samples = sorted.length;
  const at = (p: number) => percentileOfSorted(sorted, p);
  const max = sorted.at(-1) ?? null;
  const lowSample = samples < MIN_SAMPLES_FOR_TAIL;
  return {
    samples,
    min: sorted[0] ?? null,
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p95: lowSample ? max : at(0.95),
    max,
    lowSample,
  };
}

/**
 * - `regression`: flagged;
 * - `within-baseline`: tested and not flagged;
 * - `low-sample`: fewer than 10 current samples;
 * - `no-baseline`: fewer than 20 baseline samples, or no history before the window.
 */
export type RegressionStatus = 'regression' | 'within-baseline' | 'low-sample' | 'no-baseline';

/** One comparison before the family's false discovery rate is controlled. */
export interface DurationComparison {
  readonly status: 'tested' | 'low-sample' | 'no-baseline';
  readonly current: DurationDistribution;
  readonly baseline: DurationDistribution;
  /**
   * Current p95 ÷ baseline p95, both interpolated (type 7) even with 10 to 19 current samples, where the
   * displayed current p95 is the maximum (§8.9); `null` when not tested or the baseline p95 is 0.
   */
  readonly ratio: number | null;
  /** One-sided Mann–Whitney U p-value that the current durations are longer; `null` when not tested. */
  readonly pValue: number | null;
}

export interface RegressionVerdict extends Omit<DurationComparison, 'status'> {
  readonly status: RegressionStatus;
  /** Benjamini–Hochberg adjusted p-value across the family; `null` when not tested. */
  readonly qValue: number | null;
}

export function compareDurations(
  current: readonly number[],
  baseline: readonly number[],
  rule: DurationRegressionRule = DURATION_REGRESSION_RULE,
): DurationComparison {
  const currentSorted = sortedFinite(current);
  const baselineSorted = sortedFinite(baseline);
  const now = distributionOfSorted(currentSorted);
  const before = distributionOfSorted(baselineSorted);
  const untested = (status: 'low-sample' | 'no-baseline'): DurationComparison => ({
    status,
    current: now,
    baseline: before,
    ratio: null,
    pValue: null,
  });
  if (before.samples < rule.minBaselineSamples) return untested('no-baseline');
  if (now.samples < rule.minCurrentSamples) return untested('low-sample');
  const currentP95 = percentileOfSorted(currentSorted, 0.95) as number;
  const baselineP95 = percentileOfSorted(baselineSorted, 0.95) as number;
  return {
    status: 'tested',
    current: now,
    baseline: before,
    ratio: baselineP95 > 0 ? currentP95 / baselineP95 : null,
    pValue: mannWhitneyGreater(currentSorted, baselineSorted)?.pValue ?? null,
  };
}

/** Verdicts for a family of comparisons tested together, with Benjamini–Hochberg control. */
export function decideRegressions(
  comparisons: readonly DurationComparison[],
  rule: DurationRegressionRule = DURATION_REGRESSION_RULE,
): RegressionVerdict[] {
  const q = benjaminiHochberg(comparisons.map((c) => (c.status === 'tested' ? c.pValue : null)));
  return comparisons.map((c, i): RegressionVerdict => {
    const qValue = q[i] ?? null;
    if (c.status !== 'tested') return { ...c, status: c.status, qValue: null };
    const flagged =
      c.ratio !== null &&
      c.ratio >= rule.margin &&
      c.pValue !== null &&
      c.pValue < rule.alpha &&
      qValue !== null &&
      qValue <= rule.fdr;
    return { ...c, status: flagged ? 'regression' : 'within-baseline', qValue };
  });
}

interface Span {
  readonly from: number;
  readonly to: number;
}

const inSpan = (at: number, w: Span) => at >= w.from && at < w.to;

const push = (m: Map<string, number[]>, k: string, v: number) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

/**
 * Successful try durations per task for tries starting in each window. Every task with a try starting in
 * the current window has an entry, empty when none of its tries there succeeded.
 */
function taskDurations(tries: readonly DagTaskTry[], current: Span, baseline: Span) {
  const now = new Map<string, number[]>();
  const before = new Map<string, number[]>();
  for (const t of tries) {
    if (t.startAt === null) continue;
    const isCurrent = inSpan(t.startAt, current);
    if (isCurrent && !now.has(t.taskId)) now.set(t.taskId, []);
    if (t.state !== 'success' || t.endAt === null || t.endAt < t.startAt) continue;
    const seconds = (t.endAt - t.startAt) / 1000;
    if (isCurrent) push(now, t.taskId, seconds);
    else if (inSpan(t.startAt, baseline)) push(before, t.taskId, seconds);
  }
  return { now, before };
}

/** Successful run durations for runs whose first try started in each window: one grouping by run. */
function runDurations(tries: readonly DagTaskTry[], current: Span, baseline: Span, options: RunOptions) {
  const now: number[] = [];
  const before: number[] = [];
  for (const runTries of triesByRun(tries)) {
    let first = Infinity;
    for (const t of runTries) if (t.startAt !== null && t.startAt < first) first = t.startAt;
    const target = inSpan(first, current) ? now : inSpan(first, baseline) ? before : null;
    if (!target) continue;
    const run = summariseRun(runTries, options);
    if (run?.state === 'success' && run.durationSeconds !== null) target.push(run.durationSeconds);
  }
  return { now, before };
}

export interface DagDurationRegression {
  /** Successful run durations of the DAG: a family of one. */
  readonly run: RegressionVerdict;
  /** Per task that ran in the current window; the tasks form one family. */
  readonly tasks: ReadonlyMap<string, RegressionVerdict>;
}

/**
 * HM-016 for one DAG: `tries` are its tries from the start of `baseline` to now (all map indexes and tries;
 * other DAGs' tries must be filtered out by the caller).
 */
export function dagDurationRegression(
  tries: readonly DagTaskTry[],
  current: Span,
  baseline: Span,
  options: RunOptions = {},
  rule: DurationRegressionRule = DURATION_REGRESSION_RULE,
): DagDurationRegression {
  const runs = runDurations(tries, current, baseline, options);
  const [run] = decideRegressions([compareDurations(runs.now, runs.before, rule)], rule);
  // Tasks that ran in the window but never succeeded in it are compared too: zero current samples.
  const { now, before } = taskDurations(tries, current, baseline);
  const ids = [...now.keys()].sort();
  const verdicts = decideRegressions(
    ids.map((id) => compareDurations(now.get(id) ?? [], before.get(id) ?? [], rule)),
    rule,
  );
  return {
    run: run as RegressionVerdict,
    tasks: new Map(ids.map((id, i) => [id, verdicts[i] as RegressionVerdict])),
  };
}
