/**
 * Words and numbers of the capacity page (spec §12.7, §12.12): counts with their unit, spreads with the §8.9
 * low-sample rule, periods in the view's time zone, and where a limit came from. `null` is never written as 0.
 *
 * @implements FR-ENV-02, HM-032, NFR-DATA-03
 */
import type { Capacity, LimitSource, Spread } from '@dcam/contracts';
import { formatInt, formatShare } from '../../components/format';
import type { TimeFormat } from '../../components/time';

export const NO_DATA = 'No data';
export const UNKNOWN = 'Unknown';

const upToOne = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** `72`, `6.9`, or "No data" for a gap. */
export const formatCount = (v: number | null): string => (v === null ? NO_DATA : upToOne.format(v));

/** A share 0–1 as a percentage, or "No data". */
export const formatRatio = (v: number | null): string => (v === null ? NO_DATA : formatShare(v));

/**
 * The p95 of a spread, or with fewer than 20 samples its maximum marked "≤" and "low sample" (§8.9). `value`
 * is `null` without samples, so the caller says why.
 */
export function spreadP95(
  s: Spread,
  format: (v: number) => string,
): { readonly value: string | null; readonly lowSample: boolean } {
  if (s.p95 !== null) return { value: format(s.p95), lowSample: false };
  if (s.max !== null) return { value: `≤ ${format(s.max)}`, lowSample: true };
  return { value: null, lowSample: s.low_sample };
}

/** "5 Nov, 02:03–02:55 UTC (52 min)": a period in the view's zone, the end date only when it differs. */
export function periodText(time: TimeFormat, start: string, end: string, minutes: number): string {
  const sameDay = time.day(start) === time.day(end);
  return `${time.dayClock(start)}–${sameDay ? time.clock(end) : time.dayClock(end)} ${time.zoneName(start)} (${formatInt(minutes)} min)`;
}

/** Where a limit came from, in words (spec §14.1). */
export const LIMIT_SOURCE: Readonly<Record<LimitSource, string>> = {
  configured: 'Configured',
  override: 'Airflow configuration override',
  'composer-default': 'Composer default',
  'airflow-default': 'Airflow default',
  unknown: 'Unknown: DCAM could not read it',
};

/** Where the worker counts came from (HM-011); hostnames are a lower bound. */
export function workerCountSource(source: Capacity['slots_source']): string | null {
  switch (source) {
    case 'monitoring':
      return 'Worker counts from Cloud Monitoring samples.';
    case 'config':
      return 'Worker counts from the configured worker count.';
    case 'hostnames':
      return 'Worker counts estimated from task instance hostnames: a lower bound, as an idle worker runs no task.';
    default:
      return null;
  }
}

/** "15-minute" for 900 s, "1-hour" for 3,600 s. */
export const bucketName = (seconds: number): string =>
  seconds % 3600 === 0 ? `${seconds / 3600}-hour` : `${seconds / 60}-minute`;
