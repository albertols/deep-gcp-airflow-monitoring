import { describe, expect, it } from 'vitest';
import type { Collection } from '@dcam/contracts';
import type {
  EnvironmentEntry,
  RetainedFamily,
  RetentionHorizon,
  RetentionStore,
  StorageUsage,
  ThinOptions,
  ThinResult,
  WorkspaceConfig,
} from '@dcam/ports';
import {
  BUDGET_CHECK_EVERY_MS,
  MAINTENANCE_BATCH_ROWS,
  RETENTION_EVERY_MS,
  createMaintenanceJob,
  effectiveRetention,
  withMaintenance,
} from '../src/index';
import { FakeTime, T0 } from './collection/engine-harness';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Bytes a row of each family adds to the fake store (snapshots are the bulk, as in DuckDB). */
const ROW_BYTES: Readonly<Record<RetainedFamily, number>> = {
  'task-tries': 100,
  'ready-times': 10,
  snapshots: 1_000,
  'worker-samples': 10,
};

interface Row {
  readonly at: number;
  readonly open?: boolean;
  readonly spanMs?: number;
}

/**
 * An in-memory {@link RetentionStore}. Like DuckDB, the space deletes free counts only after a CHECKPOINT;
 * thinning keeps the first snapshot of each bucket. `failAt` makes the n-th deleteExpired call throw.
 */
class FakeRetentionStore implements RetentionStore {
  readonly rows = new Map<string, Row[]>();
  readonly calls: string[] = [];
  readonly horizons = new Map<string, { deletedBefore: number | null; thinnedBefore: number | null }>();
  failAt: number | null = null;
  private deletes = 0;
  private measured: number | null = null;

  add(envId: string, family: RetainedFamily, rows: readonly Row[]): this {
    const key = `${envId}|${family}`;
    this.rows.set(
      key,
      [...(this.rows.get(key) ?? []), ...rows].sort((a, b) => a.at - b.at),
    );
    return this;
  }

  times(envId: string, family: RetainedFamily): number[] {
    return (this.rows.get(`${envId}|${family}`) ?? []).map((r) => r.at);
  }

  bytes(): number {
    let total = 0;
    for (const [key, rows] of this.rows)
      total += rows.length * ROW_BYTES[key.split('|')[1] as RetainedFamily];
    return total;
  }

  async retainedEnvironments(): Promise<string[]> {
    const envs = new Set<string>();
    for (const [key, rows] of this.rows) if (rows.length > 0) envs.add(key.split('|')[0] as string);
    return [...envs].sort();
  }

  async oldest(envId: string, family: RetainedFamily): Promise<number | null> {
    const row = (this.rows.get(`${envId}|${family}`) ?? []).find((r) => !r.open);
    return row?.at ?? null;
  }

  async deleteExpired(envId: string, family: RetainedFamily, before: number, limit: number): Promise<number> {
    this.calls.push(`delete ${envId} ${family} ${before}`);
    if (this.failAt !== null && ++this.deletes === this.failAt) throw new Error('disk I/O error');
    const key = `${envId}|${family}`;
    const h = this.horizons.get(key) ?? { deletedBefore: null, thinnedBefore: null };
    this.horizons.set(key, { ...h, deletedBefore: Math.max(h.deletedBefore ?? before, before) });
    const rows = this.rows.get(key) ?? [];
    const expired = rows.filter((r) => r.at < before && !r.open).slice(0, limit);
    this.rows.set(
      key,
      rows.filter((r) => !expired.includes(r)),
    );
    return expired.length;
  }

  async thinSnapshots(envId: string, options: ThinOptions): Promise<ThinResult> {
    this.calls.push(`thin ${envId} ${options.before}`);
    const key = `${envId}|snapshots`;
    const end = Math.floor(options.before / options.bucketMs) * options.bucketMs;
    const kept = new Map<number, Row>();
    const rows = this.rows.get(key) ?? [];
    let dropped = 0;
    const next: Row[] = [];
    for (const r of rows) {
      if (r.at >= end) next.push(r);
      else {
        const bucket = Math.floor(r.at / options.bucketMs);
        if (kept.has(bucket)) dropped++;
        else {
          const k = { at: r.at, spanMs: options.bucketMs };
          kept.set(bucket, k);
          next.push(k);
        }
      }
    }
    this.rows.set(key, next);
    const h = this.horizons.get(key) ?? { deletedBefore: null, thinnedBefore: null };
    this.horizons.set(key, { ...h, thinnedBefore: end });
    return { dropped, done: true };
  }

