import { describe, expect, it } from 'vitest';
import { slotSeconds } from '@dcam/domain';
import { synthesizeTaskTries } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const base = { seed: 42, now: NOW, hours: 24, envId: 'acme-prod', dagCount: 120 };

describe('FR-EMU-01 demo fact synthesiser', () => {
  it('FR-EMU-01: is deterministic for a given seed', () => {
    expect(synthesizeTaskTries(base)).toEqual(synthesizeTaskTries(base));
    expect(synthesizeTaskTries({ ...base, seed: 7 })).not.toEqual(synthesizeTaskTries(base));
  });

  it('FR-EMU-01: produces tries inside the window, with running tries only up to "now"', () => {
    const tries = synthesizeTaskTries(base);
    expect(tries.length).toBeGreaterThan(1_000);
    for (const t of tries) {
      expect(t.envId).toBe('acme-prod');
      expect(t.startAt).not.toBeNull();
      expect(t.startAt as number).toBeGreaterThanOrEqual(NOW - 24 * 3_600_000);
      expect(t.startAt as number).toBeLessThanOrEqual(NOW);
      if (t.endAt === null) expect(t.state).toBe('running');
      else expect(t.endAt).toBeLessThanOrEqual(NOW);
    }
    expect(tries.some((t) => t.endAt === null)).toBe(true);
  });

  it('FR-EMU-01: concentrates load on a few DAGs, like real environments (Pareto)', () => {
    const tries = synthesizeTaskTries(base);
    const { byDag, totalExecutorSlotSeconds } = slotSeconds(tries, { from: NOW - 24 * 3_600_000, to: NOW, now: NOW });
    const shares = [...byDag.values()].map((d) => d.executorSlotSeconds / totalExecutorSlotSeconds).sort((a, b) => b - a);
    const top20pct = shares.slice(0, Math.ceil(shares.length * 0.2)).reduce((s, x) => s + x, 0);
    expect(byDag.size).toBe(120);
    expect(top20pct).toBeGreaterThan(0.5);
  });
});
