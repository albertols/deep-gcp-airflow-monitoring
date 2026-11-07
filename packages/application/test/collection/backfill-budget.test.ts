/**
 * The M2 demo step 3 at the first target's scale (spec §22.6 L4733, §7.11 "Budget arithmetic for the first
 * target profile"): about 2,000 DAGs and 20,000 finished task instances a day, on the standard profile. The
 * real Airflow collectors run in the engine on virtual time against an indexed fake of the task instance
 * list, so a week of history takes seconds to simulate. Fictitious `acme_*` data only.
 */
import { describe, expect, it } from 'vitest';
import type {
  AirflowApi,
  AirflowDag,
  AirflowTaskInstance,
  StoredTaskTry,
  TaskInstanceQuery,
  TryKey,
} from '@dcam/ports';
import {
  afBackfillCollector,
  afFactsCollector,
  afInventoryCollector,
  afLiveCollector,
  createCollectionEngine,
  DAY_MS,
  FACTS_SETTLE_MS,
} from '../../src/index';
import { MemoryStore, storeKey, ti } from './collectors-harness';
import { FakeTime, T0, airflowEnv, maxInWindow, workspace } from './engine-harness';

const MIN = 60_000;
const H = 60 * MIN;
const PER_DAY = 20_000;
const DAGS = 2_000;
/** Latency of every Airflow call. */
const LATENCY_MS = 300;

/** 20,000 finished tries a day: two thirds in the eight busy hours of each day, the rest spread out. */
function history(from: number, to: number): Array<AirflowTaskInstance & { updatedAt: number }> {
  const rows: Array<AirflowTaskInstance & { updatedAt: number }> = [];
  let n = 0;
  for (let day = Math.floor(from / DAY_MS) * DAY_MS; day < to; day += DAY_MS) {
    const busy = Math.round((PER_DAY * 2) / 3);
    const times = [
      ...Array.from({ length: busy }, (_, i) => day + Math.floor((8 * H * (i + 0.5)) / busy)),
      ...Array.from(
        { length: PER_DAY - busy },
        (_, i) => day + 8 * H + Math.floor((16 * H * (i + 0.5)) / (PER_DAY - busy)),
      ),
    ];
    for (const at of times) {
      if (at < from || at >= to) continue;
      const dag = `acme_dag_${String(n % DAGS).padStart(4, '0')}`;
      rows.push(
        ti({
          dagId: dag,
          runId: `scheduled__${new Date(day).toISOString()}`,
          taskId: `task_${n}`,
          startAt: at - 5 * MIN,
          endAt: at,
          queuedAt: at - 6 * MIN,
          updatedAt: at,
        }),
      );
      n++;
    }
  }
  return rows.sort((a, b) => a.updatedAt - b.updatedAt);
}

