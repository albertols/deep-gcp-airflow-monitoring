/**
 * Use case: local alerts (S-24). Evaluates the default pack (spec §16.4) once per minute over the last
 * 24 hours from the signals DCAM collects: worker samples, live snapshots, task tries and
 * platform-health readings. Rules whose source this version does not collect are listed as `unknown`
 * with the reason; they are never guessed (spec §16.2: DCAM never alerts on data it does not have).
 *
 * Alerts are local and read-only: nothing here creates Cloud Monitoring policies or notification
 * channels (spec §18.2).
 *
 * @implements FR-ALRT-01, FR-ALRT-02, FR-ALRT-06
 */
import type { AlertEvent, AlertRule, Alerts, SourceId } from '@dcam/contracts';
import {
  evaluateAlert,
  percentile,
  quantile,
  type AlertCondition,
  type AlertEvaluation,
  type Comparator,
  type ConditionPoint,
  type EnvironmentConfig,
  type LiveSnapshot,
  type PlatformHealth,
  type Tier,
  type WorkerSample,
} from '@dcam/domain';
import type { Clock, EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { ALERT_PACK, severityFor, type AlertRuleId, type PackRule } from './alert-pack';

export interface AlertDeps {
  readonly store: TaskInstanceStore;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
}

export interface AlertQuery {
  readonly envIds: readonly string[];
  readonly sources: readonly SourceId[];
}

const SECOND = 1_000;
const MIN = 60 * SECOND;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** History shown on the alerts page. */
export const ALERT_WINDOW_MS = DAY;
/** Evaluations before the window warm the state up; longer than any `for` in the pack. */
const WARM_UP_MS = HOUR;
/** One evaluation per minute (spec §16.2 allows at most one per 10 s). */
export const EVALUATION_STEP_MS = MIN;
/** `af.live` and worker-sample cadences of the standard profile (spec §7.7). */
const SNAPSHOT_CADENCE_MS = 30 * SECOND;
const SAMPLE_CADENCE_MS = MIN;
/** Staleness guard (spec §16.2): a source older than 3 × its cadence makes the rule unknown. */
const STALE_AFTER_CADENCES = 3;
/** ⚠️ The spec gives `clearFor` only for AL-05 (PT10M, §16.1); DCAM uses it for every per-minute rule. */
const CLEAR_FOR_MS = 10 * MIN;
/** ⚠️ AL-09's "same-hour baseline" is open in the spec: DCAM uses the median of the previous 7 days. */
const BASELINE_DAYS = 7;
/** Minimum coverage before a rule may fire (spec §8.9 item 6: 80 % by default), so 6 of 7 days. */
const MIN_BASELINE_DAYS = Math.ceil(0.8 * BASELINE_DAYS);

const iso = (ms: number) => new Date(ms).toISOString();
const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;
const pct = (ratio: number) => round(ratio * 100);

/** Everything the rules of one environment are evaluated from. */
interface Signals {
  readonly config: EnvironmentConfig;
  readonly now: number;
  /** Evaluation times, oldest first, one per minute from the warm-up start to now. */
  readonly grid: readonly number[];
  readonly snapshots: readonly LiveSnapshot[];
  readonly samples: readonly WorkerSample[];
  readonly tries: readonly StoredTaskTry[];
  readonly health: PlatformHealth;
}

/** A rule evaluated over a per-minute series. */
interface SeriesRule {
  readonly kind: 'series';
  readonly condition: string;
  readonly unit: string;
  readonly rule: AlertCondition;
  readonly points: (s: Signals) => ConditionPoint[];
  /** Evidence behind the latest evaluation, in plain words. */
  readonly summary: (s: Signals, e: AlertEvaluation) => string;
}

/**
 * A rule evaluated on one platform-health reading. Each reading already aggregates the rule's window
 * (4 h, 12 h, 24 h or 15 min, the HM-028 check inputs), so it fires on the first breaching reading.
 */
interface ReadingRule {
  readonly kind: 'reading';
  readonly condition: string;
  readonly unit: string;
  readonly comparator: Comparator;
  readonly threshold: number;
  /** What is read, for the "not collected" summary. */
  readonly reading: string;
  readonly read: (h: PlatformHealth) => number | null;
  readonly summary: (value: number) => string;
}

/** A rule whose source this version does not collect. */
interface NotCollectedRule {
  readonly kind: 'not-collected';
  readonly condition: string;
  readonly unit: string;
  readonly threshold: number | null;
  readonly forSeconds: number;
  readonly missing: string;
}

type RuleDefinition = SeriesRule | ReadingRule | NotCollectedRule;

const STALE: Pick<ConditionPoint, 'value' | 'stale'> = { value: null, stale: true };

/** For each grid time, the latest item at or before it; items oldest first. */
function latestAt<T extends { readonly at: number }>(
  items: readonly T[],
  grid: readonly number[],
): Array<T | undefined> {
  let i = -1;
  return grid.map((t) => {
    while (i + 1 < items.length && (items[i + 1] as T).at <= t) i++;
    return i >= 0 ? items[i] : undefined;
  });
}

const isFresh = <T extends { readonly at: number }>(item: T | undefined, t: number, cadenceMs: number) =>
  item !== undefined && t - item.at <= STALE_AFTER_CADENCES * cadenceMs ? item : undefined;

/** Per-minute points from the latest worker sample, unknown when samples are stale. */
const samplePoints =
  (point: (x: WorkerSample, s: Signals) => Omit<ConditionPoint, 'at'>) =>
  (s: Signals): ConditionPoint[] => {
    const latest = latestAt(s.samples, s.grid);
    return s.grid.map((t, i) => {
      const x = isFresh(latest[i], t, SAMPLE_CADENCE_MS);
      return x ? { at: t, ...point(x, s) } : { at: t, ...STALE };
    });
  };

const lastSample = (s: Signals) => isFresh(s.samples.at(-1), s.now, SAMPLE_CADENCE_MS);
const NO_SAMPLE = 'No worker sample in the last 3 min, so DCAM cannot evaluate this rule.';
const NO_SNAPSHOT = 'No live snapshot in the last 90 s, so DCAM cannot evaluate this rule.';

/** Per snapshot: the pool starved longest (no open slots while tasks wait for it) and for how long. */
function starvation(snapshots: readonly LiveSnapshot[]) {
  const since = new Map<string, number>();
  let previous: number | null = null;
  return snapshots.map((s) => {
    // A gap in collection breaks continuity: DCAM cannot claim the pool stayed starved.
    if (previous !== null && s.at - previous > STALE_AFTER_CADENCES * SNAPSHOT_CADENCE_MS) since.clear();
    previous = s.at;
    let pool: string | null = null;
    let minutes = 0;
    for (const p of s.pools) {
      const starved = p.open === 0 && s.scheduled.some((ti) => ti.pool === p.name);
      if (!starved) {
        since.delete(p.name);
        continue;
      }
      const start = since.get(p.name) ?? s.at;
      since.set(p.name, start);
      const m = (s.at - start) / MIN;
      if (pool === null || m > minutes) [pool, minutes] = [p.name, m];
    }
    return { at: s.at, pool, minutes: round(minutes) };
  });
}

/** Queue waits (HM-001: start − queued) of tries started in (t − window, t], per grid time. */
function queueWaits(tries: readonly StoredTaskTry[], grid: readonly number[], windowMs: number) {
  const starts = tries
    .filter((t) => t.startAt !== null && t.queuedAt !== null && t.startAt >= t.queuedAt)
    .map((t) => ({
      at: t.startAt as number,
      wait: ((t.startAt as number) - (t.queuedAt as number)) / SECOND,
    }))
    .sort((a, b) => a.at - b.at);
  let lo = 0;
  let hi = 0;
  return grid.map((t) => {
    while (hi < starts.length && (starts[hi] as { at: number }).at <= t) hi++;
    while (lo < hi && (starts[lo] as { at: number }).at <= t - windowMs) lo++;
    return quantile(
      starts.slice(lo, hi).map((x) => x.wait),
      0.95,
    );
  });
}

/** Failed task instances in the last hour against the same hour on previous days (AL-09). */
function failureSpike(tries: readonly StoredTaskTry[]) {
  const ends = tries
    .filter((t) => t.state === 'failed' && t.endAt !== null)
    .map((t) => t.endAt as number)
    .sort((a, b) => a - b);
  // ⚠️ The earliest try stands for the start of collection until M1 records collector coverage.
  const coverageStart = tries.reduce((m, t) => Math.min(m, t.startAt ?? t.endAt ?? Infinity), Infinity);
  const upTo = (x: number) => {
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((ends[mid] as number) <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const failed = (from: number, to: number) => upTo(to) - upTo(from);
  return (t: number) => {
    const days: number[] = [];
    for (let d = 1; d <= BASELINE_DAYS; d++) {
      const end = t - d * DAY;
      if (end - HOUR >= coverageStart) days.push(failed(end - HOUR, end));
    }
    const current = failed(t - HOUR, t);
    const baseline = days.length >= MIN_BASELINE_DAYS ? (percentile(days, 0.5) as number) : null;
    return { current, baseline, days: days.length };
  };
}

/** "45 s", "12 min", "1 h 5 min". */
function durationText(ms: number): string {
  if (ms < MIN) return `${Math.round(ms / SECOND)} s`;
  const minutes = Math.round(ms / MIN);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

const DEFINITIONS: Readonly<Record<AlertRuleId, RuleDefinition>> = {
  'AL-01': {
    kind: 'reading',
    condition: 'Environment healthy < 90 % of the time over 4 h',
    unit: '%',
    comparator: '<',
    threshold: 90,
    reading: 'Environment health (environment/healthy)',
    read: (h) => (h.envHealthyRatio === null ? null : pct(h.envHealthyRatio)),
    summary: (v) =>
      `Healthy ${v} % of the last 4 h. The 10-minute unhealthy check needs per-minute health, which is not collected in this version.`,
  },
  'AL-02': {
    kind: 'reading',
    condition: 'Scheduler heartbeat completeness < 90 % over 4 h (HM-031)',
    unit: '%',
    comparator: '<',
    threshold: 90,
    reading: 'Scheduler heartbeat completeness',
    read: (h) => (h.heartbeatCompleteness === null ? null : pct(h.heartbeatCompleteness)),
    summary: (v) =>
      `Heartbeat completeness ${v} % over the last 4 h. The 5-minute missing-heartbeat check needs the heartbeat series, which is not collected in this version.`,
  },
  'AL-03': {
    kind: 'not-collected',
    condition: 'Parse loop ≥ 80 % of the stale-DAG threshold for 30 min',
    unit: '%',
    threshold: 80,
    forSeconds: 1_800,
    missing: 'The stale-DAG threshold the parse loop is compared with is not collected in this version.',
  },
  'AL-04': {
    kind: 'reading',
    condition: 'Import errors > 0 for 15 min',
    unit: 'import errors',
    comparator: '>',
    threshold: 0,
    reading: 'DAG import errors',
    read: (h) => h.importErrors,
    summary: (v) => `${v} DAG import ${v === 1 ? 'error' : 'errors'} over the last 15 min.`,
  },
  'AL-05': {
    kind: 'series',
    condition: 'Workers at maximum and ≥ 10 tasks queued for 15 min',
    unit: 'queued tasks',
    rule: {
      comparator: '>=',
      threshold: 10,
      forMs: 15 * MIN,
      clearForMs: CLEAR_FOR_MS,
      noData: 'keep_state',
    },
    points: samplePoints((x, s) => ({ value: x.queued, gate: x.workers >= s.config.maxWorkers })),
    summary: (s) => {
      const x = lastSample(s);
      return x
        ? `${x.queued} tasks queued with ${x.workers} of ${s.config.maxWorkers} workers (maximum ${s.config.maxWorkers}).`
        : NO_SAMPLE;
    },
  },
  'AL-06': {
    kind: 'series',
    condition: 'p95 queue wait ≥ 10 min over the last 15 min (HM-001)',
    unit: 's',
    rule: { comparator: '>=', threshold: 600, forMs: 0, clearForMs: CLEAR_FOR_MS, noData: 'keep_state' },
    points: (s) =>
      queueWaits(s.tries, s.grid, 15 * MIN).map((q, i) => ({
        at: s.grid[i] as number,
        value: q.value === null ? null : round(q.value),
      })),
    summary: (s) => {
      const q = queueWaits(s.tries, [s.now], 15 * MIN)[0];
      if (!q || q.value === null) return 'No task started in the last 15 min.';
      const low = q.lowSample ? '; fewer than 20 starts, so this is the max' : '';
      return `p95 queue wait ${durationText(q.value * SECOND)} from ${q.samples} task starts in the last 15 min${low}.`;
    },
  },
  'AL-07': {
    kind: 'series',
    condition: 'Worker memory ≥ 90 % of the limit for 10 min',
    unit: '%',
    rule: {
      comparator: '>=',
      threshold: 90,
      forMs: 10 * MIN,
      clearForMs: CLEAR_FOR_MS,
      noData: 'keep_state',
    },
    points: samplePoints((x) => ({ value: pct(x.memory) })),
    summary: (s) => {
      const x = lastSample(s);
      return x
        ? `Highest worker memory ${pct(x.memory)} % of the limit in the latest minute. OOM kills are not collected in this version.`
        : NO_SAMPLE;
    },
  },
  'AL-08': {
    kind: 'not-collected',
    condition: '≥ 5 zombie or heartbeat-timeout tasks in 1 h',
    unit: 'tasks per hour',
    threshold: 5,
    forSeconds: 0,
    missing:
      'Hourly zombie task counts are not collected in this version; only a 24-hour total feeds the fleet health score.',
  },
  'AL-09': {
    kind: 'series',
    condition: `Failed task instances over 1 h ≥ 3 × the same-hour baseline (median of the previous ${BASELINE_DAYS} days)`,
    unit: '× baseline',
    rule: { comparator: '>=', threshold: 3, forMs: 0, clearForMs: CLEAR_FOR_MS, noData: 'keep_state' },
    points: (s) => {
      const spike = failureSpike(s.tries);
      return s.grid.map((t) => {
        const { current, baseline } = spike(t);
        // ⚠️ A baseline below one failure counts as one, so a quiet hour needs ≥ 3 failures to fire.
        return baseline === null
          ? { at: t, ...STALE }
          : { at: t, value: round(current / Math.max(baseline, 1), 2) };
      });
    },
    summary: (s) => {
      const { current, baseline, days } = failureSpike(s.tries)(s.now);
      if (baseline === null)
        return `The same-hour baseline needs task history from at least ${MIN_BASELINE_DAYS} of the previous ${BASELINE_DAYS} days; DCAM has ${days}.`;
      return `${current} failed task instances in the last hour; the same-hour median of the previous ${days} days is ${round(baseline)}.`;
    },
  },
  'AL-10': {
    kind: 'reading',
    condition: 'Database CPU or memory ≥ 80 % over 12 h',
    unit: '%',
    comparator: '>=',
    threshold: 80,
    reading: 'Database CPU and memory',
    read: (h) => (h.dbCpuMemoryMax === null ? null : pct(h.dbCpuMemoryMax)),
    // ⚠️ VERIFY: "over 12 h" is read as the highest value in 12 h, the HM-028 input as modelled.
    summary: (v) => `Highest database CPU or memory ${v} % over the last 12 h.`,
  },
  'AL-11': {
    kind: 'not-collected',
    condition: 'Database projected to reach its size threshold within 14 days',
    unit: 'days',
    threshold: 14,
    forSeconds: 0,
    missing: 'Database size history is not collected in this version.',
  },
  'AL-12': {
    kind: 'not-collected',
    condition: 'DCAM health checks of the Airflow API fail for 5 min',
    unit: '',
    threshold: null,
    forSeconds: 300,
    missing: 'DCAM’s own Airflow API health checks are not collected in this version; they arrive with M1.',
  },
  'AL-13': {
    kind: 'not-collected',
    condition: 'Triggerer ≥ 90 % of capacity for 15 min',
    unit: '%',
    threshold: 90,
    forSeconds: 900,
    missing: 'Triggerer capacity is not collected in this version.',
  },
  'AL-14': {
    kind: 'not-collected',
    condition: 'A DAG run misses its configured timeliness target (opt-in per DAG)',
    unit: '',
    threshold: null,
    forSeconds: 0,
    missing: 'Timeliness targets are not configured in this version.',
  },
  'AL-15': {
    kind: 'series',
    condition: 'A pool has no open slots while tasks wait for it, for 30 min',
    unit: 'min',
    // The value is the longest current starvation of one pool, so `for` is in the threshold.
    rule: { comparator: '>=', threshold: 30, forMs: 0, clearForMs: CLEAR_FOR_MS, noData: 'keep_state' },
    points: (s) => {
      const streaks = starvation(s.snapshots);
      const latest = latestAt(streaks, s.grid);
      return s.grid.map((t, i) => {
        const x = isFresh(latest[i], t, SNAPSHOT_CADENCE_MS);
        return x ? { at: t, value: x.minutes } : { at: t, ...STALE };
      });
    },
    summary: (s) => {
      const x = isFresh(starvation(s.snapshots).at(-1), s.now, SNAPSHOT_CADENCE_MS);
      if (!x) return NO_SNAPSHOT;
      return x.pool
        ? `Pool ${x.pool} has had no open slots while tasks waited for it for ${durationText(x.minutes * MIN)}.`
        : 'Every pool had open slots, or no work waiting for it, in the latest snapshot.';
    },
  },
  'AL-16': {
    kind: 'not-collected',
    condition: 'A Composer update or upgrade operation ended in error',
    unit: '',
    threshold: null,
    forSeconds: 0,
    missing: 'Environment operations are not collected in this version.',
  },
  'AL-17': {
    kind: 'series',
    condition: 'A collector has had no successful cycle for 10 min',
    unit: 'min',
    rule: { comparator: '>=', threshold: 10, forMs: 0, clearForMs: CLEAR_FOR_MS, noData: 'alerting' },
    points: (s) => {
      const snap = latestAt(s.snapshots, s.grid);
      const sample = latestAt(s.samples, s.grid);
      return s.grid.map((t, i) => {
        const a = snap[i];
        const b = sample[i];
        return { at: t, value: a && b ? round((t - Math.min(a.at, b.at)) / MIN) : null };
      });
    },
    summary: (s) => {
      const a = s.snapshots.at(-1);
      const b = s.samples.at(-1);
      if (!a || !b) return 'A collector has not completed a cycle in the last 25 hours.';
      return `Latest live snapshot ${durationText(s.now - a.at)} ago; latest worker sample ${durationText(s.now - b.at)} ago.`;
    },
  },
  'AL-18': {
    kind: 'reading',
    condition: 'Database healthy < 95 % of the time over 4 h',
    unit: '%',
    comparator: '<',
    threshold: 95,
    reading: 'Database health (database_health)',
    read: (h) => (h.dbHealthyRatio === null ? null : pct(h.dbHealthyRatio)),
    summary: (v) => `Database healthy ${v} % of the last 4 h.`,
  },
  'AL-19': {
    kind: 'reading',
    condition: '> 1 worker container restart in 24 h, excluding scale-down',
    unit: 'restarts',
    comparator: '>',
    threshold: 1,
    reading: 'Worker container restarts',
    read: (h) => h.workerRestarts24h,
    summary: (v) =>
      `${v} worker container ${v === 1 ? 'restart' : 'restarts'} in the last 24 h, excluding scale-down. Maintenance windows are not excluded yet.`,
  },
};

interface Evaluated {
  readonly rule: AlertRule;
  readonly events: readonly AlertEvent[];
}

function unknownRule(
  pack: PackRule,
  def: RuleDefinition,
  envId: string,
  tier: Tier,
  summary: string,
): AlertRule {
  return {
    id: pack.id,
    name: pack.name,
    env_id: envId,
    severity: severityFor(pack, tier),
    state: 'unknown',
    condition: def.condition,
    for_seconds:
      def.kind === 'series' ? def.rule.forMs / SECOND : def.kind === 'reading' ? 0 : def.forSeconds,
    threshold: def.kind === 'series' ? def.rule.threshold : def.threshold,
    value: null,
    unit: def.unit,
    since: null,
    summary,
    runbook: pack.runbook,
    export_cloud_monitoring: pack.export,
    fired_count_24h: 0,
  };
}

function evaluateRule(pack: PackRule, s: Signals, from: number): Evaluated {
  const def = DEFINITIONS[pack.id];
  const { envId, tier } = s.config;
  if (def.kind === 'not-collected')
    return { rule: unknownRule(pack, def, envId, tier, def.missing), events: [] };

  let condition: AlertCondition;
  let evaluation: AlertEvaluation;
  let summary: string;
  if (def.kind === 'reading') {
    const value = def.read(s.health);
    if (value === null) {
      const missing = `${def.reading} is not collected for this environment.`;
      return { rule: unknownRule(pack, def, envId, tier, missing), events: [] };
    }
    condition = {
      comparator: def.comparator,
      threshold: def.threshold,
      forMs: 0,
      clearForMs: 0,
      noData: 'ok',
    };
    evaluation = evaluateAlert(condition, [{ at: s.now, value }], { from });
    summary = def.summary(value);
  } else {
    condition = def.rule;
    evaluation = evaluateAlert(condition, def.points(s), { from });
    summary = def.summary(s, evaluation);
  }

  const severity = severityFor(pack, tier);
  return {
    rule: {
      id: pack.id,
      name: pack.name,
      env_id: envId,
      severity,
      state: evaluation.state,
      condition: def.condition,
      for_seconds: condition.forMs / SECOND,
      threshold: condition.threshold,
      value: evaluation.value,
      unit: def.unit,
      since: evaluation.since === null ? null : iso(evaluation.since),
      summary,
      runbook: pack.runbook,
      export_cloud_monitoring: pack.export,
      fired_count_24h: evaluation.firedCount,
    },
    events: evaluation.events.map((e) => ({
      id: `${envId}/${pack.id}/${e.kind}/${e.at}`,
      rule_id: pack.id,
      env_id: envId,
      severity,
      kind: e.kind,
      at: iso(e.at),
      value: e.value,
    })),
  };
}

async function environmentAlerts(deps: AlertDeps, envId: string, now: number) {
  const from = now - ALERT_WINDOW_MS;
  const start = from - WARM_UP_MS;
  const config = await deps.model.config(envId);
  if (!config) {
    const missing = 'No configuration has been collected for this environment yet.';
    return {
      asOf: null,
      evaluated: ALERT_PACK.map((p) => ({
        rule: unknownRule(p, DEFINITIONS[p.id], envId, 'other', missing),
        events: [],
      })),
    };
  }
  const lookback = STALE_AFTER_CADENCES * SAMPLE_CADENCE_MS;
  const [snapshots, samples, tries, health] = await Promise.all([
    deps.model.snapshots(envId, start - lookback, now + 1),
    deps.model.workerSamples(envId, start - lookback, now + 1),
    deps.store.taskTries(envId, start - BASELINE_DAYS * DAY - HOUR, now + 1),
    deps.model.platformHealth(envId),
  ]);
  const grid: number[] = [];
  for (let t = start; t <= now; t += EVALUATION_STEP_MS) grid.push(t);
  const signals: Signals = { config, now, grid, snapshots, samples, tries, health };
  const latest = Math.max(snapshots.at(-1)?.at ?? -Infinity, samples.at(-1)?.at ?? -Infinity);
  return {
    asOf: Number.isFinite(latest) ? latest : null,
    evaluated: ALERT_PACK.map((p) => evaluateRule(p, signals, from)),
  };
}

export async function getAlerts(deps: AlertDeps, q: AlertQuery): Promise<Alerts> {
  const now = deps.clock.now();
  const perEnv = await Promise.all(q.envIds.map((id) => environmentAlerts(deps, id, now)));
  const asOf = perEnv.reduce<number | null>(
    (m, e) => (e.asOf === null ? m : m === null ? e.asOf : Math.max(m, e.asOf)),
    null,
  );
  const evaluated = perEnv.flatMap((e) => e.evaluated);
  return {
    data_as_of: iso(asOf ?? now),
    sources: [...q.sources],
    rules: evaluated.map((e) => e.rule),
    events: evaluated
      .flatMap((e) => e.events)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}
