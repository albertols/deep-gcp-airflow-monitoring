/**
 * The context bar's time range presets (FR-UI-01): the `range` values of the contract, 15 minutes to
 * 90 days, with the words the UI uses for them.
 *
 * @implements FR-UI-01
 */
import type { Range } from '@dcam/contracts';

interface RangePreset {
  /** "Last 7 days": the picker. */
  readonly label: string;
  /** "7 days": inside sentences ("compared with the previous 7 days"). */
  readonly span: string;
}

export const RANGE_PRESETS: Readonly<Record<Range, RangePreset>> = {
  '15m': { label: 'Last 15 minutes', span: '15 minutes' },
  '1h': { label: 'Last hour', span: 'hour' },
  '6h': { label: 'Last 6 hours', span: '6 hours' },
  '24h': { label: 'Last 24 hours', span: '24 hours' },
  '7d': { label: 'Last 7 days', span: '7 days' },
  '30d': { label: 'Last 30 days', span: '30 days' },
  '90d': { label: 'Last 90 days', span: '90 days' },
};

/** Every preset, shortest first. */
export const RANGES = Object.keys(RANGE_PRESETS) as Range[];

export const isRange = (value: string): value is Range => Object.hasOwn(RANGE_PRESETS, value);

/** Ranges long enough that the first answer reads many days of stored history (NFR-PERF-01). */
const LONG_RANGES: ReadonlySet<Range> = new Set(['30d', '90d']);

/** Accessible label of a loading skeleton; long ranges say that they take a while. */
export function loadingText(what: string, range?: Range): string {
  return range && LONG_RANGES.has(range)
    ? `Loading ${what}: reading ${RANGE_PRESETS[range].span} of history takes a few seconds`
    : `Loading ${what}`;
}
