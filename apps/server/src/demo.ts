/**
 * Demo workspace (FR-EMU-01, spec §20.6): three simulated environments for the fictitious "acme"
 * organisation. Task tries go into an in-memory DuckDB store; configuration, live snapshots, worker
 * samples and platform health are served by the in-memory environment model. No credentials and no
 * network access.
 */
import type { Meta } from '@dcam/contracts';
import { openStore, type Store } from '@dcam/duckdb-store';
import {
  InMemoryEnvironmentModel,
  acmeScenario,
  simulateEnvironment,
  type AcmeEnvironment,
} from '@dcam/fakes';
import type { Clock, EnvironmentModelSource } from '@dcam/ports';

export interface Workspace {
  readonly mode: Meta['mode'];
  readonly environments: Meta['environments'];
  readonly store: Store;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
}

/** Hours of simulated history: the selected range plus an equal previous period for comparisons. */
export const DEMO_HOURS = 48;

const ENVIRONMENTS: ReadonlyArray<{ id: AcmeEnvironment; tier: Meta['environments'][number]['tier'] }> = [
  { id: 'acme-prod', tier: 'prod' },
  { id: 'acme-test', tier: 'test' },
  { id: 'acme-dev', tier: 'dev' },
];

export async function createDemoWorkspace(
  options: { now?: () => number; seed?: number; hours?: number } = {},
): Promise<Workspace> {
  const clock: Clock = { now: options.now ?? (() => Date.now()) };
  const store = await openStore({ path: ':memory:', now: () => clock.now() });
  // Whole minutes keep snapshot and sample times aligned with the collector cadences.
  const now = Math.floor(clock.now() / 60_000) * 60_000;
  const seed = options.seed ?? 42;
  const results = ENVIRONMENTS.map((e, i) =>
    simulateEnvironment({
      seed: seed + i,
      now,
      hours: options.hours ?? DEMO_HOURS,
      scenario: acmeScenario(e.id),
    }),
  );
  for (const r of results) await store.upsertTaskTries(r.tries);
  return {
    mode: 'demo',
    environments: ENVIRONMENTS.map((e) => ({ env_id: e.id, display_name: e.id, tier: e.tier })),
    store,
    model: new InMemoryEnvironmentModel(results),
    clock,
  };
}
