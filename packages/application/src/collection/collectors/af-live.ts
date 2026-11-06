/**
 * `af.live` (live): `GET /pools` plus the non-terminal task instances (`scheduled`, `queued`, `running`
 * on `GET /dags/~/dagRuns/~/taskInstances`, `~` being the wildcard for every DAG and run) → one
 * {@link LiveSnapshot} per cycle, the HM-006 classifier's input.
 *
 * - Budget (spec §7.11 arithmetic: `/pools` and one task instance page per live cycle): one request
 *   for all three states, 100 rows per page (Appendix B.1), at most {@link MAX_REQUESTS} requests. When
 *   the rows do not fit, the snapshot is a sample: it says so (reduced fidelity, FR-COLL-06), and the
 *   executor counts come from the newest Cloud Monitoring sample (spec L870: "the cheap `/pools`
 *   aggregates plus Cloud Monitoring executor metrics keep the live view accurate").
 * - Ready times: Airflow 2.11 records no "scheduled" timestamp, so a scheduled try's `since` is when
 *   DCAM first saw it scheduled, carried from the previous snapshot, and recorded with `recordReady`
 *   so that stored tries get it as `readyAt` (HM-001, HM-006). A queued try's `since` is `queued_dttm`.
 * - Running tries are upserted as running, seen running at the snapshot time, so the pages see their slot
 *   time before af.facts stores the finished row under the same key (1–2 minutes later on the `live` and
 *   `standard` profiles, more on `eco`). Until then a finished try would count as running until now, so a
 *   snapshot that read every row ends each stored running try it no longer lists when DCAM last saw it
 *   running, marked estimated (`closeRunningTries`): the earliest its end can be, so peak concurrency never
 *   exceeds what the snapshots saw. A sample ends nothing: a try it did not read may still be running. The
 *   store also ends an open try once a later try of its task instance exists (HM-003).
 * - Workers: the newest worker sample from `mon.core` when fresh; otherwise, for a self-managed Airflow,
 *   the configured workers; otherwise the larger of `min_count` and the distinct worker hosts of
 *   running tries (a lower bound), with the target equal to it (no autoscaling evidence).
 * - Configuration: pools exist only in Airflow, so this collector keeps the stored configuration's
 *   pools current; for a self-managed Airflow it writes the whole configuration from `limits`.
 *
 * @implements FR-COLL-01, FR-COLL-06, FR-EMU-02, HM-001, HM-003, HM-006, HM-011
 */
import type { LiveSnapshot, PoolConfig, SnapshotTaskInstance, WorkerSample } from '@dcam/domain';
import type { AirflowPool, AirflowTaskInstance } from '@dcam/ports';
import { BudgetExhaustedError, type Collector, type CollectorContext } from '../types';
import { assertSupported, configFromLimits, keyString, priorityOf, storedTryOf, tryKeyOf } from './mapping';

const STATES = ['scheduled', 'queued', 'running'] as const;
const PAGE_SIZE = 100;
/** `/pools` and four task instance pages (400 non-terminal task instances). */
const MAX_REQUESTS = 5;
/** A previous snapshot older than this does not carry first-seen times across the gap. */
const CARRY_SINCE_MS = 5 * 60_000;
/** A worker sample is fresh enough for the live view within this age (ingestion delay plus cadence). */
const FRESH_SAMPLE_MS = 10 * 60_000;

interface Rows {
  readonly byKey: Map<string, AirflowTaskInstance>;
  total: number;
  complete: boolean;
}

async function readRows(ctx: CollectorContext, budget: number): Promise<Rows & { stopped: string | null }> {
  const airflow = ctx.airflow();
  const rows: Rows = { byKey: new Map(), total: 0, complete: false };
  let stopped: string | null = null;
  for (let offset = 0, used = 0; ; offset += PAGE_SIZE) {
    if (used >= budget) {
      stopped = `The live view read ${rows.byKey.size} of ${rows.total} waiting and running task instances within the request budget; it is a sample.`;
      break;
    }
    try {
      used++;
      const page = await airflow.taskInstances({ states: STATES, limit: PAGE_SIZE, offset });
      rows.total = page.total;
      for (const t of page.items) rows.byKey.set(keyString(t), t);
      if (page.items.length < PAGE_SIZE || offset + PAGE_SIZE >= page.total) {
        // Offset paging over a changing set can skip rows: complete only if every row was seen.
        rows.complete = rows.byKey.size >= page.total;
        if (!rows.complete)
          stopped = `The live view saw ${rows.byKey.size} of ${page.total} task instances while they changed; it is a sample.`;
        break;
      }
    } catch (e) {
      if (!(e instanceof BudgetExhaustedError) || used === 1) throw e;
      stopped = `The Airflow request budget ran out after ${rows.byKey.size} of ${rows.total} task instances; the live view is a sample.`;
      break;
    }
  }
  return { ...rows, stopped };
}

