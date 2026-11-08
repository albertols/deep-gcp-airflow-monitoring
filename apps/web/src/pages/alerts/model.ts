/**
 * Presentation model for the alerts page: state and severity labels, the order rules are listed in,
 * mean time to resolve and firing periods derived from the event history (spec §16.2, §16.7).
 *
 * @implements FR-ALRT-01, FR-ALRT-06
 */
import type { AlertEvent, AlertRule, AlertState, Severity } from '@dcam/contracts';
import { UTC_TIME, type TimeFormat } from '../../components/time';

export const STATES: readonly AlertState[] = ['firing', 'pending', 'resolved', 'inactive', 'unknown'];

export const STATE_LABEL: Readonly<Record<AlertState, string>> = {
  firing: 'Firing',
  pending: 'Pending',
  resolved: 'Resolved',
  inactive: 'Inactive',
  unknown: 'Unknown',
};

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

export const EXPORT_LABEL: Readonly<Record<AlertRule['export_cloud_monitoring'], string>> = {
  yes: 'Exportable',
  partial: 'Partial',
  no: 'Not exportable',
};

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { critical: 0, warning: 1, info: 2 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Firing first, then pending, then the rest; within a state by severity, environment and rule. */
export function sortRules(rules: readonly AlertRule[]): AlertRule[] {
  return [...rules].sort(
    (a, b) =>
      STATES.indexOf(a.state) - STATES.indexOf(b.state) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      cmp(a.env_id, b.env_id) ||
      cmp(a.id, b.id),
  );
}

const key = (e: Pick<AlertEvent, 'env_id' | 'rule_id'>) => `${e.env_id}\u0000${e.rule_id}`;

/** Events per rule and environment, oldest first. */
function byRule(events: readonly AlertEvent[]): Map<string, AlertEvent[]> {
  const out = new Map<string, AlertEvent[]>();
  for (const e of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const list = out.get(key(e)) ?? [];
    list.push(e);
    out.set(key(e), list);
  }
  return out;
}

/** Mean seconds from fired to resolved over alerts that resolved; `null` when none did. */
export function meanTimeToResolve(events: readonly AlertEvent[]): { seconds: number | null; count: number } {
  const durations: number[] = [];
  for (const list of byRule(events).values()) {
    let firedAt: number | null = null;
    for (const e of list) {
      if (e.kind === 'fired') firedAt = Date.parse(e.at);
      else if (firedAt !== null) {
        durations.push((Date.parse(e.at) - firedAt) / 1000);
        firedAt = null;
      }
    }
  }
  const count = durations.length;
  return { seconds: count ? durations.reduce((s, d) => s + d, 0) / count : null, count };
}

export interface FiringPeriod {
  readonly envId: string;
  readonly ruleId: string;
  readonly severity: Severity;
  readonly start: number;
  readonly end: number;
  /** Still firing at the end of the window. */
  readonly open: boolean;
}

/**
 * Firing periods within [from, to]: a resolved event without a fired one started before the window;
 * a fired event without a resolution is still firing; a firing rule without events fired before it.
 */
export function firingPeriods(
  events: readonly AlertEvent[],
  rules: readonly AlertRule[],
  from: number,
  to: number,
): FiringPeriod[] {
  const out: FiringPeriod[] = [];
  const open = new Set<string>();
  for (const [k, list] of byRule(events)) {
    let start: number | null = null;
    for (const e of list) {
      const at = Date.parse(e.at);
      const base = { envId: e.env_id, ruleId: e.rule_id, severity: e.severity };
      if (e.kind === 'fired') start = at;
      else {
        out.push({ ...base, start: start ?? from, end: at, open: false });
        start = null;
      }
      if (e === list.at(-1) && start !== null) {
        out.push({ ...base, start, end: to, open: true });
        open.add(k);
      }
    }
  }
  for (const r of rules) {
    if (r.state !== 'firing' || open.has(key({ env_id: r.env_id, rule_id: r.id }))) continue;
    const since = r.since === null ? from : Math.max(from, Date.parse(r.since));
    out.push({ envId: r.env_id, ruleId: r.id, severity: r.severity, start: since, end: to, open: true });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** "11:40 UTC", with the date when it is not the reference day, in the context bar's zone (FR-UI-01). */
export function formatTime(iso: string, reference: string, time: TimeFormat = UTC_TIME): string {
  const clock = `${time.clock(iso)} ${time.zoneName(iso)}`;
  return time.day(iso) === time.day(reference) ? clock : `${time.day(iso)} ${clock}`;
}
