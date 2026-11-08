/**
 * The capacity analysis works minute by minute, so its endpoint takes 1 hour to 7 days (`CapacityRange`), while
 * the context bar offers 15 minutes to 90 days (`Range`). The page asks for the nearest supported range and
 * says so: another range is never shown silently.
 *
 * @implements FR-ENV-02, FR-UI-01
 */
import type { CapacityRange, Range } from '@dcam/contracts';
import { RANGE_PRESETS } from '../../components/range';

const NEAREST: Readonly<Record<Range, CapacityRange>> = {
  '15m': '1h',
  '1h': '1h',
  '6h': '6h',
  '24h': '24h',
  '7d': '7d',
  '30d': '7d',
  '90d': '7d',
};

/** Why the page shows another range than the context bar; the shortest and the longest have a reason each. */
const WHY: Readonly<Partial<Record<CapacityRange, string>>> = {
  '1h': 'the shortest range it analyses',
  '7d': 'the longest range it analyses, as it works minute by minute',
};

export interface CapacityRangeChoice {
  /** The range the capacity endpoint is asked for. */
  readonly range: CapacityRange;
  /** The sentence that says the page covers another range than the context bar; `null` when it does not. */
  readonly note: string | null;
}

export function capacityRangeOf(range: Range): CapacityRangeChoice {
  const asked = NEAREST[range];
  if (asked === range) return { range: asked, note: null };
  const shown = RANGE_PRESETS[asked].label.toLowerCase();
  const picked = RANGE_PRESETS[range].label.replace(/^Last/, 'last');
  return {
    range: asked,
    note: `Capacity covers the ${shown}: ${WHY[asked] ?? 'the nearest range it analyses'}. The ${picked} you picked apply to the other pages.`,
  };
}
