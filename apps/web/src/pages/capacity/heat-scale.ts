/**
 * The heatmaps' colour scale (FR-UI-06): viridis, a perceptually uniform sequential map whose lightness rises
 * monotonically and which stays readable with the common colour-vision deficiencies (van der Walt and Smith,
 * https://bids.github.io/colormap/; nine stops as in viridisLite's `viridis(9)`). The scale runs away from the
 * panel colour so the busiest cells stand out in both themes: dark to bright on the dark theme, light to dark on
 * the light theme. The quiet end is cut short of the panel colour, so an observed zero never looks like an
 * empty, unobserved cell.
 *
 * @implements FR-UI-06, NFR-A11Y-01
 */
import type { ThemeMode } from '@dcam/ui-kit';

export const VIRIDIS = [
  '#440154',
  '#472D7B',
  '#3B528B',
  '#2C728E',
  '#21908C',
  '#27AD81',
  '#5DC863',
  '#AADC32',
  '#FDE725',
] as const;

/** Where on viridis 0 and 1 land per theme: [quiet, busy]. */
const SPAN: Readonly<Record<ThemeMode, readonly [number, number]>> = {
  dark: [0.125, 1],
  light: [0.875, 0],
};

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0').toUpperCase();

/** The colour of `t` (0 quiet to 1 busy) for a theme; values outside 0–1 are clamped. */
export function heatColour(t: number, mode: ThemeMode): string {
  const [quiet, busy] = SPAN[mode];
  const v = quiet + (busy - quiet) * Math.min(1, Math.max(0, t));
  const pos = v * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = channels(VIRIDIS[i] ?? VIRIDIS[0]);
  const b = channels(VIRIDIS[i + 1] ?? VIRIDIS[8]);
  return `#${a.map((c, k) => hex2(c + ((b[k] ?? c) - c) * f)).join('')}`;
}

/** WCAG 2 relative luminance of a `#RRGGBB` colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two `#RRGGBB` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
