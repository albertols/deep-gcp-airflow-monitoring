/**
 * Zod schemas of the Airflow 2.11.1 REST API v1 responses DCAM reads, and their mapping to the port
 * types. Shapes follow airflow/api_connexion/openapi/v1.yaml and airflow/api_connexion/schemas/*.py at
 * tag 2.11.1. Objects are not strict: every key the port does not need is dropped here, in particular
 * the task instance's `rendered_fields`, `sla_miss`, `trigger`, `triggerer_job` and `note` (spec §7.1
 * rule 4), import error stack traces and provider details.
 *
 * @implements FR-COLL-08
 */
import { z } from 'zod';
import type { AirflowDag, AirflowHealth, AirflowPool, AirflowTaskInstance, Page } from '@dcam/ports';
import { scheduleText } from './schedule';

const TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Epoch milliseconds of an ISO 8601 time with a time zone, as Airflow writes them (`isoformat()`, up to
 * microseconds, `+00:00`); `null` if it is not one. Sub-millisecond digits are truncated.
 */
export function parseTime(text: string): number | null {
  const m = TIME.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac = '', zone = 'Z'] = m;
  const [month, day, hour, minute, second] = [mo, d, h, mi, s].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  const ms = Number(frac.slice(0, 3).padEnd(3, '0'));
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== 'Z') {
    const digits = zone.replace(':', '');
    const sign = digits.startsWith('-') ? -1 : 1;
    offsetMinutes = sign * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5)));
  }
  return Date.UTC(Number(y), month - 1, day, hour, minute, second, ms) - offsetMinutes * 60_000;
}

const time = z.string().transform((text, ctx) => {
  const ms = parseTime(text);
  if (ms === null) {
    ctx.addIssue({ code: 'custom', message: 'expected an ISO 8601 time with a time zone' });
    return z.NEVER;
  }
  return ms;
});

const int = z.number().int();
const total = z.number().int().nonnegative();
const status = z.enum(['healthy', 'unhealthy']).nullish();

// ---- /version, /health ---------------------------------------------------------------------------------

export const versionWire = z.object({ version: z.string().min(1) });

export const healthWire = z.object({
  metadatabase: z.object({ status }).nullish(),
  scheduler: z.object({ status, latest_scheduler_heartbeat: time.nullish() }).nullish(),
});

export function toHealth(w: z.output<typeof healthWire>): AirflowHealth {
  return {
    metadatabase: w.metadatabase?.status ?? null,
    scheduler: {
      status: w.scheduler?.status ?? null,
      latestHeartbeat: w.scheduler?.latest_scheduler_heartbeat ?? null,
    },
  };
}

// ---- /dags -----------------------------------------------------------------------------------------------

const dagWire = z.object({
  dag_id: z.string().min(1),
  fileloc: z.string(),
  owners: z.array(z.string()).nullish(),
  tags: z.array(z.object({ name: z.string() })).nullish(),
  is_paused: z.boolean().nullish(),
  is_active: z.boolean().nullish(),
  /** Checked leniently by {@link scheduleText}: one odd DAG must not fail a page of 100. */
  schedule_interval: z.unknown().optional(),
  timetable_description: z.string().nullish(),
  max_active_tasks: int.nullish(),
  max_active_runs: int.nullish(),
});

export const dagCollectionWire = z.object({ dags: z.array(dagWire), total_entries: total });

export function toDagPage(w: z.output<typeof dagCollectionWire>): Page<AirflowDag> {
  return {
    total: w.total_entries,
    items: w.dags.map((d) => ({
      dagId: d.dag_id,
      fileloc: d.fileloc,
      owners: d.owners ?? [],
      tags: (d.tags ?? []).map((t) => t.name),
      schedule: scheduleText(d.schedule_interval, d.timetable_description),
      paused: d.is_paused ?? false,
      // The list is filtered to active DAGs (`only_active` defaults to true in the 2.11.1 spec).
      active: d.is_active ?? true,
      maxActiveTasks: d.max_active_tasks ?? null,
      maxActiveRuns: d.max_active_runs ?? null,
    })),
  };
}

// ---- /pools ------------------------------------------------------------------------------------------------

const poolWire = z.object({
  name: z.string().min(1),
  slots: int,
  running_slots: int,
  queued_slots: int,
  open_slots: int,
  /** Optional so that a release without them still parses; `deferred_slots` is new in 2.7.0 (v1.yaml `Pool`). */
  scheduled_slots: int.nullish(),
  deferred_slots: int.nullish(),
});

export const poolCollectionWire = z.object({ pools: z.array(poolWire), total_entries: total });

export function toPool(p: z.output<typeof poolWire>): AirflowPool {
  return {
    name: p.name,
    slots: p.slots,
    runningSlots: p.running_slots,
    queuedSlots: p.queued_slots,
    openSlots: p.open_slots,
    scheduledSlots: p.scheduled_slots ?? null,
    deferredSlots: p.deferred_slots ?? null,
  };
}

// ---- /importErrors, /providers -------------------------------------------------------------------------

/** Only the count: stack traces quote DAG source code and are never kept. */
export const importErrorCountWire = z.object({ total_entries: total });

export const providersWire = z.object({ providers: z.array(z.unknown()) });

// ---- /dags/~/dagRuns/~/taskInstances ------------------------------------------------------------------

const taskInstanceWire = z.object({
  dag_id: z.string().min(1),
  dag_run_id: z.string().min(1),
  task_id: z.string().min(1),
  map_index: int,
  try_number: int,
  /** Nullable since 2.7.0 (v1.yaml `TaskState`). */
  state: z.string().nullish(),
  pool: z.string(),
  pool_slots: int,
  priority_weight: int.nullish(),
  operator: z.string().nullish(),
  queue: z.string().nullish(),
  hostname: z.string().nullish(),
  /** `queued_dttm`, published as `queued_when` (task_instance_schema.py at 2.11.1). */
  queued_when: time.nullish(),
  start_date: time.nullish(),
  end_date: time.nullish(),
});

export const taskInstanceCollectionWire = z.object({
  task_instances: z.array(taskInstanceWire),
  total_entries: total,
});

export function toTaskInstancePage(
  w: z.output<typeof taskInstanceCollectionWire>,
): Page<AirflowTaskInstance> {
  return {
    total: w.total_entries,
    items: w.task_instances.map((t) => ({
      dagId: t.dag_id,
      runId: t.dag_run_id,
      taskId: t.task_id,
      mapIndex: t.map_index,
      tryNumber: t.try_number,
      state: t.state ?? null,
      pool: t.pool,
      poolSlots: t.pool_slots,
      priorityWeight: t.priority_weight ?? null,
      operator: t.operator ?? null,
      queue: t.queue ?? null,
      // An empty hostname means no worker has reported one yet.
      hostname: t.hostname ? t.hostname : null,
      queuedAt: t.queued_when ?? null,
      startAt: t.start_date ?? null,
      endAt: t.end_date ?? null,
    })),
  };
}
