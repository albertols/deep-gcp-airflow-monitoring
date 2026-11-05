import type { Range } from '@dcam/contracts';

/** Length of each selectable time range, in ms. */
export const RANGE_MS: Readonly<Record<Range, number>> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
};
