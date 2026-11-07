/**
 * `af.live` (live): `GET /pools` plus the non-terminal task instances (`scheduled`, `queued`, `running`
 * on `GET /dags/~/dagRuns/~/taskInstances`, `~` being the wildcard for every DAG and run) → one
 * {@link LiveSnapshot} per cycle, the HM-006 classifier's input.
 *
 * - Budget: `/pools` and at most two task instance pages a cycle (spec §7.5 L648), 100 rows per page
 *   (Appendix B.1), at offset 0 (the list has no defined order, §7.5). While the previous snapshot was
 *   complete, one page of all three states comes first: it usually holds every row, so the cycle costs
 *   `/pools` and one page, as the §7.11 arithmetic assumes ("1 page every 30 s"), and leaves the rest of
 *   the 12 requests a minute to `af.facts` and the background inventory (which only runs while half the
 *   budget is unused, `budget.ts`).
 * - Running first when the rows do not fit: otherwise the second page, and while snapshots are samples
 *   the first, reads the `running` state alone, and the scheduled and queued task instances are the
 *   sample. In Airflow 2.11 a task instance waiting on a pool, `max_active_tasks`, a task-level limit or
 *   parallelism stays `scheduled`; only the ones that pass those checks become `queued` and go to the
 *   executor (`SchedulerJobRunner._executable_task_instances_to_queued` in
 *   `airflow/jobs/scheduler_job_runner.py` at `v2-11-stable`, as spec HM-006 "Why this order" reads it).
 *   So in the bottleneck DCAM diagnoses the scheduled state overflows, while the running state is bounded
 *   by the worker slots and usually fits one page: reading it alone keeps the running set complete, which
 *   `closeRunningTries` needs. This departs from spec §7.5 L648 "(queued first)". A first page that
 *   holds running tries only is followed by the scheduled and queued page instead.
 * - More running tries than one page but not two: a cycle whose previous cycle saved a snapshot with a
 *   sampled running set reads both running pages (the second at the offset of the rows the first
 *   returned; complete only if the count did not change between them), ends the stopped tries and saves
 *   no snapshot, because one without the scheduled and queued rows would draw them as zero. The next
 *   cycle reads running and waiting rows again, so snapshots continue every other cycle (within the two
 *   cadences a snapshot stands for in `snapshot-time.ts`) and the running set is complete every other
 *   cycle. Beyond two pages the running set stays a sample.
 * - Samples (§7.5: "Live snapshots take exact counts from `total_entries`; when a state has more rows
 *   than the page budget allows, the rows read are a sample and are labelled as such"): the snapshot
 *   stores its coverage (rows read, `total_entries`, complete or not, and the sampled states) and the
 *   cycle reports reduced fidelity (FR-COLL-06). The running count comes from the running page's
 *   `total_entries` (or all states less the scheduled and queued ones); the queued count, unless every
 *   scheduled and queued try was read, from the newest Cloud Monitoring sample (spec L870: "the cheap
 *   `/pools` aggregates plus Cloud Monitoring executor metrics keep the live view accurate").
 * - Ready times: Airflow 2.11 records no "scheduled" timestamp, so a scheduled try's `since` is when
 *   DCAM first saw it scheduled, carried from the previous snapshot, and recorded with `recordReady`
 *   so that stored tries get it as `readyAt` (HM-001, HM-006). A queued try's `since` is `queued_dttm`.
 * - Running tries are upserted as running, seen running at the snapshot time, so the pages see their slot
 *   time before af.facts stores the finished row under the same key (1–2 minutes later on the `live` and
 *   `standard` profiles, more on `eco`). Until then a finished try would count as running until now, so a
 *   cycle that read every running try ends each stored running try it no longer lists when DCAM last
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
type LiveState = (typeof STATES)[number];
const WAITING = ['scheduled', 'queued'] as const;
const RUNNING = ['running'] as const;
const PAGE_SIZE = 100;
/** `/pools` and two task instance pages (spec §7.5 L648). */
const MAX_REQUESTS = 3;
/** A previous snapshot older than this does not carry first-seen times across the gap. */
const CARRY_SINCE_MS = 5 * 60_000;
/** A worker sample is fresh enough for the live view within this age (ingestion delay plus cadence). */
const FRESH_SAMPLE_MS = 10 * 60_000;

