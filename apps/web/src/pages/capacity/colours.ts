/**
 * Series colours for the capacity charts from the Okabe–Ito palette, designed to stay distinguishable with the
 * common colour-vision deficiencies (Okabe and Ito, "Color Universal Design", https://jfly.uni-koeln.de/color/).
 * Each theme takes the shade that reads against its panel; lines also differ by dash, so colour is never the
 * only cue (spec §12.11).
 *
 * @implements FR-UI-06
 */
import type { ThemeMode } from '@dcam/ui-kit';

export const OKABE_ITO = {
  orange: '#E69F00',
  skyBlue: '#56B4E9',
  bluishGreen: '#009E73',
  yellow: '#F0E442',
  blue: '#0072B2',
  vermillion: '#D55E00',
  reddishPurple: '#CC79A7',
} as const;

export interface CapacityColours {
  /** Running task instances, and workers. */
  readonly running: string;
  /** Queued task instances. */
  readonly queued: string;
  /** Cross-checks and baselines. */
  readonly secondary: string;
  /** Capacity-bound and saturation highlights. */
  readonly bound: string;
}

export function capacityColours(mode: ThemeMode): CapacityColours {
  return {
    running: mode === 'dark' ? OKABE_ITO.skyBlue : OKABE_ITO.blue,
    queued: OKABE_ITO.orange,
    secondary: mode === 'dark' ? OKABE_ITO.reddishPurple : OKABE_ITO.bluishGreen,
    bound: OKABE_ITO.vermillion,
  };
}
