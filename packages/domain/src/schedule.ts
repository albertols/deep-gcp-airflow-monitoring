/**
 * HM-009 schedule collision density: how strongly planned DAG run starts cluster in the same
 * minute-of-hour. Cron expressions are expanded per field; day-of-month, month and day-of-week
 * restrictions become an average number of starts per day.
 *
 * Minute-of-hour does not depend on whole-hour time-zone offsets; DAGs in time zones with half-hour
 * offsets shift by 30 minutes, which this version does not model.
 *
 * Also the data interval of a scheduled run (HM-002). In Airflow 2 the logical date is the start of the
 * data interval, and a run is usually created after its interval has ended ("Data Interval" in DAG Runs,
 * https://airflow.apache.org/docs/apache-airflow/2.11.0/core-concepts/dag-run.html#data-interval). A cron
 * string uses `CronDataIntervalTimetable` (the interval ends at the next cron time) and a timedelta
 * `DeltaDataIntervalTimetable` (it ends one delta later)
 * (https://airflow.apache.org/docs/apache-airflow/2.11.0/authoring-and-scheduling/timetable.html).
 * `[scheduler] create_cron_data_intervals = False` switches cron strings to `CronTriggerTimetable`
 * (no interval; Airflow 2.11.1 configuration reference, read 2026-11-07); the start-delay logic detects that from the run itself.
 * Cron times are evaluated in UTC, so a logical date the cron does not produce in UTC (a DAG in another
 * time zone) gives no interval rather than a wrong one.
 *
 * @implements HM-009, HM-002, FR-BOTL-03
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

/** The start minutes and hours of a cron schedule, and its average starts per day in each of those cells. */
interface DailyShape {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  /** Starts per day in each (hour, minute) cell the schedule fires in. */
  readonly perCell: number;
}

function dailyShape(schedule: string): DailyShape | null {
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
  return { minutes, hours, perCell: dayShare * (months.size / 12) };
}

/**
 * Average starts per day in each minute-of-hour (60 entries) for a cron expression or preset, or
 * `null` for schedules without fixed start minutes (`@once`, `None`, timedeltas, assets).
 */
export function dailyStartsByMinute(schedule: string): number[] | null {
  const shape = dailyShape(schedule);
  if (!shape) return null;
  const perDay = shape.hours.size * shape.perCell;
  const out = new Array<number>(60).fill(0);
  for (const m of shape.minutes) out[m] = perDay;
  return out;
}

/**
 * Average starts per day in each hour-of-day × minute-of-hour cell (1,440 entries, index `hour × 60 +
 * minute`, UTC) for a cron expression or preset, or `null` like {@link dailyStartsByMinute} (FR-BOTL-03).
 */
export function dailyStartsByHourMinute(schedule: string): number[] | null {
  const shape = dailyShape(schedule);
  if (!shape) return null;
  const out = new Array<number>(24 * 60).fill(0);
  for (const h of shape.hours) for (const m of shape.minutes) out[h * 60 + m] = shape.perCell;
  return out;
}

/** The schedule as cron text, presets expanded and whitespace collapsed: one key per schedule. */
export const cronKey = (schedule: string) =>
  (PRESETS[schedule.trim()] ?? schedule.trim()).replace(/\s+/g, ' ');

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;

interface Cron {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  /** Day-of-month and day-of-week restrictions combine with OR when both are set (Vixie cron). */
  readonly domAny: boolean;
  readonly dowAny: boolean;
}

function parseCron(schedule: string): Cron | null {
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
  if (weekdays.delete(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, domAny: dom.startsWith('*'), dowAny: dow.startsWith('*') };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.days.has(d.getUTCDate());
  const dow = c.weekdays.has(d.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

const cronMatches = (c: Cron, at: number) => {
  const d = new Date(at);
  return (
    at % MIN_MS === 0 &&
    c.minutes.has(d.getUTCMinutes()) &&
    c.hours.has(d.getUTCHours()) &&
    c.months.has(d.getUTCMonth() + 1) &&
    dayMatches(c, d)
  );
};

/** The first cron time strictly after `after` (UTC), within five years; `null` if none. */
function nextCronTime(c: Cron, after: number): number | null {
  let t = Math.floor(after / MIN_MS) * MIN_MS + MIN_MS;
  const limit = after + 5 * 366 * DAY_MS;
  while (t <= limit) {
    const d = new Date(t);
    const [y, mo, da, h] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()];
    if (!c.months.has(mo + 1)) t = Date.UTC(y, mo + 1, 1);
    else if (!dayMatches(c, d)) t = Date.UTC(y, mo, da + 1);
    else if (!c.hours.has(h)) t = Date.UTC(y, mo, da, h + 1);
    else if (!c.minutes.has(d.getUTCMinutes())) t += MIN_MS;
    else return t;
  }
  return null;
}

/** Python's `str(timedelta)` as the Airflow API adapter prints it (`0:07:00`, `1 day, 0:00:00`), in ms. */
function timedeltaMs(schedule: string): number | null {
  const m = /^(?:(\d+) days?, )?(\d+):(\d{2}):(\d{2})(?:\.(\d{6}))?$/.exec(schedule.trim());
  if (!m) return null;
  const [, days, h, min, s, us] = m;
  const ms =
    ((Number(days ?? 0) * 24 + Number(h)) * 3600 + Number(min) * 60 + Number(s)) * 1000 +
    Math.floor(Number(us ?? 0) / 1000);
  return ms > 0 ? ms : null;
}

/**
 * HM-002: the end of the data interval that starts at `logicalDate`, for a cron (or preset) or
 * timedelta schedule; `null` when DCAM cannot derive it (no schedule, `@once`, assets, custom
 * timetables, relativedelta, or a cron the logical date does not match in UTC).
 */
export function dataIntervalEnd(schedule: string, logicalDate: number): number | null {
  const delta = timedeltaMs(schedule);
  if (delta !== null) return logicalDate + delta;
  const cron = parseCron(schedule);
  if (!cron || !cronMatches(cron, logicalDate)) return null;
  return nextCronTime(cron, logicalDate);
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