/** What an environment's previous cycle read. */
interface Previous {
  readonly complete: boolean;
  readonly runningComplete: boolean;
  /** It saved a snapshot. */
  readonly snapshot: boolean;
}

interface Rows {
  readonly running: Map<string, AirflowTaskInstance>;
  /** Scheduled and queued tries. */
  readonly waiting: Map<string, AirflowTaskInstance>;
  /** `total_entries` of the states read; `null` when a page could not be read. */
  readonly total: number | null;
  /** Running task instances, from `total_entries`; `null` when unknown. */
  readonly runningTotal: number | null;
  /** Every running try was read, so the stored running tries it does not list have stopped. */
  readonly runningComplete: boolean;
  /** Every scheduled and queued try was read. */
  readonly waitingComplete: boolean;
  /** The budget refused the second page. */
  readonly refused: boolean;
}

/**
 * The non-terminal task instances within two pages, the running ones in pages of their own whenever the
 * first page does not hold every row. A budget refusal of the first page propagates: there is no snapshot
 * without rows.
 */
async function readRows(ctx: CollectorContext, previous: Previous | undefined): Promise<Rows> {
  const airflow = ctx.airflow();
  const running = new Map<string, AirflowTaskInstance>();
  const waiting = new Map<string, AirflowTaskInstance>();
  const keep = (items: readonly AirflowTaskInstance[]) => {
    for (const t of items) (t.state === 'running' ? running : waiting).set(keyString(t), t);
    // A try seen waiting, then running, is running.
    for (const k of running.keys()) waiting.delete(k);
  };
  const read = (states: readonly string[], offset = 0) =>
    airflow.taskInstances({ states, limit: PAGE_SIZE, offset });
  /** The second page, or `null` when the budget refuses it. */
  const second = async (states: readonly string[], offset = 0) => {
    try {
      return await read(states, offset);
    } catch (e) {
      if (!(e instanceof BudgetExhaustedError)) throw e;
      return null;
    }
  };
  const full = (p: { readonly items: readonly unknown[]; readonly total: number }) =>
    p.items.length >= p.total;
  const rows = (r: Omit<Rows, 'running' | 'waiting'>): Rows => ({ ...r, running, waiting });

  if (!previous || previous.complete) {
    const all = await read(STATES);
    keep(all.items);
    if (full(all))
      return rows({
        total: all.total,
        runningTotal: running.size,
        runningComplete: true,
        waitingComplete: true,
        refused: false,
      });
    if (waiting.size > 0) {
      // The scheduled and queued rows of the first page are the sample; the second completes the running set.
      const run = await second(RUNNING);
      if (run === null)
        return rows({
          total: all.total,
          runningTotal: null,
          runningComplete: false,
          waitingComplete: false,
          refused: true,
        });
      running.clear();
      keep(run.items);
      return rows({
        total: all.total,
        runningTotal: run.total,
        runningComplete: full(run),
        waitingComplete: full(run) && waiting.size >= all.total - run.total,
        refused: false,
      });
    }
    // The first page holds running tries only: the second reads the scheduled and queued ones.
    const wait = await second(WAITING);
    if (wait !== null) keep(wait.items);
    return rows({
      total: all.total,
      // Running: all states less the scheduled and queued ones, both from `total_entries`.
      runningTotal: wait === null ? null : Math.max(running.size, all.total - wait.total),
      runningComplete: false,
      waitingComplete: wait !== null && full(wait),
      refused: wait === null,
    });
  }

  const run = await read(RUNNING);
  keep(run.items);
  const n = run.items.length;
  if (!full(run) && n > 0 && run.total <= 2 * n && previous.snapshot && !previous.runningComplete) {
    // More running tries than a page but not two: this cycle completes them and saves no snapshot (a
    // snapshot without the waiting states would draw them as zero); the next cycle reads those.
    const rest = await second(RUNNING, n);
    if (rest !== null) keep(rest.items);
    return rows({
      total: rest?.total ?? run.total,
      runningTotal: rest?.total ?? run.total,
      // The count did not change between the pages, so no row shifted past an offset.
      runningComplete: rest !== null && rest.total === run.total && running.size >= rest.total,
      waitingComplete: false,
      refused: rest === null,
    });
  }
  const wait = await second(WAITING);
  if (wait !== null) keep(wait.items);
  return rows({
    total: wait === null ? null : run.total + wait.total,
    runningTotal: run.total,
    runningComplete: full(run),
    waitingComplete: wait !== null && full(wait),
    refused: wait === null,
  });
}