  async horizon(envId: string, family: RetainedFamily): Promise<RetentionHorizon> {
    return this.horizons.get(`${envId}|${family}`) ?? { deletedBefore: null, thinnedBefore: null };
  }

  async checkpoint(): Promise<void> {
    this.calls.push('checkpoint');
    this.measured = this.bytes();
  }

  async storageUsage(): Promise<StorageUsage> {
    this.measured ??= this.bytes();
    return { fileBytes: this.measured + 1_000, usedBytes: this.measured };
  }
}

const env = (id: string, retention?: EnvironmentEntry['retention']): EnvironmentEntry => ({
  id,
  displayName: id,
  tier: 'prod',
  profile: 'standard',
  source: { kind: 'composer', projectId: 'acme-data-prod', location: 'europe-west1', environment: id },
  ...(retention === undefined ? {} : { retention }),
});

const config = (
  over: Partial<NonNullable<WorkspaceConfig['retention']>> = {},
  environments = [env('acme-prod'), env('acme-dev', { rawMetricPointsDays: 7 })],
): Pick<WorkspaceConfig, 'retention' | 'environments'> => ({
  retention: {
    rawTaskInstancesDays: 90,
    rawMetricPointsDays: 14,
    rollup5mDays: 90,
    rollup1hDays: 400,
    logSignaturesDays: 30,
    findingsDays: 400,
    diskBudgetGb: 5,
    ...over,
  },
  environments,
});

/** One row a day for `days` days before T0, at noon. */
const daily = (days: number) => Array.from({ length: days }, (_, i) => ({ at: T0 - (days - i) * DAY }));

function setup(store = new FakeRetentionStore(), cfg = config()) {
  const time = new FakeTime();
  const job = createMaintenanceJob({ store, clock: time, sleeper: time, config: cfg });
  return { store, time, job };
}