const poolsOf = (pools: readonly AirflowPool[]): PoolConfig[] =>
  pools.map((p) => ({ name: p.name, slots: p.slots }));

async function syncConfig(ctx: CollectorContext, pools: readonly AirflowPool[]): Promise<void> {
  const stored = await ctx.store.config(ctx.env.id);
  const env = ctx.env;
  const next =
    env.source.kind === 'airflow'
      ? configFromLimits({ ...env, source: env.source }, poolsOf(pools), ctx.shared.airflowVersion)
      : stored && { ...stored, pools: poolsOf(pools) };
  if (next && JSON.stringify(next) !== JSON.stringify(stored)) await ctx.store.saveConfig(env.id, next);
}

async function workersFor(
  ctx: CollectorContext,
  running: readonly AirflowTaskInstance[],
  sample: WorkerSample | undefined,
): Promise<LiveSnapshot['workers']> {
  if (sample) return { current: sample.workers, target: sample.target };
  const source = ctx.env.source;
  if (source.kind === 'airflow') return { current: source.limits.workers, target: source.limits.workers };
  const config = await ctx.store.config(ctx.env.id);
  const hosts = new Set(running.map((t) => t.hostname).filter((h): h is string => h !== null && h !== ''));
  const current = Math.max(config?.minWorkers ?? 0, hosts.size);
  return { current, target: current };
}

export function afLiveCollector(): Collector {
  return {
    manifest: {
      id: 'af.live',
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowLive',
      priority: 'live',
      maxRequestsPerCycle: MAX_REQUESTS,
      outputs: ['snapshots', 'tries', 'config'],
      sourceKinds: ['composer', 'airflow'],
    },
    async collect(ctx) {
      assertSupported(ctx);
      const envId = ctx.env.id;
      let pools: readonly AirflowPool[];
      try {
        pools = await ctx.airflow().pools();
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
        ctx.reducedFidelity('The Airflow request budget is used up; no live snapshot this cycle.');
        return { dataAsOf: null };
      }
      let rows;
      try {
        rows = await readRows(ctx, MAX_REQUESTS - 1);
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
        ctx.reducedFidelity('The Airflow request budget is used up; no live snapshot this cycle.');
        return { dataAsOf: null };
      }
      if (rows.stopped !== null) ctx.reducedFidelity(rows.stopped);

      const at = ctx.now();
      const previous = (await ctx.store.snapshots(envId, at - CARRY_SINCE_MS, at)).at(-1);
      const seenSince = new Map(previous?.scheduled.map((p) => [keyString(p), p.since]) ?? []);
      const sample = (await ctx.store.workerSamples(envId, at - FRESH_SAMPLE_MS, at + 1)).at(-1);

      const all = [...rows.byKey.values()];
      const inState = (s: string) => all.filter((t) => t.state === s);
      const scheduled = inState('scheduled');
      const queued = inState('queued');
      const running = inState('running');
      const view = (t: AirflowTaskInstance, since: number): SnapshotTaskInstance => ({
        ...tryKeyOf(t),
        pool: t.pool,
        poolSlots: t.poolSlots,
        priorityWeight: priorityOf(t),
        since,
      });
      const dagActive: Record<string, number> = {};
      for (const t of [...running, ...queued]) dagActive[t.dagId] = (dagActive[t.dagId] ?? 0) + 1;
      const counted = { running: running.length, queued: queued.length };
      const executor =
        rows.complete || !sample
          ? counted
          : {
              running: Math.max(counted.running, sample.running),
              queued: Math.max(counted.queued, sample.queued),
            };

      const snapshot: LiveSnapshot = {
        at,
        scheduled: scheduled.map((t) => view(t, seenSince.get(keyString(t)) ?? at)),
        queued: queued.map((t) => view(t, t.queuedAt ?? at)),
        pools: pools.map((p) => ({
          name: p.name,
          slots: p.slots,
          running: p.runningSlots,
          queued: p.queuedSlots,
          open: p.openSlots,
        })),
        dagActive,
        executor,
        workers: await workersFor(ctx, running, sample),
      };

      await ctx.store.saveSnapshot(envId, snapshot);
      if (scheduled.length > 0) await ctx.store.recordReady(envId, scheduled.map(tryKeyOf), at);
      if (running.length > 0)
        await ctx.store.upsertTaskTries(
          running.map((t) => ({ ...storedTryOf(envId, t), seenRunningAt: at })),
        );
      // Only a snapshot that read every row knows which stored running tries have stopped.
      if (rows.complete) await ctx.store.closeRunningTries(envId, running.map(tryKeyOf), at);
      await syncConfig(ctx, pools);
      return { dataAsOf: at };
    },
  };
}