/** The states a cycle read in part, in {@link STATES} order. */
const sampledStates = (r: Rows): LiveState[] => [
  ...(r.waitingComplete ? [] : (['scheduled', 'queued'] as const)),
  ...(r.runningComplete ? [] : (['running'] as const)),
];
const listed = (xs: readonly string[]) =>
  xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1) ?? ''}`;

/** Why the cycle's rows are not every non-terminal task instance, or `null`. */
function stoppedReason(r: Rows, snapshot: boolean): string | null {
  const sampled = sampledStates(r);
  if (sampled.length === 0) return null;
  const read = r.running.size + r.waiting.size;
  const of = r.total === null ? '' : ` of ${r.total}`;
  if (!snapshot && r.refused)
    return 'The Airflow request budget ran out before the scheduled and queued task instances were read; no live snapshot this cycle.';
  if (!snapshot) {
    const total = r.runningTotal ?? r.running.size;
    const running = r.runningComplete ? `all ${total}` : `${r.running.size} of ${total}`;
    return `This cycle read ${running} running task instances (more than one page) to end the tries that stopped, and saved no snapshot; the next cycle reads the scheduled and queued ones.`;
  }
  if (r.refused)
    return `The Airflow request budget ran out after ${read}${of} waiting and running task instances; the live view is a sample.`;
  return `The live view read ${read}${of} waiting and running task instances within its two pages a cycle; its ${listed(sampled)} task instances are a sample.`;
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
  /** Per environment, what its previous cycle read. */
  const previous = new Map<string, Previous>();
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
      let rows: Rows;
      try {
        rows = await readRows(ctx, previous.get(envId));
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
        ctx.reducedFidelity('The Airflow request budget is used up; no live snapshot this cycle.');
        return { dataAsOf: null };
      }
      const sampled = sampledStates(rows);
      const complete = sampled.length === 0;
      /** A snapshot that read no scheduled or queued row while some may exist would draw them as zero. */
      const snapshotted = rows.waiting.size > 0 || rows.waitingComplete;
      previous.set(envId, { complete, runningComplete: rows.runningComplete, snapshot: snapshotted });
      const stopped = stoppedReason(rows, snapshotted);
      if (stopped !== null) ctx.reducedFidelity(stopped);

      const at = ctx.now();
      const running = [...rows.running.values()];
      const upsertRunning = async () => {
        if (running.length > 0)
          await ctx.store.upsertTaskTries(
            running.map((t) => ({ ...storedTryOf(envId, t), seenRunningAt: at })),
          );
        // Only a cycle that read every running try knows which stored running tries have stopped.
        if (rows.runningComplete) await ctx.store.closeRunningTries(envId, running.map(tryKeyOf), at);
      };
      if (!snapshotted) {
        await upsertRunning();
        await syncConfig(ctx, pools);
        return { dataAsOf: at };
      }

      const last = (await ctx.store.snapshots(envId, at - CARRY_SINCE_MS, at)).at(-1);
      const seenSince = new Map(last?.scheduled.map((p) => [keyString(p), p.since]) ?? []);
      const sample = (await ctx.store.workerSamples(envId, at - FRESH_SAMPLE_MS, at + 1)).at(-1);

      const waiting = [...rows.waiting.values()];
      const scheduled = waiting.filter((t) => t.state === 'scheduled');
      const queued = waiting.filter((t) => t.state === 'queued');
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
        running: rows.runningComplete
          ? running.length
          : (rows.runningTotal ?? atLeast(running.length, sample?.running)),
        queued: rows.waitingComplete ? queued.length : atLeast(queued.length, sample?.queued),
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
        coverage: {
          read: running.length + waiting.length,
          total: rows.total,
          complete,
          ...(complete ? {} : { sampled }),
        },
      };

      await ctx.store.saveSnapshot(envId, snapshot);
      if (scheduled.length > 0) await ctx.store.recordReady(envId, scheduled.map(tryKeyOf), at);
      await upsertRunning();
      await syncConfig(ctx, pools);
      return { dataAsOf: at };
    },
  };
}
