import { describe, expect, it } from 'vitest';
import { createCollectors } from '../../src/index';

describe('FR-COLL-01 the M1 collector set', () => {
  it('FR-COLL-01: creates the M1 collectors and the backfill (FR-COLL-04), each with a budget, an output and source kinds', () => {
    const collectors = createCollectors();
    expect(collectors.map((c) => c.manifest.id)).toEqual([
      'composer.config',
      'af.inventory',
      'af.live',
      'af.facts',
      'af.backfill',
      'mon.core',
    ]);
    for (const { manifest } of collectors) {
      expect(manifest.maxRequestsPerCycle).toBeGreaterThan(0);
      expect(manifest.outputs.length).toBeGreaterThan(0);
      expect(manifest.sourceKinds.length).toBeGreaterThan(0);
    }
  });

  it('FR-COLL-01: a self-managed Airflow (the emulator) runs only the Airflow collectors, and af.live writes its config', () => {
    const forAirflow = createCollectors().filter((c) => c.manifest.sourceKinds.includes('airflow'));
    expect(forAirflow.map((c) => c.manifest.id)).toEqual([
      'af.inventory',
      'af.live',
      'af.facts',
      'af.backfill',
    ]);
    expect(forAirflow.find((c) => c.manifest.id === 'af.live')?.manifest.outputs).toContain('config');
  });

  it('FR-COLL-01: each call creates fresh collectors, so paging state is never shared between engines', () => {
    const [a] = createCollectors();
    const [b] = createCollectors();
    expect(a).not.toBe(b);
  });
});