/** The task instance list over sorted rows by binary search; a row exists once its `updated_at` has passed. */
class IndexedAirflow implements AirflowApi {
  readonly calls: Array<{ readonly at: number; readonly method: string }> = [];
  /** Most calls in flight at once. */
  peak = 0;
  private inFlight = 0;
  private readonly dagList: AirflowDag[];
  constructor(
    private readonly time: FakeTime,
    private readonly rows: ReadonlyArray<AirflowTaskInstance & { updatedAt: number }>,
  ) {
    this.dagList = Array.from({ length: DAGS }, (_, i) => ({
      dagId: `acme_dag_${String(i).padStart(4, '0')}`,
      fileloc: `/home/airflow/gcs/dags/acme_dag_${i}.py`,
      owners: ['acme-data'],
      tags: [],
      schedule: '@hourly',
      paused: false,
      active: true,
      maxActiveTasks: 16,
      maxActiveRuns: 1,
    }));
  }
  private async call<T>(method: string, value: () => T): Promise<T> {
    this.calls.push({ at: this.time.now(), method });
    this.peak = Math.max(this.peak, ++this.inFlight);
    try {
      await this.time.sleep(LATENCY_MS);
      return value();
    } finally {
      this.inFlight--;
    }
  }
  private bound(at: number, strict: boolean): number {
    let lo = 0;
    let hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const u = (this.rows[mid] as { updatedAt: number }).updatedAt;
      if (strict ? u <= at : u < at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  version() {
    return this.call('version', () => ({ version: '2.11.1' }));
  }
  health() {
    return this.call('health', () => ({
      metadatabase: 'healthy' as const,
      scheduler: { status: 'healthy' as const, latestHeartbeat: this.time.now() },
    }));
  }
  dags(page: { readonly limit: number; readonly offset: number }) {
    return this.call('dags', () => ({
      items: this.dagList.slice(page.offset, page.offset + page.limit),
      total: DAGS,
    }));
  }
  pools() {
    return this.call('pools', () => [
      {
        name: 'default_pool',
        slots: 128,
        runningSlots: 0,
        queuedSlots: 0,
        openSlots: 128,
        scheduledSlots: 0,
        deferredSlots: 0,
      },
    ]);
  }
  importErrorCount() {
    return this.call('importErrors', () => 0);
  }
  taskInstances(q: TaskInstanceQuery) {
    return this.call(q.states?.includes('success') ? 'facts' : 'live', () => {
      if (!q.states?.includes('success')) return { items: [], total: 0 };
      const now = this.time.now();
      const lo = this.bound(q.updatedFrom ?? -Infinity, false);
      const hi = this.bound(Math.min(q.updatedTo ?? Infinity, now), true);
      const total = Math.max(0, hi - lo);
      const items = this.rows
        .slice(lo + q.offset, Math.min(hi, lo + q.offset + q.limit))
        .map(({ updatedAt: _u, ...t }) => t);
      return { items, total };
    });
  }
  canReadProviders() {
    return this.call('providers', () => false);
  }
}

/** The collector store's rules are tested elsewhere; at 150,000 rows a plain map keeps the simulation fast. */
class FastStore extends MemoryStore {
  override async upsertTaskTries(rows: readonly StoredTaskTry[]): Promise<void> {
    for (const r of rows) this.tries.set(storeKey(r.envId, r), r);
  }
  override async closeRunningTries(_envId: string, _running: readonly TryKey[], _at: number) {}
}

describe('FR-COLL-04 a week of history at 2,000 DAGs on the standard profile (NFR-OBS-05)', () => {
  it(
    'FR-COLL-04: 7 days at 20,000 tries a day complete within 12 Airflow requests a minute, live work keeps its pace, and the ETA holds',
    { timeout: 180_000 },
    async () => {
      const time = new FakeTime();
      const rows = history(T0 - 7 * DAY_MS - 2 * H, T0 + 30 * H);
      const airflow = new IndexedAirflow(time, rows);
      const store = new FastStore();
      const reduced: string[] = [];
      const env = airflowEnv('acme-emulator', 'standard');
      const engine = createCollectionEngine({
        config: workspace([env]),
        store,
        clock: time,
        sleeper: time,
        random: () => 0.5,
        sources: () => ({ airflow: () => airflow }),
        collectors: [afInventoryCollector(), afLiveCollector(), afFactsCollector(), afBackfillCollector()],
        log: (entry) => {
          if (entry.message.startsWith('Reduced fidelity') && entry.collectorId)
            reduced.push(entry.collectorId);
        },
      });
      engine.start();

      const status = () => engine.status().environments[0]?.backfill?.[0];
      const trace: Array<{ at: number; covered: number | null; eta: number | null; lag: number | null }> = [];
      for (let t = 0; t < 30 * H; t += 10 * MIN) {
        await time.advance(10 * MIN);
        const b = status();
        const watermark = await store.watermark(env.id, 'af.facts');
        trace.push({
          at: time.now(),
          covered: b?.covered_from ? Date.parse(b.covered_from) : null,
          eta: b?.eta_seconds ?? null,
          lag: watermark === null ? null : time.now() - watermark,
        });
        if (b?.state === 'complete') break;
      }
      await time.settle(engine.stop());

      const done = trace.at(-1);
      const final = status();
      expect(final?.state).toBe('complete');
      const elapsedHours = ((done?.at ?? 0) - T0) / H;
      // Measured: about 10 h (16 h with the guaranteed share alone; the spare capacity does the rest).
      expect(elapsedHours).toBeLessThan(12);

      // Every row of the week before af.facts' first window, and everything af.facts read since, once.
      const A = Date.parse(final?.to ?? '');
      const end = (done?.at ?? 0) - FACTS_SETTLE_MS - 2 * MIN;
      const expected = rows.filter((r) => r.updatedAt >= A - 7 * DAY_MS && r.updatedAt <= end).length;
      const stored = [...store.tries.values()].filter((t) => (t.endAt ?? 0) <= end).length;
      expect(stored).toBe(expected);
      expect(final?.days).toBe(7);

      // Never more than the standard budget of 12 a minute, nor 2 in flight (NFR-OBS-01).
      expect(maxInWindow(airflow.calls.map((c) => c.at))).toBeLessThanOrEqual(12);
      expect(airflow.peak).toBeLessThanOrEqual(2);
      // Live and standard collectors never had to slow down for the backfill (FR-COLL-02).
      expect(reduced.filter((id) => id === 'af.live' || id === 'af.facts')).toEqual([]);
      // Live work kept its pace: /pools every 30 s, and af.facts' watermark within a few minutes of now.
      const minutes = ((done?.at ?? 0) - T0) / MIN;
      expect(airflow.calls.filter((c) => c.method === 'pools').length / minutes).toBeGreaterThan(1.9);
      for (const s of trace.slice(1)) expect(s.lag ?? Infinity).toBeLessThan(5 * MIN);

      // The ETA a quarter of the way in is within 30 % of the time it actually took from there.
      const quarter = trace.find(
        (s) => s.covered !== null && s.covered <= A - 1.75 * DAY_MS && s.eta !== null,
      );
      if (!quarter || quarter.eta === null) throw new Error('no ETA a quarter of the way in');
      const actual = ((done?.at ?? 0) - quarter.at) / 1_000;
      expect(quarter.eta).toBeGreaterThan(actual * 0.7);
      expect(quarter.eta).toBeLessThan(actual * 1.3);
      // Measured: 1,777 requests for 140,000 rows (79 a request); ETA at 25 % 7.1 h, actual 7.5 h.
      expect(final?.items_read).toBe(140_000);
      expect(final?.requests_used).toBeLessThan(140_000 / 70);
    },
  );
});
