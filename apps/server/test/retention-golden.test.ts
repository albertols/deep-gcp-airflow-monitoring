/**
 * Golden tests of store retention and the disk budget (FR-STORE-02, FR-STORE-06, FR-STORE-07): 16 simulated
 * hours of the fictitious acme-prod environment in a real DuckDB store, read through the same use cases as
 * the pages. Retention cut-offs are hours here, not days, so that they fall inside the simulated history.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SNAPSHOT_CADENCE_MS,
  createMaintenanceJob,
  getBottlenecks,
  getDagLeague,
} from '@dcam/application';
import type { Bottlenecks, Range, SourceId } from '@dcam/contracts';
import { openStore, type DuckDbStore } from '@dcam/duckdb-store';
import { acmeScenario, simulateEnvironment, type SimulationResult } from '@dcam/fakes';
import type { RetentionStore, Sleeper, StoredTaskTry, WorkspaceConfig } from '@dcam/ports';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOUR = 3_600_000;
const ENV = 'acme-prod';
const EVER = Number.MAX_SAFE_INTEGER;
const SOURCES: readonly SourceId[] = ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'];
const THIN = { bucketMs: 5 * 60_000, fallbackCadenceMs: DEFAULT_SNAPSHOT_CADENCE_MS };
/** The job is only run here, never started, so it never sleeps. */
const idle: Sleeper = { sleep: async () => undefined };

let sim: SimulationResult;
beforeAll(() => {
  sim = simulateEnvironment({ seed: 42, now: NOW, hours: 16, scenario: acmeScenario(ENV) });
}, 60_000);

async function load(): Promise<DuckDbStore> {
  const store = await openStore({ path: ':memory:', now: () => NOW });
  await store.saveConfig(ENV, sim.config);
  await store.replaceDags(ENV, sim.dags);
  await store.upsertTaskTries(sim.tries);
  await store.saveSnapshots(ENV, sim.snapshots);
  await store.saveWorkerSamples(ENV, sim.workerSamples);
  return store;
}

const deps = (store: DuckDbStore) => ({ store, model: store, clock: { now: () => NOW } });
const league = (store: DuckDbStore, range: Range) =>
  getDagLeague(deps(store), { envId: ENV, range, sources: SOURCES });
const bottlenecks = (store: DuckDbStore, range: Range) =>
  getBottlenecks(deps(store), { envId: ENV, range, sources: SOURCES });

/** Retention of `taskHours` for tries and `metricHours` for snapshots, samples and ready times. */
const retention = (
  taskHours: number,
  metricHours: number,
): Pick<WorkspaceConfig, 'retention' | 'environments'> => ({
  retention: {
    rawTaskInstancesDays: taskHours / 24,
    rawMetricPointsDays: metricHours / 24,
    rollup5mDays: 90,
    rollup1hDays: 400,
    logSignaturesDays: 30,
    findingsDays: 400,
    diskBudgetGb: 5,
  },
  environments: [],
});

const tryKey = (t: StoredTaskTry) => `${t.dagId}|${t.runId}|${t.taskId}|${t.mapIndex}|${t.tryNumber}`;
const sorted = (tries: readonly StoredTaskTry[]) =>
  [...tries].sort((a, b) => (tryKey(a) < tryKey(b) ? -1 : 1));
const iso = (ms: number) => new Date(ms).toISOString();

