/**
 * Local alert evaluation (spec §16.1, §16.2): a state machine over a time series of condition values.
 *
 * States: `inactive` → `pending` (condition true, `for` not yet elapsed) → `firing` → `resolved`
 * (condition false for `clearFor`, the hysteresis), plus `unknown` while the source is stale or not
 * collected. One evaluation yields at most one alert per rule and scope: while an alert is firing,
 * further breaches never open a second one. DCAM never alerts, or resolves, on data it does not have.
 *
 * @implements FR-ALRT-01, FR-ALRT-06
 */

export type AlertState = 'inactive' | 'pending' | 'firing' | 'resolved' | 'unknown';
export type Comparator = '>' | '>=' | '<' | '<=';
/** What a fresh evaluation without a value means (spec §16.1 `noData`). */
export type NoDataPolicy = 'alerting' | 'ok' | 'keep_state';

export interface Threshold {
  readonly comparator: Comparator;
  readonly threshold: number;
}

export interface AlertCondition extends Threshold {
  /** How long the condition must hold before the alert fires (pending → firing). */
  readonly forMs: number;
  /** How long the condition must be false before a firing alert resolves (hysteresis). */
  readonly clearForMs: number;
  readonly noData: NoDataPolicy;
}

/** One evaluation of a rule's signal. */
export interface ConditionPoint {
  readonly at: number;
  /** The signal value; `null` when the source is fresh but there is nothing to measure. */
  readonly value: number | null;
  /** Further conjuncts of a combined condition, for example "workers at max"; true when omitted. */
  readonly gate?: boolean;
  /** The source is stale beyond 3 × its cadence, or not collected: this evaluation is unknown. */
  readonly stale?: boolean;
}

export interface AlertTransition {
  readonly kind: 'fired' | 'resolved';
  readonly at: number;
  readonly value: number | null;
}

export interface AlertEvaluation {
  readonly state: AlertState;
  /** When the current state began (firing: when it fired); `null` for inactive or never evaluated. */
  readonly since: number | null;
  /** The latest evaluated value. */
  readonly value: number | null;
  /** Times the alert fired from the window start. */
  readonly firedCount: number;
  /** Fired and resolved transitions from the window start, oldest first. */
  readonly events: readonly AlertTransition[];
}

export interface EvaluationOptions {
  /** Events before this time warm the state up but are not reported (default: all reported). */
  readonly from?: number;
}

export function breaches(t: Threshold, value: number): boolean {
  switch (t.comparator) {
    case '>':
      return value > t.threshold;
    case '>=':
      return value >= t.threshold;
    case '<':
      return value < t.threshold;
    case '<=':
      return value <= t.threshold;
  }
}

/** Evaluates a rule over its points, oldest first, and returns where it stands after the last one. */
export function evaluateAlert(
  condition: AlertCondition,
  points: readonly ConditionPoint[],
  options: EvaluationOptions = {},
): AlertEvaluation {
  const from = options.from ?? -Infinity;
  const events: AlertTransition[] = [];
  /** The state ignoring staleness; `unknown` overlays it while the source is stale. */
  let phase: Exclude<AlertState, 'unknown'> = 'inactive';
  let unknownSince: number | null = null;
  let pendingSince: number | null = null;
  let firingSince: number | null = null;
  let clearSince: number | null = null;
  /** When the resting state (inactive or resolved) began. */
  let restSince: number | null = null;
  let value: number | null = null;
  let evaluated = false;

  const emit = (kind: AlertTransition['kind'], at: number, v: number | null) => {
    if (at >= from) events.push({ kind, at, value: v });
  };

  for (const p of points) {
    evaluated = true;
    value = p.value;
    if (p.stale) {
      // Timers cannot run on missing data; a firing alert stays open and is not resolved.
      unknownSince ??= p.at;
      pendingSince = null;
      clearSince = null;
      if (phase === 'pending') phase = restSince === null ? 'inactive' : 'resolved';
      continue;
    }
    if (p.value === null && condition.noData === 'keep_state') continue;
    unknownSince = null;
    const breached =
      p.value === null ? condition.noData === 'alerting' : p.gate !== false && breaches(condition, p.value);

    if (phase === 'firing') {
      if (breached) {
        clearSince = null;
        continue;
      }
      clearSince ??= p.at;
      if (p.at - clearSince >= condition.clearForMs) {
        phase = 'resolved';
        restSince = p.at;
        clearSince = null;
        firingSince = null;
        emit('resolved', p.at, p.value);
      }
      continue;
    }
    if (!breached) {
      if (phase === 'pending') phase = restSince === null ? 'inactive' : 'resolved';
      pendingSince = null;
      continue;
    }
    pendingSince ??= p.at;
    if (p.at - pendingSince >= condition.forMs) {
      phase = 'firing';
      firingSince = p.at;
      pendingSince = null;
      emit('fired', p.at, p.value);
    } else phase = 'pending';
  }

  if (!evaluated) return { state: 'unknown', since: null, value: null, firedCount: 0, events: [] };
  const state: AlertState = unknownSince === null ? phase : 'unknown';
  const since =
    state === 'unknown'
      ? unknownSince
      : state === 'firing'
        ? firingSince
        : state === 'pending'
          ? pendingSince
          : state === 'resolved'
            ? restSince
            : null;
  return {
    state,
    since,
    value,
    firedCount: events.filter((e) => e.kind === 'fired').length,
    events,
  };
}
