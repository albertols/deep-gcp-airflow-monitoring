/**
 * `af.live` (live): `GET /pools` plus the non-terminal task instances (`scheduled`, `queued`, `running`
 * on `GET /dags/~/dagRuns/~/taskInstances`, `~` being the wildcard for every DAG and run) → one
 * {@link LiveSnapshot} per cycle, the HM-006 classifier's input.
 *
 * - Budget: `/pools` and at most two task instance pages a cycle, queued first (spec §7.5 L648), 100 rows
 *   per page (Appendix B.1), each at offset 0 (the list has no defined order, §7.5). While the previous
 *   snapshot was complete, one page of all three states comes first: it usually holds every row, so the
 *   cycle costs `/pools` and one page, as the §7.11 arithmetic assumes ("1 page every 30 s"), and leaves
 *   the rest of the 12 requests a minute to `af.facts` and the background inventory (which only runs
 *   while half the budget is unused, `budget.ts`). If that page does not hold every row, the second page
 *   goes to the queued state. While snapshots are samples, the queued page comes first and the second
 *   holds the scheduled and running task instances, so the running set stays complete when only the
 *   queued state overflows.
 * - Samples (§7.5: "Live snapshots take exact counts from `total_entries`; when a state has more rows
 *   than the page budget allows, the rows read are a sample and are labelled as such"): the snapshot
 *   stores its coverage (rows read, `total_entries`, complete or not) and the cycle reports reduced
 *   fidelity (FR-COLL-06). The queued count comes from the queued page's `total_entries`; the running
 *   count, unless every running try was read, from the newest Cloud Monitoring sample (spec L870: "the
 *   cheap `/pools` aggregates plus Cloud Monitoring executor metrics keep the live view accurate").
 * - Ready times: Airflow 2.11 records no "scheduled" timestamp, so a scheduled try's `since` is when
 *   DCAM first saw it scheduled, carried from the previous snapshot, and recorded with `recordReady`
 *   so that stored tries get it as `readyAt` (HM-001, HM-006). A queued try's `since` is `queued_dttm`.
 * - Running tries are upserted as running, seen running at the snapshot time, so the pages see their slot
 *   time before af.facts stores the finished row under the same key (1–2 minutes later on the `live` and
 *   `standard` profiles, more on `eco`). Until then a finished try would count as running until now, so a
 *   snapshot that read every running try ends each stored running try it no longer lists when DCAM last
 *   saw it running, marked estimated (`closeRunningTries`): the earliest its end can be, so peak
 *   concurrency never exceeds what the snapshots saw. Any other sample ends nothing: a try it did not read
 *   may still be running. The store also ends an open try once a later try of its task instance exists
 *   (HM-003).
 * - Workers: the newest worker sample from `mon.core` when fresh; otherwise, for a self-managed Airflow,
 *   the configured workers; otherwise the larger of `min_count` and the distinct worker hosts of
 *   running tries (a lower bound), with the target equal to it (no autoscaling evidence).
 * - Configuration: pools exist only in Airflow, so this collector keeps the stored configuration's
 *   pools current; for a self-managed Airflow it writes the whole configuration from `limits`.
 *
 * @implements FR-COLL-01, FR-COLL-06, FR-EMU-02, HM-001, HM-003, HM-006, HM-011
 */
import type { LiveSnapshot, PoolConfig, SnapshotTaskInstance, WorkerSample } from '@dcam/domain';
import type { AirflowPool, AirflowTaskInstance, StoredLiveSnapshot } from '@dcam/ports';
import { BudgetExhaustedError, type Collector, type CollectorContext } from '../types';
import { assertSupported, configFromLimits, keyString, priorityOf, storedTryOf, tryKeyOf } from './mapping';

const STATES = ['scheduled', 'queued', 'running'] as const;
const QUEUED = ['queued'] as const;
const NOT_QUEUED = ['scheduled', 'running'] as const;
const PAGE_SIZE = 100;
/** `/pools` and two task instance pages (spec §7.5 L648). */
const MAX_REQUESTS = 3;
/** A previous snapshot older than this does not carry first-seen times across the gap. */
const CARRY_SINCE_MS = 5 * 60_000;
/** A worker sample is fresh enough for the live view within this age (ingestion delay plus cadence). */
const FRESH_SAMPLE_MS = 10 * 60_000;

