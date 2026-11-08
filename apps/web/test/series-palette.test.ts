import { describe, expect, it } from 'vitest';
import { tokens, type ThemeMode } from '@dcam/ui-kit';
import { SERIES, seriesStyle } from '../src/components/series';

// WCAG 2.2 relative luminance and contrast ratio.
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r = 0, g = 0, b = 0] = rgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

// Colour-vision deficiencies at full severity (Machado, Oliveira and Fernandes 2009), on linear RGB.
const CVD: Readonly<Record<string, readonly (readonly number[])[]>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
const simulate = (hex: string, m: readonly (readonly number[])[] | null) => {
  const c = rgb(hex).map(linear);
  if (!m) return c;
  return m.map((row) =>
    Math.min(
      1,
      Math.max(
        0,
        row.reduce((s, k, i) => s + k * (c[i] ?? 0), 0),
      ),
    ),
  );
};
/** CIE L*a*b* (D65) from linear RGB. */
const lab = ([r = 0, g = 0, b = 0]: number[]) => {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))] as const;
};
const deltaE = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

const MODES: readonly ThemeMode[] = ['dark', 'light'];

describe('NFR-A11Y-01 series palette', () => {
  it.each(MODES)('NFR-A11Y-01: every series colour has 3:1 contrast with the %s surface', (mode) => {
    for (const color of SERIES[mode])
      expect(contrast(color, tokens[mode].bgSurface), color).toBeGreaterThanOrEqual(3);
  });

  it.each(MODES)(
    'NFR-A11Y-01: the %s series stay apart under colour-vision deficiencies (ΔE ≥ 10)',
    (mode) => {
      const colors = SERIES[mode];
      for (const [name, m] of [['normal', null] as const, ...Object.entries(CVD)]) {
        for (let i = 0; i < colors.length; i++)
          for (let j = i + 1; j < colors.length; j++) {
            const d = deltaE(lab(simulate(colors[i] ?? '', m)), lab(simulate(colors[j] ?? '', m)));
            expect(d, `${name}: ${colors[i]} against ${colors[j]}`).toBeGreaterThanOrEqual(10);
          }
      }
    },
  );

  it('NFR-A11Y-01: colour is never the only cue: each series has its own letter, dash and marker', () => {
    const styles = [0, 1, 2, 3].map((i) => seriesStyle('dark', i));
    expect(new Set(styles.map((s) => s.letter)).size).toBe(4);
    expect(new Set(styles.map((s) => s.dash)).size).toBe(4);
    expect(new Set(styles.map((s) => s.marker)).size).toBe(4);
    expect(seriesStyle('light', 1).color).toBe(SERIES.light[1]);
  });
});
