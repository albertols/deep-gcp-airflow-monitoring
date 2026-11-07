/**
 * Deterministic scheduler simulator for demo mode (spec §20.6, FR-EMU-01, FR-EMU-03).
 *
 * A discrete-time model (5 s ticks) of one Airflow 2.11 environment on Managed Airflow (Gen 3):
 * DAG runs at their schedule, tasks in layers, the scheduler admitting ready task instances in the
 * order `_executable_task_instances_to_queued` checks limits (parallelism caps the batch, then pool open
 * slots, then the DAG's `max_active_tasks`), a Celery executor with worker slots, and an autoscaler with
 * start-up lag. It produces the facts DCAM collects (task tries, a live snapshot every 30 s, a worker
 * sample per minute) plus the ground truth of why every waiting task instance waited, so the HM-006
 * classifier can be tested against it. Fictitious data only.
 *
 * @implements FR-EMU-01, FR-EMU-03
 */
import type {
  DagMeta,
  EnvironmentConfig,
  LiveSnapshot,
  PlatformHealth,
  PoolState,
  SnapshotTaskInstance,
  WaitReasonId,
  WorkerSample,
} from '@dcam/domain';
import type { StoredTaskTry } from '@dcam/ports';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const TICK = 5 * SECOND;
const SNAPSHOT_EVERY = 30 * SECOND;
const SAMPLE_EVERY = MINUTE;
const WARM_UP = HOUR;
/** Task instances the scheduler can queue per tick: several loops of `max_tis_per_query` (16). */
const BATCH_PER_TICK = 80;
const RETRY_DELAY = MINUTE;
const WORKER_START_MIN = 2 * MINUTE;
const WORKER_START_SPREAD = MINUTE;
const SCALE_DOWN_AFTER = 10 * MINUTE;
/** HM-006 thresholds: pre-queue waits under 30 s and post-queue waits under 60 s are normal latency. */
const PRE_QUEUE_GRACE = 30 * SECOND;
const POST_QUEUE_GRACE = 60 * SECOND;

/** How one DAG behaves in the simulation. */
export interface DagBlueprint {
  readonly meta: DagMeta;
  readonly periodMinutes: number;
  /** Minutes after the start of each period (round minutes create collisions). */
  readonly offsetMinutes: number;
  /** Number of tasks per layer; a layer starts when the previous one has finished. */
  readonly layers: readonly number[];
  readonly medianTaskMs: number;
  readonly pool: string;
  readonly poolSlots: number;
  readonly operator: string;
  readonly failureRate: number;
  /** vCPU demand of one running task. */
  readonly cpu: number;
  /** The first task is a poke-mode sensor that holds its slot while it waits. */
  readonly sensorWaitMs?: number;
  /**
   * A step change in duration (HM-016 demo story): tries of these tasks that start in the last
   * `hoursBeforeNow` hours of the simulation run `factor` × longer. Draws no extra random numbers.
   */
  readonly slowdown?: {
    readonly taskIds: readonly string[];
    readonly factor: number;
    readonly hoursBeforeNow: number;
  };
}

export interface Scenario {
  readonly config: EnvironmentConfig;
  readonly platformHealth: PlatformHealth;
  /** vCPUs per worker, for the CPU samples. */
  readonly workerCpu: number;
  dags(random: () => number): DagBlueprint[];
}

export interface SimulationOptions {
  readonly seed: number;
  /** Fake "now" (epoch ms); the window ends here. */
  readonly now: number;
  readonly hours: number;
  readonly scenario: Scenario;
}

export interface SimulationResult {
  readonly config: EnvironmentConfig;
  readonly dags: DagMeta[];
  readonly tries: StoredTaskTry[];
  readonly snapshots: LiveSnapshot[];
  readonly workerSamples: WorkerSample[];
  readonly platformHealth: PlatformHealth;
  /** Why each waiting task instance waited at each snapshot; key from {@link groundTruthKey}. Tests only. */
  readonly groundTruth: ReadonlyMap<string, WaitReasonId>;
}

export function groundTruthKey(
  at: number,
  ti: Pick<SnapshotTaskInstance, 'dagId' | 'runId' | 'taskId' | 'mapIndex' | 'tryNumber'>,
) {
  return `${at}|${ti.dagId}|${ti.runId}|${ti.taskId}|${ti.mapIndex}|${ti.tryNumber}`;
}

