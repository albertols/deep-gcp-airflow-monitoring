/**
 * Demo workspace (FR-EMU-01, spec §20.6): three simulated environments for the fictitious "acme"
 * organisation. Task tries go into an in-memory DuckDB store; configuration, live snapshots, worker
 * samples and platform health are served by the in-memory environment model. No credentials and no
 * network access.
 *
 * @implements FR-EMU-01, FR-UI-04
 */
import type { Meta } from '@dcam/contracts';
import { openStore } from '@dcam/duckdb-store';
import {
  InMemoryEnvironmentModel,
  acmeScenario,
  simulateEnvironment,
  type AcmeEnvironment,
} from '@dcam/fakes';
import type { Clock } from '@dcam/ports';
import type { Workspace } from './workspace';

export type { Workspace } from './workspace';

/** Hours of simulated history: the selected range plus an equal previous period for comparisons. */
export const DEMO_HOURS = 48;

const ENVIRONMENTS: ReadonlyArray<{ id: AcmeEnvironment; tier: Meta['environments'][number]['tier'] }> = [
  { id: 'acme-prod', tier: 'prod' },
  { id: 'acme-test', tier: 'test' },
  { id: 'acme-dev', tier: 'dev' },
];

/**
 * Where the demo environments "live", for the "Open in" links (FR-UI-04): fictitious projects and
 * environments, and Airflow addresses under `.example` (reserved by RFC 2606), so a demo link never reaches
 * a real environment. The UI says so.
 */
function demoSummary(e: (typeof ENVIRONMENTS)[number]): Meta['environments'][number] {
  const stage = e.id.replace(/^acme-/, '');
  return {
    env_id: e.id,
    display_name: e.id,
    tier: e.tier,
    composer: {
      project_id: `acme-${stage}-123`,
      location: 'us-central1',
      environment: `acme-composer-${stage}`,
    },
    airflow_uri: `https://acme-composer-${stage}.airflow.example`,
  };
}

export async function createDemoWorkspace(
  options: { now?: () => number; seed?: number; hours?: number } = {},
): Promise<Workspace> {
  // Whole minutes keep snapshot and sample times aligned with the collector cadences.
  const now = Math.floor((options.now ?? Date.now)() / 60_000) * 60_000;
  // The simulated data ends at `now`, so the demo clock stays there: a demo left open for hours must
  // not drift into empty windows. Tests may inject their own clock.
  const clock: Clock = { now: options.now ?? (() => now) };
  const store = await openStore({ path: ':memory:', now: () => clock.now() });
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
    environments: ENVIRONMENTS.map(demoSummary),
    store,
    model: new InMemoryEnvironmentModel(results),
    clock,
  };
}
