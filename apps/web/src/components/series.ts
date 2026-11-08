/**
 * Categorical series for charts that overlay up to four lines (spec §12.5, §12.8): the Okabe–Ito hues (sky
 * blue, orange, bluish green, reddish purple), with darker shades of the same hues on the light theme. Each
 * colour has 3:1 contrast with its theme's surface, and every pair stays distinct under protanopia,
 * deuteranopia and tritanopia (the palette test checks both). Colour is never the only cue: each series
 * also has a letter, a dash pattern and a marker.
 *
 * @implements NFR-A11Y-01
 */
import type { ThemeMode } from '@dcam/ui-kit';

export const SERIES: Readonly<Record<ThemeMode, readonly [string, string, string, string]>> = {
  dark: ['#56B4E9', '#E69F00', '#009E73', '#CC79A7'],
  light: ['#0072B2', '#D55E00', '#007A5A', '#A8487E'],
};

export type Marker = 'circle' | 'square' | 'triangle' | 'diamond';

export interface SeriesStyle {
  readonly color: string;
  /** SVG `stroke-dasharray`; `none` is a solid line. */
  readonly dash: string;
  readonly marker: Marker;
  /** A, B, C or D: the series' name in tables and legends. */
  readonly letter: string;
}

const DASHES = ['none', '7 3', '2 3', '8 3 2 3'] as const;
const MARKERS: readonly Marker[] = ['circle', 'square', 'triangle', 'diamond'];
const LETTERS = ['A', 'B', 'C', 'D'] as const;

/** The style of the `index`-th series (0 to 3). */
export function seriesStyle(mode: ThemeMode, index: number): SeriesStyle {
  const i = ((index % 4) + 4) % 4;
  return {
    color: SERIES[mode][i] ?? SERIES[mode][0],
    dash: DASHES[i] ?? 'none',
    marker: MARKERS[i] ?? 'circle',
    letter: LETTERS[i] ?? 'A',
  };
}