interface Rows {
  readonly byKey: Map<string, AirflowTaskInstance>;
  /** `total_entries` of the three states; `null` when a page could not be read. */
  readonly total: number | null;
  /** `total_entries` of the queued state, when its own page was read. */
  readonly queuedTotal: number | null;
  /** Every scheduled and running try was read, so the running set is complete. */
  readonly runningComplete: boolean;
  readonly complete: boolean;
  /** Why the snapshot is a sample, or `null`. */
  readonly stopped: string | null;
}

/**
 * The non-terminal task instances within two pages. `busy` (the previous snapshot was a sample) reads the
 * queued page first. A budget refusal of the first page propagates: there is no snapshot without rows.
 */
async function readRows(ctx: CollectorContext, busy: boolean): Promise<Rows> {
  const airflow = ctx.airflow();
  const byKey = new Map<string, AirflowTaskInstance>();
  const read = async (states: readonly string[]) => {
    const page = await airflow.taskInstances({ states, limit: PAGE_SIZE, offset: 0 });
    for (const t of page.items) byKey.set(keyString(t), t);
    return { total: page.total, complete: page.items.length >= page.total };
  };
  /** The second page, or `null` when the budget refuses it. */
  const second = async (states: readonly string[]) => {
    try {
      return await read(states);
    } catch (e) {
      if (!(e instanceof BudgetExhaustedError)) throw e;
      return null;
    }
  };
  const result = (r: Omit<Rows, 'byKey' | 'stopped'>, refused: boolean): Rows => {
    const of = r.total === null ? '' : ` of ${r.total}`;
    const stopped = r.complete
      ? null
      : refused
        ? `The Airflow request budget ran out after ${byKey.size}${of} waiting and running task instances; the live view is a sample.`
        : `The live view read ${byKey.size}${of} waiting and running task instances within its two pages a cycle; it is a sample.`;
    return { ...r, byKey, stopped };
  };

  if (!busy) {
    const all = await read(STATES);
    if (all.complete)
      return result({ total: all.total, queuedTotal: null, runningComplete: true, complete: true }, false);
    const queued = await second(QUEUED);
    return result(
      { total: all.total, queuedTotal: queued?.total ?? null, runningComplete: false, complete: false },
      queued === null,
    );
  }
  const queued = await read(QUEUED);
  const rest = await second(NOT_QUEUED);
  return result(
    {
      total: rest === null ? null : queued.total + rest.total,
      queuedTotal: queued.total,
      runningComplete: rest?.complete ?? false,
      complete: queued.complete && (rest?.complete ?? false),
    },
    rest === null,
  );
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
  /** Environments whose previous snapshot was a sample: their next cycle reads the queued page first. */
  const sampled = new Set<string>();
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
        rows = await readRows(ctx, sampled.has(envId));
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
        ctx.reducedFidelity('The Airflow request budget is used up; no live snapshot this cycle.');
        return { dataAsOf: null };
      }
      if (rows.complete) sampled.delete(envId);
      else sampled.add(envId);
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
      /** Of a sample, the count read is a lower bound: the newest Monitoring sample may know more. */
      const atLeast = (read: number, monitored: number | undefined) => Math.max(read, monitored ?? 0);
      const executor = {
        running: rows.runningComplete ? running.length : atLeast(running.length, sample?.running),
        queued: rows.complete ? queued.length : (rows.queuedTotal ?? atLeast(queued.length, sample?.queued)),
      };

      const snapshot: StoredLiveSnapshot = {
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
        coverage: { read: rows.byKey.size, total: rows.total, complete: rows.complete },
      };

      await ctx.store.saveSnapshot(envId, snapshot);
      if (scheduled.length > 0) await ctx.store.recordReady(envId, scheduled.map(tryKeyOf), at);
      if (running.length > 0)
        await ctx.store.upsertTaskTries(
          running.map((t) => ({ ...storedTryOf(envId, t), seenRunningAt: at })),
        );
      // Only a snapshot that read every running try knows which stored running tries have stopped.
      if (rows.runningComplete) await ctx.store.closeRunningTries(envId, running.map(tryKeyOf), at);
      await syncConfig(ctx, pools);
      return { dataAsOf: at };
    },
  };
}