describe('FR-STORE-02 retention: the maintenance job', () => {
  it('FR-STORE-02: the defaults apply where neither the workspace nor the environment sets a class', () => {
    expect(effectiveRetention({ environments: [env('acme-prod')] }, 'acme-prod')).toMatchObject({
      rawTaskInstancesDays: 90,
      rawMetricPointsDays: 14,
    });
    expect(effectiveRetention(config(), 'acme-dev')).toMatchObject({
      rawTaskInstancesDays: 90,
      rawMetricPointsDays: 7,
    });
    // An environment no longer configured keeps the workspace's retention until its data expires.
    expect(effectiveRetention(config({ rawTaskInstancesDays: 30 }), 'acme-gone').rawTaskInstancesDays).toBe(
      30,
    );
  });

  it('FR-STORE-02: deletes each family by its class, per environment (also unconfigured ones), then checkpoints', async () => {
    const store = new FakeRetentionStore()
      .add('acme-prod', 'task-tries', [...daily(100), { at: T0 - 200 * DAY, open: true }])
      .add('acme-prod', 'snapshots', daily(20))
      .add('acme-prod', 'worker-samples', daily(20))
      .add('acme-prod', 'ready-times', daily(20))
      .add('acme-dev', 'snapshots', daily(20))
      .add('acme-gone', 'task-tries', daily(100));
    const { job } = setup(store);
    await job.run('retention');

    // Kept: what ended at or after the cut-off; the open try stays whatever its age.
    expect(store.times('acme-prod', 'task-tries')).toEqual([T0 - 200 * DAY, ...daily(90).map((r) => r.at)]);
    expect(store.times('acme-prod', 'snapshots')).toEqual(daily(14).map((r) => r.at));
    expect(store.times('acme-prod', 'worker-samples')).toEqual(daily(14).map((r) => r.at));
    expect(store.times('acme-prod', 'ready-times')).toEqual(daily(14).map((r) => r.at));
    expect(store.times('acme-dev', 'snapshots')).toEqual(daily(7).map((r) => r.at));
    expect(store.times('acme-gone', 'task-tries')).toEqual(daily(90).map((r) => r.at));
    expect(store.calls.at(-1)).toBe('checkpoint');
    expect(store.calls.filter((c) => c === 'checkpoint')).toHaveLength(1);
    const status = job.status();
    expect(status.last_run).toMatchObject({ kind: 'retention', error: null, thinned_snapshots: 0 });
    expect(status.last_run?.deleted_rows).toBe(10 + 6 * 3 + 13 + 10);
    expect(status.last_run?.finished_at).toBe(new Date(T0).toISOString());
  });

  it(`FR-STORE-02: deletes in batches of at most ${MAINTENANCE_BATCH_ROWS} rows, one store call (one transaction) each`, async () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => ({ at: T0 - 100 * DAY + i }));
    const store = new FakeRetentionStore().add('acme-prod', 'task-tries', rows);
    const { job } = setup(store);
    await job.run('retention');
    const deletes = store.calls.filter((c) => c.startsWith('delete acme-prod task-tries'));
    expect(MAINTENANCE_BATCH_ROWS).toBe(5_000);
    expect(deletes).toHaveLength(3);
    expect(store.times('acme-prod', 'task-tries')).toEqual([]);
  });

  it('FR-STORE-02: runs on start and every 24 h, and checks the disk budget every hour in between', async () => {
    const store = new FakeRetentionStore().add('acme-prod', 'snapshots', daily(20));
    const { job, time } = setup(store);
    expect(RETENTION_EVERY_MS).toBe(DAY);
    expect(BUDGET_CHECK_EVERY_MS).toBe(HOUR);
    job.start();
    await time.advance(0);
    expect(job.status().last_run?.kind).toBe('retention');
    expect(job.status().next_run_at).toBe(new Date(T0 + HOUR).toISOString());
    expect(store.times('acme-prod', 'snapshots')).toHaveLength(14);

    await time.advance(HOUR);
    expect(job.status().last_run).toMatchObject({
      kind: 'budget-check',
      started_at: new Date(T0 + HOUR).toISOString(),
    });
    // A budget check under the budget deletes nothing by age.
    expect(store.times('acme-prod', 'snapshots')).toHaveLength(14);

    await time.advance(23 * HOUR);
    expect(job.status().last_run).toMatchObject({
      kind: 'retention',
      started_at: new Date(T0 + DAY).toISOString(),
    });
    expect(store.times('acme-prod', 'snapshots')).toHaveLength(13);
    await job.stop();
    expect(time.pending).toBe(0);
  });

  it('FR-STORE-06: never runs twice at once: a second request joins the run in progress', async () => {
    const store = new FakeRetentionStore().add('acme-prod', 'snapshots', daily(20));
    const { job } = setup(store);
    const [a, b] = [job.run('retention'), job.run('budget-check')];
    expect(b).toBe(a);
    await Promise.all([a, b]);
    expect(store.calls.filter((c) => c === 'checkpoint')).toHaveLength(1);
  });

  it('FR-STORE-06: a run cut short by an error is completed by the next, with the result of one clean run', async () => {
    const seed = () =>
      new FakeRetentionStore()
        .add('acme-prod', 'task-tries', daily(100))
        .add('acme-prod', 'snapshots', daily(20))
        .add('acme-dev', 'snapshots', daily(20));
    const clean = setup(seed());
    await clean.job.run('retention');

    const broken = seed();
    broken.failAt = 3;
    const { job } = setup(broken);
    await job.run('retention');
    expect(job.status().last_run?.error).toMatch(/disk I\/O error/);
    expect(broken.rows).not.toEqual(clean.store.rows);
    await job.run('retention');
    expect(job.status().last_run?.error).toBeNull();
    expect(broken.rows).toEqual(clean.store.rows);
  });

  it('FR-STORE-02: stop() lets the running batch finish and starts no other', async () => {
    const store = new FakeRetentionStore().add(
      'acme-prod',
      'task-tries',
      Array.from({ length: 20_000 }, (_, i) => ({ at: T0 - 100 * DAY + i })),
    );
    const { job, time } = setup(store);
    job.start();
    const stopped = job.stop();
    await time.settle(stopped);
    // At most the batch in flight when stop() was called ran.
    expect(store.calls.filter((c) => c.startsWith('delete')).length).toBeLessThanOrEqual(1);
    expect(time.pending).toBe(0);
  });
});

