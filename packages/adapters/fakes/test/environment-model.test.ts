import { describe, expect, it } from 'vitest';
import { InMemoryEnvironmentModel, acmeScenario, simulateEnvironment } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const result = simulateEnvironment({ seed: 1, now: NOW, hours: 2, scenario: acmeScenario('acme-dev') });
const model = new InMemoryEnvironmentModel([result]);

describe('FR-EMU-01 in-memory environment model (EnvironmentModelSource port)', () => {
  it('serves configuration, DAG metadata and platform health per environment', async () => {
    expect((await model.config('acme-dev'))?.maxWorkers).toBe(3);
    expect(await model.config('acme-nope')).toBeNull();
    expect((await model.dags('acme-dev')).length).toBe(40);
    expect(await model.dags('acme-nope')).toEqual([]);
    expect((await model.platformHealth('acme-dev')).webServerHealthyRatio).toBeNull();
  });

  it('returns snapshots and worker samples in [from, to), oldest first', async () => {
    const from = NOW - 3_600_000;
    const snaps = await model.snapshots('acme-dev', from, from + 60_000);
    expect(snaps.map((s) => s.at)).toEqual([from, from + 30_000]);
    const samples = await model.workerSamples('acme-dev', from, from + 120_000);
    expect(samples.map((s) => s.at)).toEqual([from, from + 60_000]);
    expect(await model.snapshots('acme-nope', from, NOW)).toEqual([]);
  });

  it('reports unknown platform health for an unknown environment instead of failing', async () => {
    expect(await model.platformHealth('acme-nope')).toMatchObject({
      envHealthyRatio: null,
      importErrors: null,
    });
  });
});