// Real DuckDB with 16 h of history on a shared runner: realistic timeouts.
describe(
  'FR-STORE-02 / FR-STORE-07 retention golden tests (simulated acme-prod)',
  { timeout: 120_000 },
  () => {
    it('FR-STORE-02: retention deletes exactly the expired rows and leaves the league and bottlenecks of the retained period unchanged', async () => {
      const store = await load();
      const tries = await store.taskTries(ENV, 0, EVER);
      const snapshots = await store.snapshots(ENV, 0, EVER);
      const samples = await store.workerSamples(ENV, 0, EVER);
      expect(await store.countTaskTries(ENV)).toBe(sim.tries.length);
      const before = {
        league1h: await league(store, '1h'),
        league6h: await league(store, '6h'),
        bottlenecks1h: await bottlenecks(store, '1h'),
        bottlenecks6h: await bottlenecks(store, '6h'),
      };

      // Tries are kept 13 h: the 6 h league compares with the 6 h before it. Snapshots and samples 7 h.
      const job = createMaintenanceJob({
        store,
        clock: { now: () => NOW },
        sleeper: idle,
        config: retention(13, 7),
      });
      await job.run('retention');
      expect(job.status().last_run).toMatchObject({ kind: 'retention', error: null });

      const tryCut = NOW - 13 * HOUR;
      const metricCut = NOW - 7 * HOUR;
      const expired = (t: StoredTaskTry) =>
        !(t.startAt !== null && t.endAt === null) && (t.endAt ?? t.queuedAt ?? t.readyAt ?? NOW) < tryCut;
      expect(sorted(await store.taskTries(ENV, 0, EVER))).toEqual(sorted(tries.filter((t) => !expired(t))));
      expect(await store.countTaskTries(ENV)).toBe(sim.tries.filter((t) => !expired(t)).length);
      expect(tries.some(expired)).toBe(true);
      expect(await store.snapshots(ENV, 0, EVER)).toEqual(snapshots.filter((s) => s.at >= metricCut));
      expect(await store.workerSamples(ENV, 0, EVER)).toEqual(samples.filter((s) => s.at >= metricCut));

      expect(await league(store, '1h')).toEqual(before.league1h);
      expect(await league(store, '6h')).toEqual(before.league6h);
      expect(await bottlenecks(store, '1h')).toEqual(before.bottlenecks1h);
      expect(await bottlenecks(store, '6h')).toEqual(before.bottlenecks6h);
      // A range that reaches past the cut-off says from when its snapshots are gone.
      expect((await bottlenecks(store, '24h')).snapshot_retention).toEqual({
        deleted_before: iso(metricCut),
        thinned_before: null,
      });
      store.close();
    });

    it('FR-STORE-07: thinning to one snapshot per 5 minutes keeps slot-seconds exact and waiting task-time within its tolerance', async () => {
      const store = await load();
      const before = new Map<Range, Bottlenecks>();
      for (const range of ['6h', '24h'] as const) before.set(range, await bottlenecks(store, range));
      const league24h = await league(store, '24h');

      // The job thins only what is older than 24 h; here all but the last 15 min, so thinned snapshots fill
      // every range while the latest ones, which tell the league which runs still wait, stay raw.
      const thinnedBefore = NOW - 15 * 60_000;
      for (;;) if ((await store.thinSnapshots(ENV, { ...THIN, before: thinnedBefore })).done) break;
      expect(await store.snapshots(ENV, 0, EVER)).toHaveLength(15.75 * 12 + 30);

      // Task tries are untouched: slot-seconds (HM-003) and the whole league are exactly the same.
      expect(await league(store, '24h')).toEqual(league24h);
      // Stated tolerance of platform waiting (domain retention.ts): 5 % over 16 h of thinned snapshots, 10 % over
      // 6 h; the reasons behind at least a quarter of the waiting, 10 %. Normal latency, short by definition,
      // is not held to it.
      const tolerance: Readonly<Record<'6h' | '24h', number>> = { '6h': 0.1, '24h': 0.05 };
      for (const range of ['6h', '24h'] as const) {
        const raw = before.get(range) as Bottlenecks;
        const thinned = await bottlenecks(store, range);
        const relative = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1);
        expect(raw.waiting_task_seconds).toBeGreaterThan(0);
        expect(relative(thinned.waiting_task_seconds, raw.waiting_task_seconds), range).toBeLessThanOrEqual(
          tolerance[range],
        );
        expect(thinned.answer.reason, range).toBe(raw.answer.reason);
        for (const reason of raw.reasons.filter((r) => r.share >= 0.25)) {
          const after = thinned.reasons.find((r) => r.id === reason.id)?.waiting_task_seconds ?? 0;
          expect(relative(after, reason.waiting_task_seconds), `${range} ${reason.id}`).toBeLessThanOrEqual(
            0.1,
          );
        }
        expect(thinned.snapshot_retention).toEqual({
          deleted_before: null,
          thinned_before: iso(thinnedBefore),
        });
      }
      store.close();
    });

    it('FR-STORE-06: a maintenance run cut short is completed by the next run, with the rows of one clean run', async () => {
      const clean = await load();
      await createMaintenanceJob({
        store: clean,
        clock: { now: () => NOW },
        sleeper: idle,
        config: retention(13, 7),
      }).run('retention');

      const store = await load();
      // The second delete batch fails, as if the process died there: the first one stays committed.
      let calls = 0;
      const failing: RetentionStore = {
        retainedEnvironments: () => store.retainedEnvironments(),
        oldest: (envId, family) => store.oldest(envId, family),
        deleteExpired: (envId, family, before, limit) =>
          ++calls === 2
            ? Promise.reject(new Error('disk I/O error'))
            : store.deleteExpired(envId, family, before, limit),
        thinSnapshots: (envId, options) => store.thinSnapshots(envId, options),
        horizon: (envId, family) => store.horizon(envId, family),
        checkpoint: () => store.checkpoint(),
        storageUsage: () => store.storageUsage(),
      };
      const cutShort = createMaintenanceJob({
        store: failing,
        clock: { now: () => NOW },
        sleeper: idle,
        config: retention(13, 7),
      });
      await cutShort.run('retention');
      expect(cutShort.status().last_run?.error).toMatch(/disk I\/O error/);
      expect(await store.snapshots(ENV, 0, EVER)).not.toEqual(await clean.snapshots(ENV, 0, EVER));

      // DCAM restarts: a new job on the same store finishes the work.
      const resumed = createMaintenanceJob({
        store,
        clock: { now: () => NOW },
        sleeper: idle,
        config: retention(13, 7),
      });
      await resumed.run('retention');
      expect(resumed.status().last_run?.error).toBeNull();
      expect(sorted(await store.taskTries(ENV, 0, EVER))).toEqual(
        sorted(await clean.taskTries(ENV, 0, EVER)),
      );
      expect(await store.snapshots(ENV, 0, EVER)).toEqual(await clean.snapshots(ENV, 0, EVER));
      expect(await store.workerSamples(ENV, 0, EVER)).toEqual(await clean.workerSamples(ENV, 0, EVER));
      expect(await store.snapshotHorizon(ENV)).toEqual(await clean.snapshotHorizon(ENV));
      clean.close();
      store.close();
    });
  },
);