describe('FR-STORE-07 disk budget', () => {
  /** A store of `snapshotDays` days of snapshots every 30 s plus `tryDays` days of tries, about 3 MB a day. */
  function heavy(snapshotDays: number, tryDays: number) {
    const store = new FakeRetentionStore();
    const snapshots = Array.from({ length: snapshotDays * 2_880 }, (_, i) => ({
      at: T0 - snapshotDays * DAY + i * 30_000,
    }));
    store.add('acme-prod', 'snapshots', snapshots);
    store.add(
      'acme-prod',
      'task-tries',
      Array.from({ length: tryDays * 100 }, (_, i) => ({ at: T0 - tryDays * DAY + i * 864_000 })),
    );
    return store;
  }

  it('FR-STORE-07: below 90 % of the budget it neither thins nor deletes by age, and says ok', async () => {
    const store = heavy(10, 10);
    // 28.9 MB used against 1 GB.
    const { job } = setup(store, config({ diskBudgetGb: 1 }));
    await job.run('budget-check');
    expect(store.calls.some((c) => c.startsWith('thin') || c.startsWith('delete'))).toBe(false);
    expect(job.status()).toMatchObject({
      state: 'ok',
      budget_bytes: 1e9,
      warn_share: 0.9,
      budget_action: null,
    });
  });

  it('FR-STORE-07: at 90 % it warns and thins snapshots older than 24 h before it deletes anything by age', async () => {
    const store = heavy(10, 10);
    const used = store.bytes();
    // A budget just under the usage ÷ 0.9: thinning alone brings it below 90 %.
    const { job } = setup(store, config({ diskBudgetGb: (used / 0.9 - 1) / 1e9 }));
    await job.run('budget-check');
    expect(store.calls.filter((c) => c.startsWith('thin'))).toEqual([`thin acme-prod ${T0 - DAY}`]);
    expect(store.calls.some((c) => c.startsWith('delete'))).toBe(false);
    // The last 24 h keep every snapshot; older ones are one per 5 minutes.
    expect(store.times('acme-prod', 'snapshots').filter((t) => t >= T0 - DAY)).toHaveLength(2_880);
    expect(store.times('acme-prod', 'snapshots').filter((t) => t < T0 - DAY)).toHaveLength(9 * 288);
    const status = job.status();
    expect(status.state).toBe('ok');
    expect(status.budget_action).toEqual({
      at: new Date(T0).toISOString(),
      thinned_before: new Date(T0 - DAY).toISOString(),
      deleted_before: null,
      floor_reached: false,
    });
    expect(status.last_run?.thinned_snapshots).toBe(9 * (2_880 - 288));
  });

  it('FR-STORE-07: when thinning is not enough it deletes whole days of snapshots, oldest first, before any task try', async () => {
    const store = heavy(10, 30);
    // After thinning: 2,880 + 9 × 288 snapshots (5.47 MB) and 3,000 tries (0.3 MB); 5.2 MB is the 90 % mark.
    const { job } = setup(store, config({ diskBudgetGb: 5.2e6 / 0.9 / 1e9 }));
    await job.run('budget-check');
    const deletes = store.calls.filter((c) => c.startsWith('delete'));
    expect(deletes.every((c) => c.includes(' snapshots '))).toBe(true);
    const horizons = [...new Set(deletes.map((c) => Number(c.split(' ').at(-1))))];
    // One day at a time from the oldest snapshot (10 days old), never moving back, never past the 8-day floor.
    expect(horizons).toEqual([...horizons].sort((a, b) => a - b));
    expect(horizons[0]).toBe(Math.floor((T0 - 10 * DAY) / DAY) * DAY + DAY);
    expect(horizons.at(-1)).toBe(T0 - 8 * DAY);
    expect(store.bytes()).toBeLessThan(5.2e6);
    // The league's 30 days of tries are untouched.
    expect(store.times('acme-prod', 'task-tries')).toHaveLength(3_000);
    const action = job.status().budget_action;
    expect(action?.floor_reached).toBe(false);
    expect(action?.deleted_before).toBe(new Date(T0 - 8 * DAY).toISOString());
  });

  it('FR-STORE-07: once snapshots reach the floor it deletes task tries, oldest day first, until below 90 %', async () => {
    const store = heavy(10, 30);
    // Deleting every snapshot older than 8 days leaves 5.196 MB: tries must go too to get below 5.0 MB.
    const { job } = setup(store, config({ diskBudgetGb: 5.0e6 / 0.9 / 1e9 }));
    await job.run('budget-check');
    const deletes = store.calls.filter((c) => c.startsWith('delete'));
    const lastSnapshot = deletes.findLastIndex((c) => c.includes(' snapshots '));
    const firstTry = deletes.findIndex((c) => c.includes(' task-tries '));
    expect(firstTry).toBeGreaterThan(lastSnapshot);
    const tryHorizons = [
      ...new Set(deletes.filter((c) => c.includes(' task-tries ')).map((c) => Number(c.split(' ').at(-1)))),
    ];
    expect(tryHorizons[0]).toBe(Math.floor((T0 - 30 * DAY) / DAY) * DAY + DAY);
    expect(tryHorizons).toEqual([...tryHorizons].sort((a, b) => a - b));
    expect(store.bytes()).toBeLessThan(5.0e6);
    // It stopped at the first day of tries that brought usage below 90 %, before the 8-day floor.
    expect(Math.min(...store.times('acme-prod', 'task-tries'))).toBeLessThan(T0 - 8 * DAY);
    expect(job.status().budget_action?.floor_reached).toBe(false);
  });

  it('FR-STORE-07: never deletes the last 8 days for the budget, and says the floor is reached', async () => {
    const store = heavy(10, 30);
    const { job } = setup(store, config({ diskBudgetGb: 1e-3 }));
    await job.run('budget-check');
    expect(Math.min(...store.times('acme-prod', 'snapshots'))).toBeGreaterThanOrEqual(T0 - 8 * DAY);
    expect(Math.min(...store.times('acme-prod', 'task-tries'))).toBeGreaterThanOrEqual(T0 - 8 * DAY);
    const status = job.status();
    expect(status.state).toBe('warning');
    expect(status.budget_action).toMatchObject({
      floor_reached: true,
      deleted_before: new Date(T0 - 8 * DAY).toISOString(),
    });
  });

  it('FR-STORE-07: the collection status carries the store and each environment its retention', async () => {
    const store = heavy(1, 1);
    const { job } = setup(store);
    expect(job.status()).toMatchObject({ state: 'unknown', measured_at: null, last_run: null });
    await job.run('retention');
    const collection: Collection = {
      mode: 'live',
      generated_at: new Date(T0).toISOString(),
      environments: [
        {
          env_id: 'acme-dev',
          profile: 'standard',
          reduced_fidelity: false,
          failing: false,
          collectors: [],
          footprint: [],
          series_24h: null,
        },
      ],
    };
    const merged = withMaintenance(collection, job);
    expect(merged.storage).toMatchObject({
      state: 'ok',
      measured_at: new Date(T0).toISOString(),
      used_bytes: store.bytes(),
      file_bytes: store.bytes() + 1_000,
      budget_bytes: 5e9,
    });
    expect(merged.environments[0]?.retention).toEqual({
      raw_task_instances_days: 90,
      raw_metric_points_days: 7,
    });
  });
});
