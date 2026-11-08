/**
 * Time range presets of the context bar (FR-UI-01): their length, and the chart bucket that keeps a
 * series readable at that length. Every range-based use case reads these, so a range means the same
 * window, and its comparison period the same length, on every panel.
 *
 * @implements FR-UI-01, NFR-PERF-06
 */
import type { Range } from '@dcam/contracts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Every preset, shortest first: 15 minutes to 90 days, the raw retention of task instances (FR-STORE-02). */
export const RANGES: readonly Range[] = ['15m', '1h', '6h', '24h', '7d', '30d', '90d'];

/** Length of each selectable time range, in ms. */
export const RANGE_MS: Readonly<Record<Range, number>> = {
  '15m': 15 * MIN,
  '1h': HOUR,
  '6h': 6 * HOUR,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
};

/**
 * Bucket of time-series charts per range, in ms: at most 360 buckets, so a 30-day chart has 240 three-hour
 * bars instead of 43,200 one-minute ones (NFR-PERF-06). Fixed per preset, so a shared link shows the same
 * buckets on every screen.
 */
export const CHART_BUCKET_MS: Readonly<Record<Range, number>> = {
  '15m': MIN,
  '1h': MIN,
  '6h': 5 * MIN,
  '24h': 15 * MIN,
  '7d': HOUR,
  '30d': 3 * HOUR,
  '90d': 6 * HOUR,
};

/** True for a value the `range` query parameter accepts. */
export const isRange = (value: string): value is Range => (RANGES as readonly string[]).includes(value);
