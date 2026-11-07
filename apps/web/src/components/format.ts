/**
 * Display formatting (spec §12.7): tabular numbers, humanised durations, percentages, and the §8.9
 * low-sample rule for tail percentiles.
 */
import type { Quantile } from '@dcam/contracts';

const intFmt = new Intl.NumberFormat('en-US');
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const upToOneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

export const formatInt = (n: number) => intFmt.format(n);
export const formatSlotHours = (seconds: number) => oneDecimal.format(seconds / 3600);
export const formatShare = (x: number | null) => (x === null ? '—' : pctFmt.format(x));

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/** Byte counts in decimal units (1 kB = 1,000 B) with at most one decimal, like `52.4 MB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (unit < BYTE_UNITS.length - 1 && Math.round(value * 10) / 10 >= 1000) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? intFmt.format(value) : upToOneDecimal.format(value)} ${BYTE_UNITS[unit]}`;
}

/** Durations like `42s`, `1m 15s`, `1h 12m` (exact seconds belong in a tooltip). */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m}m ${rest}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** A collection cadence: `10 s`, `2 min`. */
export function formatCadence(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  return s < 60 || s % 60 !== 0 ? `${intFmt.format(s)} s` : `${intFmt.format(s / 60)} min`;
}

/** A tail percentile; with fewer than 20 samples it is the max, shown as an upper bound (§8.9). */
export function formatQuantile(q: Quantile): string {
  if (q.value_seconds === null) return '—';
  return q.low_sample ? `≤ ${formatDuration(q.value_seconds)}` : formatDuration(q.value_seconds);
}

/** Tooltip text for a quantile: exact value and sample count. */
export function describeQuantile(q: Quantile): string {
  if (q.value_seconds === null) return 'No samples';
  const exact = `${intFmt.format(Math.round(q.value_seconds))} s from ${intFmt.format(q.samples)} samples`;
  return q.low_sample ? `${exact}: fewer than 20, so this is the max` : exact;
}

/** A message placed inside a sentence of ours, without its own final period (no "..": §12.12). */
export const clause = (message: string) => message.trim().replace(/\.+$/, '');

/**
 * Python's `str(timedelta)` as the Airflow API reports a delta schedule (`0:07:00`, `1 day, 0:00:00`),
 * in seconds; `null` for anything else.
 */
function timedeltaSeconds(schedule: string): number | null {
  const m = /^(?:(\d+) days?, )?(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(schedule.trim());
  if (!m) return null;
  const [, days, h, min, sec] = m;
  const total = (Number(days ?? 0) * 24 + Number(h)) * 3600 + Number(min) * 60 + Number(sec);
  return total > 0 ? total : null;
}

/** "7 min", "1 h 30 min", "1 day", "45 s". */
function everyText(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? '1 day' : `${intFmt.format(seconds / 86_400)} days`;
  const parts: string[] = [];
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) parts.push(`${intFmt.format(h)} h`);
  if (m) parts.push(`${m} min`);
  if (s) parts.push(`${s} s`);
  return parts.join(' ');
}

/**
 * A DAG schedule in plain words (§12.12): no schedule says so, a timedelta reads as "Every 7 min";
 * cron expressions, presets and timetable summaries are shown as written (`code`).
 */
export function formatSchedule(schedule: string): { readonly text: string; readonly code: boolean } {
  const s = schedule.trim();
  if (s === '' || s === 'None') return { text: 'No schedule: runs only when triggered', code: false };
  const delta = timedeltaSeconds(s);
  if (delta !== null) return { text: `Every ${everyText(delta)}`, code: false };
  return { text: s, code: true };
}
