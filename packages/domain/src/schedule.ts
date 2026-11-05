/**
 * HM-009 schedule collision density: how strongly planned DAG run starts cluster in the same
 * minute-of-hour. Cron expressions are expanded per field; day-of-month, month and day-of-week
 * restrictions become an average number of starts per day.
 *
 * Minute-of-hour does not depend on whole-hour time-zone offsets; DAGs in time zones with half-hour
 * offsets shift by 30 minutes, which this version does not model.
 *
 * @implements HM-009
 */
import type { DagMeta } from './model';

const PRESETS: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@quarterly': '0 0 1 */3 *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
/** Average days per month, for day-of-month restrictions. */
const DAYS_PER_MONTH = 365.25 / 12;

interface Field {
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}
const MINUTE: Field = { min: 0, max: 59 };
const HOUR: Field = { min: 0, max: 23 };
const DAY_OF_MONTH: Field = { min: 1, max: 31 };
const MONTH: Field = { min: 1, max: 12, names: MONTHS };
const DAY_OF_WEEK: Field = { min: 0, max: 7, names: WEEKDAYS };

function value(raw: string, f: Field): number | null {
  const named = f.names?.indexOf(raw.toUpperCase()) ?? -1;
  if (named >= 0) return named + (f === MONTH ? 1 : 0);
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= f.min && n <= f.max ? n : null;
}

/** The set of values a cron field matches, or `null` if it cannot be parsed. */
function expand(field: string, f: Field): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepRaw, ...extra] = part.split('/');
    if (range === undefined || extra.length > 0) return null;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number | null;
    let hi: number | null;
    if (range === '*') [lo, hi] = [f.min, f.max];
    else {
      const [a, b, ...more] = range.split('-');
      if (a === undefined || more.length > 0) return null;
      lo = value(a, f);
      hi = b === undefined ? (stepRaw === undefined ? lo : f.max) : value(b, f);
    }
    if (lo === null || hi === null || hi < lo) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * Average starts per day in each minute-of-hour (60 entries) for a cron expression or preset, or
 * `null` for schedules without fixed start minutes (`@once`, `None`, timedeltas, assets).
 */
export function dailyStartsByMinute(schedule: string): number[] | null {
  const cron = PRESETS[schedule.trim()] ?? schedule.trim();
  const fields = cron.split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const minutes = expand(min, MINUTE);
  const hours = expand(hour, HOUR);
  const days = expand(dom, DAY_OF_MONTH);
  const months = expand(month, MONTH);
  const weekdays = expand(dow, DAY_OF_WEEK);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  // Sunday is both 0 and 7.
  if (weekdays.delete(7)) weekdays.add(0);
  const domShare = dom === '*' ? 1 : Math.min(1, days.size / DAYS_PER_MONTH);
  const dowShare = dow === '*' ? 1 : weekdays.size / 7;
  // Cron matches either restricted day field when both are set.
  const dayShare = dom !== '*' && dow !== '*' ? Math.min(1, domShare + dowShare) : domShare * dowShare;
  const perDay = hours.size * dayShare * (months.size / 12);
  const out = new Array<number>(60).fill(0);
  for (const m of minutes) out[m] = perDay;
  return out;
}

/**
 * The schedule with its start minute moved to `minute` (stagger offsets, FR-BOTL-04), or `null` when
 * its minute field is not one fixed minute.
 */
export function withStartMinute(schedule: string, minute: number): string | null {
  const cron = PRESETS[schedule.trim()] ?? schedule.trim();
  const fields = cron.split(/\s+/);
  if (fields.length !== 5 || !/^\d+$/.test(fields[0] ?? '') || dailyStartsByMinute(cron) === null)
    return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return [String(minute), ...fields.slice(1)].join(' ');
}

export interface CollisionDensity {
  /** Planned starts per day of every unpaused DAG with a cron schedule. */
  readonly totalDailyStarts: number;
  /** Starts per day in each minute-of-hour (60 entries). */
  readonly perMinute: readonly number[];
  readonly busiestMinute: number | null;
  /** HM-009: share of daily starts in the busiest minute-of-hour, 0–1. */
  readonly collisionIndex: number;
  /** DAGs starting in the busiest minute, with their starts per day there. */
  readonly dagsInBusiestMinute: ReadonlyArray<{ readonly dagId: string; readonly dailyStarts: number }>;
  /** Unpaused DAGs whose schedule has no fixed start minute (not counted). */
  readonly unscheduled: readonly string[];
}

export function collisionDensity(dags: readonly DagMeta[]): CollisionDensity {
  const perMinute = new Array<number>(60).fill(0);
  const byDag: Array<{ dagId: string; starts: number[] }> = [];
  const unscheduled: string[] = [];
  for (const d of dags) {
    if (d.paused) continue;
    const starts = dailyStartsByMinute(d.schedule);
    if (!starts) {
      unscheduled.push(d.dagId);
      continue;
    }
    starts.forEach((n, m) => (perMinute[m] = (perMinute[m] ?? 0) + n));
    byDag.push({ dagId: d.dagId, starts });
  }
  const totalDailyStarts = perMinute.reduce((s, n) => s + n, 0);
  let busiestMinute: number | null = null;
  perMinute.forEach((n, m) => {
    if (n > 0 && (busiestMinute === null || n > (perMinute[busiestMinute] ?? 0))) busiestMinute = m;
  });
  const busiest = busiestMinute;
  return {
    totalDailyStarts,
    perMinute,
    busiestMinute: busiest,
    collisionIndex: busiest === null ? 0 : (perMinute[busiest] ?? 0) / totalDailyStarts,
    dagsInBusiestMinute:
      busiest === null
        ? []
        : byDag
            .filter((d) => (d.starts[busiest] ?? 0) > 0)
            .map((d) => ({ dagId: d.dagId, dailyStarts: d.starts[busiest] ?? 0 })),
    unscheduled,
  };
}