/** mulberry32: small, fast, deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Log-normal sample with the given median and a moderate spread. */
export function logNormal(random: () => number, median: number, sigma = 0.5): number {
  const u = Math.max(random(), 1e-9);
  const v = random();
  return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

type TiState = 'scheduled' | 'queued' | 'running' | 'retry-wait';

interface Run {
  readonly dag: DagBlueprint;
  readonly runId: string;
  readonly logical: number;
  layer: number;
  remaining: number;
}

interface Ti {
  readonly run: Run;
  readonly taskId: string;
  readonly tryNumber: number;
  readonly priorityWeight: number;
  readonly sensor: boolean;
  state: TiState;
  readyAt: number;
  queuedAt: number;
  pickupAt: number;
  startAt: number;
  endAt: number;
  failed: boolean;
  reason: WaitReasonId;
}

export function simulateEnvironment(options: SimulationOptions): SimulationResult {
  const { scenario, now } = options;
  const config = scenario.config;
  const random = rng(options.seed);
  const blueprints = scenario.dags(random);
  const windowStart = now - options.hours * HOUR;
  const start = windowStart - WARM_UP;
  const cap = config.parallelism * config.schedulers;
  const conc = config.workerConcurrency;

  const poolSlots = new Map(config.pools.map((p) => [p.name, p.slots]));
  const poolRunning = new Map(config.pools.map((p) => [p.name, 0]));
  const poolQueued = new Map(config.pools.map((p) => [p.name, 0]));
  const dagActive = new Map<string, number>();
  let execRunning = 0;
  let execQueued = 0;
  let workers = config.minWorkers;
  let target: number;
  let pendingWorkers: number[] = [];
  let idleSince: number | null = null;

  let scheduled: Ti[] = [];
  let queued: Ti[] = [];
  let running: Ti[] = [];
  let retrying: Ti[] = [];
  const nextRun = blueprints.map((b) => firstRunAt(b, start));

  const tries: StoredTaskTry[] = [];
  const snapshots: LiveSnapshot[] = [];
  const workerSamples: WorkerSample[] = [];
  const groundTruth = new Map<string, WaitReasonId>();
  const add = (m: Map<string, number>, k: string, d: number) => m.set(k, (m.get(k) ?? 0) + d);

  const weightsFor = (layers: readonly number[]) =>
    layers.map((_, i) => 1 + layers.slice(i + 1).reduce((s, n) => s + n, 0));

  const createLayer = (run: Run, t: number) => {
    const weights = weightsFor(run.dag.layers);
    const count = run.dag.layers[run.layer] ?? 0;
    run.remaining = count;
    for (let i = 0; i < count; i++) {
      const sensor = run.layer === 0 && i === 0 && run.dag.sensorWaitMs !== undefined;
      scheduled.push(
        newTi(
          run,
          `${sensor ? 'wait_for' : 'task'}_${run.layer + 1}_${i + 1}`,
          1,
          weights[run.layer] ?? 1,
          sensor,
          t,
        ),
      );
    }
  };

  const record = (ti: Ti, endAt: number | null, state: string) => {
    const dag = ti.run.dag;
    tries.push({
      envId: config.envId,
      dagId: dag.meta.dagId,
      runId: ti.run.runId,
      taskId: ti.taskId,
      mapIndex: -1,
      tryNumber: ti.tryNumber,
      pool: dag.pool,
      poolSlots: dag.poolSlots,
      state,
      readyAt: ti.readyAt,
      queuedAt: ti.queuedAt,
      startAt: ti.startAt,
      endAt,
      sourceUpdatedAt: endAt ?? ti.startAt,
      operator: ti.sensor ? 'ExternalTaskSensor' : dag.operator,
    });
  };

  for (let t = start; t < now; t += TICK) {
    // 1. Completions free their slots; finished layers release the next layer.
    const stillRunning: Ti[] = [];
    for (const ti of running) {
      if (ti.endAt > t) {
        stillRunning.push(ti);
        continue;
      }
      const dag = ti.run.dag;
      add(poolRunning, dag.pool, -dag.poolSlots);
      add(dagActive, dag.meta.dagId, -1);
      execRunning--;
      record(ti, ti.endAt, ti.failed ? 'failed' : 'success');
      if (ti.failed && ti.tryNumber < 2) {
        const retry = newTi(
          ti.run,
          ti.taskId,
          ti.tryNumber + 1,
          ti.priorityWeight,
          ti.sensor,
          ti.endAt + RETRY_DELAY,
        );
        retry.state = 'retry-wait';
        retrying.push(retry);
        continue;
      }
      ti.run.remaining--;
      if (ti.run.remaining === 0 && ti.run.layer + 1 < dag.layers.length) {
        ti.run.layer++;
        createLayer(ti.run, t);
      }
    }
    running = stillRunning;

    // 2. Retries become ready after the retry delay.
    const waitingRetry: Ti[] = [];
    for (const ti of retrying) {
      if (ti.readyAt <= t) {
        ti.state = 'scheduled';
        scheduled.push(ti);
      } else waitingRetry.push(ti);
    }
    retrying = waitingRetry;

    // 3. New DAG runs at their schedule.
    blueprints.forEach((b, i) => {
      while ((nextRun[i] as number) <= t) {
        const logical = nextRun[i] as number;
        nextRun[i] = logical + b.periodMinutes * MINUTE;
        if (b.meta.paused) continue;
        const run: Run = {
          dag: b,
          runId: `scheduled__${new Date(logical).toISOString().replace('.000Z', '+00:00')}`,
          logical,
          layer: 0,
          remaining: 0,
        };
        createLayer(run, t);
      }
    });

    // 4. Workers that finished starting join; the scheduler admits ready task instances.
    workers += pendingWorkers.filter((at) => at <= t).length;
    pendingWorkers = pendingWorkers.filter((at) => at > t);

    scheduled.sort(
      (a, b) =>
        b.priorityWeight - a.priorityWeight ||
        a.run.logical - b.run.logical ||
        cmp(a.run.dag.meta.dagId, b.run.dag.meta.dagId) ||
        cmp(a.taskId, b.taskId),
    );
    const room = cap - execRunning - execQueued;
    const maxTis = Math.min(BATCH_PER_TICK, room);
    let admitted = 0;
    const stillScheduled: Ti[] = [];
    for (const ti of scheduled) {
      const dag = ti.run.dag;
      const open =
        (poolSlots.get(dag.pool) ?? 0) - (poolRunning.get(dag.pool) ?? 0) - (poolQueued.get(dag.pool) ?? 0);
      let reason: WaitReasonId | null = null;
      if (room <= 0) reason = 'parallelism';
      else if (open < dag.poolSlots) reason = 'pool-exhausted';
      else if ((dagActive.get(dag.meta.dagId) ?? 0) >= dag.meta.maxActiveTasks)
        reason = 'dag-max-active-tasks';
      else if (admitted >= maxTis) reason = maxTis < BATCH_PER_TICK ? 'parallelism' : 'scheduler-throughput';
      if (reason === null) {
        ti.state = 'queued';
        ti.queuedAt = t;
        ti.pickupAt = t + 2 * SECOND + Math.floor(random() * 6) * SECOND;
        add(poolQueued, dag.pool, dag.poolSlots);
        add(dagActive, dag.meta.dagId, 1);
        execQueued++;
        admitted++;
        queued.push(ti);
        continue;
      }
      ti.reason =
        reason === 'scheduler-throughput' && t - ti.readyAt < PRE_QUEUE_GRACE ? 'normal-latency' : reason;
      stillScheduled.push(ti);
    }
    scheduled = stillScheduled;

    // 5. The executor starts queued task instances on free worker slots.
    let free = workers * conc - execRunning;
    const stillQueued: Ti[] = [];
    for (const ti of queued) {
      if (free > 0 && ti.pickupAt <= t) {
        const dag = ti.run.dag;
        free--;
        ti.state = 'running';
        ti.startAt = t;
        const slow = dag.slowdown;
        const factor =
          slow && t >= now - slow.hoursBeforeNow * HOUR && slow.taskIds.includes(ti.taskId) ? slow.factor : 1;
        const duration = ti.sensor
          ? logNormal(random, dag.sensorWaitMs as number, 0.35)
          : logNormal(random, dag.medianTaskMs) * factor;
        ti.failed = !ti.sensor && random() < dag.failureRate;
        ti.endAt = t + Math.max(SECOND, Math.round(ti.failed ? duration * 0.3 : duration));
        add(poolQueued, dag.pool, -dag.poolSlots);
        add(poolRunning, dag.pool, dag.poolSlots);
        execQueued--;
        execRunning++;
        running.push(ti);
        continue;
      }
      ti.reason =
        free <= 0
          ? workers < config.maxWorkers
            ? 'autoscaling-lag'
            : 'executor-slots-exhausted'
          : t - ti.queuedAt >= POST_QUEUE_GRACE
            ? 'worker-pickup'
            : 'normal-latency';
      stillQueued.push(ti);
    }
    queued = stillQueued;

    // 6. Autoscaler: scale up with start-up lag; scale down after sustained idle capacity.
    target = clamp(Math.ceil((execRunning + execQueued) / conc), config.minWorkers, config.maxWorkers);
    const missing = target - workers - pendingWorkers.length;
    for (let i = 0; i < missing; i++)
      pendingWorkers.push(t + WORKER_START_MIN + Math.floor(random() * WORKER_START_SPREAD));
    if (target < workers) {
      idleSince ??= t;
      if (t - idleSince >= SCALE_DOWN_AFTER) {
        workers = Math.max(target, Math.ceil(execRunning / conc), config.minWorkers);
        idleSince = null;
      }
    } else idleSince = null;

    if (t < windowStart) continue;

    // 7. What DCAM would observe.
    if ((t - windowStart) % SNAPSHOT_EVERY === 0) {
      const view = (ti: Ti, since: number): SnapshotTaskInstance => ({
        dagId: ti.run.dag.meta.dagId,
        runId: ti.run.runId,
        taskId: ti.taskId,
        mapIndex: -1,
        tryNumber: ti.tryNumber,
        pool: ti.run.dag.pool,
        poolSlots: ti.run.dag.poolSlots,
        priorityWeight: ti.priorityWeight,
        since,
      });
      const snapshot: LiveSnapshot = {
        at: t,
        scheduled: scheduled.map((ti) => view(ti, ti.readyAt)),
        queued: queued.map((ti) => view(ti, ti.queuedAt)),
        pools: config.pools.map((p): PoolState => {
          const run = poolRunning.get(p.name) ?? 0;
          const que = poolQueued.get(p.name) ?? 0;
          return {
            name: p.name,
            slots: p.slots,
            running: run,
            queued: que,
            open: Math.max(0, p.slots - run - que),
          };
        }),
        dagActive: Object.fromEntries([...dagActive].filter(([, n]) => n > 0)),
        executor: { running: execRunning, queued: execQueued },
        workers: { current: workers, target },
      };
      snapshots.push(snapshot);
      for (const ti of [...scheduled, ...queued]) groundTruth.set(groundTruthKey(t, view(ti, 0)), ti.reason);
    }
    if ((t - windowStart) % SAMPLE_EVERY === 0) {
      const demand = running.reduce((s, ti) => s + (ti.sensor ? 0.02 : ti.run.dag.cpu), 0);
      const utilisation = workers > 0 ? execRunning / (workers * conc) : 0;
      workerSamples.push({
        at: t,
        workers,
        target,
        running: execRunning,
        queued: execQueued,
        cpu: clamp(demand / (workers * scenario.workerCpu) + random() * 0.06, 0, 1),
        memory: clamp(0.22 + 0.45 * utilisation + random() * 0.05, 0, 1),
      });
    }
  }

  for (const ti of running) record(ti, null, 'running');

  return {
    config,
    dags: blueprints.map((b) => b.meta),
    tries,
    snapshots,
    workerSamples,
    platformHealth: scenario.platformHealth,
    groundTruth,
  };
}

function newTi(
  run: Run,
  taskId: string,
  tryNumber: number,
  priorityWeight: number,
  sensor: boolean,
  readyAt: number,
): Ti {
  return {
    run,
    taskId,
    tryNumber,
    priorityWeight,
    sensor,
    state: 'scheduled',
    readyAt,
    queuedAt: 0,
    pickupAt: 0,
    startAt: 0,
    endAt: 0,
    failed: false,
    reason: 'unknown',
  };
}

function firstRunAt(b: DagBlueprint, from: number): number {
  const period = b.periodMinutes * MINUTE;
  const offset = b.offsetMinutes * MINUTE;
  return Math.ceil((from - offset) / period) * period + offset;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
