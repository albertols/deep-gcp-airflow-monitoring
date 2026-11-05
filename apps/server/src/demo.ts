/**
 * Demo workspace (FR-EMU-01): synthetic environments for the fictitious "acme" organisation,
 * loaded into an in-memory store. No credentials and no network access.
 */
import type { Meta } from '@dcam/contracts';
import { openStore, type Store } from '@dcam/duckdb-store';
import { synthesizeTaskTries } from '@dcam/fakes';
import type { Clock } from '@dcam/ports';

export interface Workspace {
  readonly mode: Meta['mode'];
  readonly environments: Meta['environments'];
  readonly store: Store;
  readonly clock: Clock;
}

export async function createDemoWorkspace(options: { now?: () => number; seed?: number } = {}): Promise<Workspace> {
  const clock: Clock = { now: options.now ?? Date.now };
  const store = await openStore({ path: ':memory:', now: clock.now });
  const environments: Meta['environments'] = [
    { env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' },
    { env_id: 'acme-dev', display_name: 'acme-dev', tier: 'dev' },
  ];
  const now = clock.now();
  await store.upsertTaskTries(synthesizeTaskTries({ seed: options.seed ?? 42, now, hours: 24, envId: 'acme-prod', dagCount: 200 }));
  await store.upsertTaskTries(synthesizeTaskTries({ seed: (options.seed ?? 42) + 1, now, hours: 24, envId: 'acme-dev', dagCount: 40 }));
  return { mode: 'demo', environments, store, clock };
}
