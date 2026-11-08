/**
 * Times as the context bar's time zone toggle says (FR-UI-01): UTC, the zone of Airflow and of every
 * timestamp DCAM stores, or the browser's local zone. Every rendered time goes through one of these
 * formatters, so the toggle changes them all; each label names its zone.
 *
 * @implements FR-UI-01
 */

export type TimeZoneChoice = 'utc' | 'local';

export interface TimeFormat {
  readonly zone: TimeZoneChoice;
  /** IANA name of the zone, `UTC` for UTC. */
  readonly timeZone: string;
  /** `UTC`, or the local zone's short name at that instant, like `CET` or `GMT+5:30`. */
  zoneName(at?: number | string): string;
  /** `11:02`. */
  clock(at: number | string): string;
  /** `11:02:31`. */
  clockSeconds(at: number | string): string;
  /** `5 Nov`. */
  day(at: number | string): string;
  /** `5 Nov, 11:02`. */
  dayClock(at: number | string): string;
  /** `5 Nov, 11:02 UTC`. */
  dateTime(at: number | string): string;
  /** `Thu, 5 Nov 2026, 11:02:31 UTC`: provenance footers and exact values on hover. */
  full(at: number | string): string;
}

const ms = (at: number | string) => (typeof at === 'number' ? at : Date.parse(at));

/** The browser's zone; `UTC` where the runtime does not say. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const cache = new Map<string, TimeFormat>();

/** Formatters for a zone choice; `local` uses `local` (the browser's zone by default). */
export function timeFormat(zone: TimeZoneChoice, local: string = localTimeZone()): TimeFormat {
  const timeZone = zone === 'utc' ? 'UTC' : local;
  const key = `${zone}:${timeZone}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const make = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { hourCycle: 'h23', timeZone, ...options });
  const clock = make({ hour: '2-digit', minute: '2-digit' });
  const clockSeconds = make({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const day = make({ day: 'numeric', month: 'short' });
  const dayClock = make({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const full = make({
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const name = make({ timeZoneName: 'short' });
  const zoneName = (at: number | string = Date.now()) =>
    zone === 'utc'
      ? 'UTC'
      : (name.formatToParts(ms(at)).find((p) => p.type === 'timeZoneName')?.value ?? timeZone);
  const format: TimeFormat = {
    zone,
    timeZone,
    zoneName,
    clock: (at) => clock.format(ms(at)),
    clockSeconds: (at) => clockSeconds.format(ms(at)),
    day: (at) => day.format(ms(at)),
    dayClock: (at) => dayClock.format(ms(at)),
    dateTime: (at) => `${dayClock.format(ms(at))} ${zoneName(at)}`,
    full: (at) => `${full.format(ms(at))} ${zoneName(at)}`,
  };
  cache.set(key, format);
  return format;
}

/** UTC formatters: the default where no context bar is present (page tests, the setup page). */
export const UTC_TIME: TimeFormat = timeFormat('utc', 'UTC');
