/**
 * `schedule_interval` of the Airflow 2.11.1 REST API v1 → the port's `schedule` text.
 *
 * The OpenAPI document (airflow/api_connexion/openapi/v1.yaml at tag 2.11.1, `ScheduleInterval`) allows
 * `CronExpression {value}`, `TimeDelta {days, seconds, microseconds}`, `RelativeDelta {…}` or `null`.
 * Dataset-triggered DAGs and custom timetables store the timetable's summary as a string, which the API
 * serialises as a `CronExpression` (airflow/models/dag.py L679–687 and
 * airflow/api_connexion/schemas/common_schema.py `ScheduleIntervalSchema._dump`, tag 2.11.1).
 *
 * Deltas are formatted as Python formats them, because that is the delta timetable's summary and what
 * the Airflow UI shows (airflow/timetables/_delta.py L38 at 2.11.1: `str(self._delta)`): `str(timedelta)`
 * (https://docs.python.org/3/library/datetime.html#datetime.timedelta.__str__) and dateutil's
 * `relativedelta.__repr__`.
 *
 * @implements FR-COLL-08
 */

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Python's `str(datetime.timedelta(days, seconds, microseconds))`, for example `1 day, 2:30:00`. */
export function pythonTimedelta(days: number, seconds: number, microseconds: number): string {
  // Normalise as Python does: 0 <= microseconds < 10^6, 0 <= seconds < 86400, days carry the sign.
  let us = microseconds;
  let s = seconds + Math.floor(us / 1_000_000);
  us = ((us % 1_000_000) + 1_000_000) % 1_000_000;
  const d = days + Math.floor(s / 86_400);
  s = ((s % 86_400) + 86_400) % 86_400;
  let out = `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
  if (d !== 0) out = `${d} day${Math.abs(d) === 1 ? '' : 's'}, ${out}`;
  if (us !== 0) out += `.${String(us).padStart(6, '0')}`;
  return out;
}

const RELATIVE = [
  'years',
  'months',
  'days',
  'leapdays',
  'hours',
  'minutes',
  'seconds',
  'microseconds',
] as const;
const ABSOLUTE = ['year', 'month', 'day', 'hour', 'minute', 'second', 'microsecond'] as const;
type RelativeDeltaFields = Partial<
  Record<(typeof RELATIVE)[number] | (typeof ABSOLUTE)[number], number | null>
>;

/**
 * dateutil's `repr(relativedelta(...))`, for example `relativedelta(months=+1, day=1)`. Relative fields
 * use `%+g`, which equals a signed integer below 10^6 (every practical schedule); `weekday` is not part
 * of the v1 API's `RelativeDelta`.
 */
export function pythonRelativedelta(fields: RelativeDeltaFields): string {
  const parts: string[] = [];
  for (const key of RELATIVE) {
    const v = fields[key];
    if (typeof v === 'number' && v !== 0) parts.push(`${key}=${v > 0 ? '+' : ''}${v}`);
  }
  for (const key of ABSOLUTE) {
    const v = fields[key];
    if (typeof v === 'number') parts.push(`${key}=${v}`);
  }
  return `relativedelta(${parts.join(', ')})`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * The schedule text of one DAG: `null` for unscheduled DAGs. An unknown shape (not in the 2.11.1 spec)
 * falls back to `timetable_description` instead of failing the whole page of DAGs.
 */
export function scheduleText(
  scheduleInterval: unknown,
  timetableDescription: string | null | undefined,
): string | null {
  const fallback = timetableDescription ? timetableDescription : null;
  if (scheduleInterval === null) return null;
  if (typeof scheduleInterval === 'string') return scheduleInterval;
  if (!isRecord(scheduleInterval)) return fallback;
  const v = scheduleInterval;
  switch (v['__type']) {
    case 'CronExpression':
      return typeof v['value'] === 'string' ? v['value'] : fallback;
    case 'TimeDelta':
      return isInt(v['days']) && isInt(v['seconds']) && isInt(v['microseconds'])
        ? pythonTimedelta(v['days'], v['seconds'], v['microseconds'])
        : fallback;
    case 'RelativeDelta': {
      const fields: RelativeDeltaFields = {};
      for (const key of [...RELATIVE, ...ABSOLUTE]) {
        const f = v[key];
        if (f === undefined || f === null) continue;
        if (!isInt(f)) return fallback;
        fields[key] = f;
      }
      return pythonRelativedelta(fields);
    }
    default:
      return fallback;
  }
}
