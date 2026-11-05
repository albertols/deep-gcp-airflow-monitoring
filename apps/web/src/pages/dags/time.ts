/** UTC time labels for the DAG pages (storage and the provenance footer are UTC, spec §8.9). */
import type { Range } from '@dcam/contracts';

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const dayClock = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** `11:02` (UTC). */
export const formatClock = (ms: number) => clock.format(ms);
/** `5 Nov, 11:02 UTC`. */
export const formatUtc = (iso: string | number) => `${dayClock.format(new Date(iso))} UTC`;

export const RANGE_LABEL: Record<Range, string> = { '1h': '1 h', '6h': '6 h', '24h': '24 h' };
