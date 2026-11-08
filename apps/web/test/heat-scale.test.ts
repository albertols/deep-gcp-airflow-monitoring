import { describe, expect, it } from 'vitest';
import { tokens } from '@dcam/ui-kit';
import { VIRIDIS, contrastRatio, heatColour, relativeLuminance } from '../src/pages/capacity/heat-scale';

const STEPS = Array.from({ length: 21 }, (_, i) => i / 20);
const PANEL = { dark: tokens.dark.bgSurface, light: tokens.light.bgSurface } as const;

describe('Heatmap colour scale (FR-UI-06, NFR-A11Y-01)', () => {
  it('FR-UI-06: every colour comes from viridis, a colour-blind-safe sequential scale', () => {
    expect(VIRIDIS[0]).toBe('#440154');
    expect(VIRIDIS[VIRIDIS.length - 1]).toBe('#FDE725');
    expect(heatColour(1, 'dark')).toBe('#FDE725');
    expect(heatColour(1, 'light')).toBe('#440154');
  });

  it('FR-UI-06: lightness changes in one direction, away from the panel, in both themes', () => {
    const dark = STEPS.map((t) => relativeLuminance(heatColour(t, 'dark')));
    const light = STEPS.map((t) => relativeLuminance(heatColour(t, 'light')));
    for (let i = 1; i < STEPS.length; i += 1) {
      expect(dark[i]).toBeGreaterThan(dark[i - 1] ?? 0);
      expect(light[i]).toBeLessThan(light[i - 1] ?? 1);
    }
  });

  it('NFR-A11Y-01: the busiest cells stand out from the panel by at least 3:1, and the quietest stay visible', () => {
    for (const mode of ['dark', 'light'] as const) {
      expect(contrastRatio(heatColour(1, mode), PANEL[mode])).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(heatColour(0, mode), PANEL[mode])).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('FR-UI-06: values outside 0 to 1 are clamped', () => {
    expect(heatColour(-1, 'dark')).toBe(heatColour(0, 'dark'));
    expect(heatColour(2, 'light')).toBe(heatColour(1, 'light'));
  });
});
