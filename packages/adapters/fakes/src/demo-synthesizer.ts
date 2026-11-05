/**
 * Deterministic demo fact synthesiser v0 (spec §20.6). Generates task instance tries for the
 * fictitious "acme" organisation directly, without Airflow: hourly and daily schedules clustered on
 * round minutes, log-normal durations, a few heavy DAGs, pools, queue waits and some retries.
 *
 * @implements FR-EMU-01
 */
import type { StoredTaskTry } from '@dcam/ports';

export interface DemoOptions {
  readonly seed: number;
  /** Fake "now" (epoch ms); the dataset ends here. */
  readonly now: number;
  readonly hours: number;
  readonly envId: string;
  readonly dagCount?: number;
}

const DOMAINS = [
  'orders', 'customer_360', 'billing', 'inventory', 'marketing', 'finance', 'ml_features', 'clickstream',
  'payments', 'logistics', 'pricing', 'crm_sync', 'fraud', 'search_index', 'reporting',
];
const SUFFIXES = ['daily', 'hourly', 'ingest', 'export', 'refresh', 'backfill', 'dq_checks', 'aggregate'];
const POOLS = ['default_pool', 'default_pool', 'etl', 'ml', 'external_api'];
const HOUR = 3_600_000;
const MIN = 60_000;

/** mulberry32: small, fast, deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface DagSpec {
  readonly dagId: string;
  readonly everyHours: number;
  readonly minute: number;
  readonly tasks: number;
  readonly medianTaskMs: number;
  readonly pool: string;
  readonly poolSlots: number;
}

function dagSpecs(count: number, random: () => number): DagSpec[] {
  const specs: DagSpec[] = [];
  for (let i = 0; i < count; i++) {
    const name = `${DOMAINS[i % DOMAINS.length]}_${SUFFIXES[Math.floor(i / DOMAINS.length) % SUFFIXES.length]}`;
    const dagId = i < DOMAINS.length * SUFFIXES.length ? name : `${name}_${i}`;
    // A small share of DAGs is heavy: long tasks and wide fan-out (Pareto-shaped load).
    const heavy = random() < 0.12;
    const hourly = random() < 0.45;
    specs.push({
      dagId,
      everyHours: hourly ? 1 : 24,
      // 60 % of schedules sit on round minutes, which creates the collisions DCAM should reveal.
      minute: random() < 0.6 ? 0 : Math.floor(random() * 12) * 5,
      tasks: heavy ? 8 + Math.floor(random() * 16) : 1 + Math.floor(random() * 5),
      medianTaskMs: heavy ? (8 + random() * 25) * MIN : (0.5 + random() * 4) * MIN,
      pool: POOLS[Math.floor(random() * POOLS.length)] as string,
      poolSlots: random() < 0.1 ? 2 : 1,
    });
  }
  return specs;
}

/** Log-normal sample with the given median and a moderate spread. */
function logNormal(random: () => number, median: number): number {
  const u = Math.max(random(), 1e-9);
  const v = random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return median * Math.exp(0.5 * z);
}

export function synthesizeTaskTries(options: DemoOptions): StoredTaskTry[] {
  const random = rng(options.seed);
  const from = options.now - options.hours * HOUR;
  const out: StoredTaskTry[] = [];
  for (const dag of dagSpecs(options.dagCount ?? 120, random)) {
    const period = dag.everyHours * HOUR;
    const firstSlot = Math.ceil((from - dag.minute * MIN) / period) * period + dag.minute * MIN;
    for (let runStart = firstSlot; runStart < options.now; runStart += period) {
      const runId = `scheduled__${new Date(runStart).toISOString()}`;
      // Collisions on round minutes add queue wait.
      const congestion = dag.minute === 0 ? 3 : 1;
      let cursor = runStart + random() * 20_000 * congestion;
      for (let task = 0; task < dag.tasks; task++) {
        const queueWait = random() * 15_000 * congestion;
        const startAt = Math.round(cursor + queueWait);
        if (startAt > options.now) break;
        const duration = Math.round(logNormal(random, dag.medianTaskMs));
        const failedFirst = random() < 0.03;
        const tries = failedFirst ? 2 : 1;
        let tryStart = startAt;
        for (let tryNumber = 1; tryNumber <= tries && tryStart <= options.now; tryNumber++) {
          const tryDuration = tryNumber < tries ? Math.round(duration * 0.3) : duration;
          const end = tryStart + tryDuration;
          const running = end > options.now;
          out.push({
            envId: options.envId,
            dagId: dag.dagId,
            runId,
            taskId: `task_${String(task + 1).padStart(2, '0')}`,
            mapIndex: -1,
            tryNumber,
            pool: dag.pool,
            poolSlots: dag.poolSlots,
            state: running ? 'running' : tryNumber < tries ? 'failed' : 'success',
            queuedAt: Math.round(tryStart - queueWait),
            startAt: tryStart,
            endAt: running ? null : end,
            sourceUpdatedAt: running ? tryStart : end,
          });
          tryStart = end + 60_000;
        }
        // Tasks of a run form a chain; heavy DAGs fan out (several tasks start together).
        cursor = dag.tasks > 6 && task % 4 !== 3 ? cursor : startAt + duration;
      }
    }
  }
  return out;
}
