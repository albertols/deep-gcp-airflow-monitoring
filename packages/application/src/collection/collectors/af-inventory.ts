/**
 * `af.inventory` (background): `GET /version` (FR-COLL-08) and the DAG inventory from `GET /dags`, 100
 * per page (Appendix B.1; `/dags` is capped at `[api] maximum_page_limit`, default 100). Import errors
 * are `af.facts`' (every fact cycle, §7.5 L653).
 *
 * Cadence and budget: §7.7 (L716) runs it every `airflowFacts` × 10 (10 min on the standard profile).
 * About 2,000 DAGs take 20 pages, so the listing is trickled: each cycle reads at most
 * {@link MAX_REQUESTS} requests, stops early when the budget is used up, reports reduced fidelity, and
 * resumes at the same offset next cycle. The first listing is complete after three cycles. A new pass
 * starts at most {@link PASS_EVERY_MS} after the previous one started (§7.5 L647, "Full listing trickled
 * across the hour"; §7.11 L882, "DAG inventory: 20 pages trickled across the hour, about 0.3" requests a
 * minute); the cycles between make no request but the daily version.
 *
 * Offsets advance by the rows each page returned, not by the limit: a server whose `maximum_page_limit`
 * is below 100 returns shorter pages, and stepping by 100 would skip the rest of each page and still
 * count the pass complete (spec §7.5 "Pagination and consistency", VC-11 open).
 *
 * Until a pass is complete the stored set is the previous set overlaid with the pages read so far
 * (`saveDags` upserts); a complete pass replaces it in one transaction (`replaceDags`), so deleted and
 * inactive DAGs drop out. `/dags` pages by offset, so a DAG added or deleted during the 20–30 minute
 * pass shifts the rows behind it: one is read twice or not at all. A pass replaces the set only when
 * every page's `total_entries` equals the first page's; otherwise it is upserted (a live DAG it missed
 * stays as stored, a deleted one stays until a pass completes unchanged), the cycle reports reduced
 * fidelity, and the next pass starts next cycle rather than an hour after this one. Such a pass costs
 * about 20 more pages, at background priority: it stays within the Airflow `background` budget class and
 * only takes a token while the bucket is at least half full (`budget.ts`).
 *
 * @implements FR-COLL-01, FR-COLL-03, FR-COLL-06, FR-COLL-08, FR-DAGX-08 (default team rule)
 */
import type { DagMeta, EnvironmentConfig } from '@dcam/domain';
import { SourceError } from '@dcam/ports';
import { BudgetExhaustedError, type Collector, type CollectorContext } from '../types';
import {
  assertSupportedAirflow,
  COMPOSER_DEFAULT_MAX_ACTIVE_RUNS_PER_DAG,
  COMPOSER_DEFAULT_MAX_ACTIVE_TASKS_PER_DAG,
  dagMetaOf,
} from './mapping';

/** `limit` of every `/dags` page (Appendix B.1: never above 100). */
const PAGE_SIZE = 100;
/** The version and nine pages: 900 to 1,000 DAGs per cycle at most. */
const MAX_REQUESTS = 10;
/** Appendix B.2: the version is read at connect and then daily. */
const VERSION_EVERY_MS = 24 * 60 * 60_000;
/** A full listing starts at most this long after the previous one started. */
const PASS_EVERY_MS = 60 * 60_000;

interface Pass {
  offset: number;
  total: number | null;
  /** `total_entries` of the pass's first page. */
  first: number | null;
  /** Every page so far counted {@link first} DAGs: no DAG was added or deleted while it was paged. */
  stable: boolean;
  readonly dags: Map<string, DagMeta>;
}

type Defaults = Pick<EnvironmentConfig, 'maxActiveTasksPerDag' | 'maxActiveRunsPerDag'>;

async function dagDefaults(ctx: CollectorContext): Promise<Defaults> {
  const stored = await ctx.store.config(ctx.env.id);
  if (stored) return stored;
  if (ctx.env.source.kind === 'airflow') return ctx.env.source.limits;
  return {
    maxActiveTasksPerDag: COMPOSER_DEFAULT_MAX_ACTIVE_TASKS_PER_DAG,
    maxActiveRunsPerDag: COMPOSER_DEFAULT_MAX_ACTIVE_RUNS_PER_DAG,
  };
}

/**
 * A 404 on `GET /api/v1/version` means the web server serves no REST API v1. Airflow 3 replaced it: "REST API
 * (``/api/v1``) replaced: Use the modern FastAPI-based stable ``/api/v2`` instead" (Airflow
 * `airflow-core/docs/installation/upgrading_to_airflow3.rst` at tag 3.1.0, checked 2026-11-07).
 */
function noApiV1(error: unknown): never {
  if (error instanceof SourceError && error.kind === 'not-found')
    throw new SourceError(
      'unsupported',
      'This Airflow serves no REST API v1 (GET /api/v1/version returned 404)',
      {
        ...error.details,
        fixHint:
          'Airflow 3 replaced the REST API v1 with /api/v2, which DCAM reads from M4 (spec §22.2). If the environment runs Airflow 2, check that the URL is its Airflow web server.',
      },
    );
  throw error;
}

export function afInventoryCollector(): Collector {
  const passes = new Map<string, Pass>();
  const versionReadAt = new Map<string, number>();
  const passStartedAt = new Map<string, number>();

  return {
    manifest: {
      id: 'af.inventory',
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowInventory',
      refreshMs: PASS_EVERY_MS,
      priority: 'background',
      maxRequestsPerCycle: MAX_REQUESTS,
      outputs: ['dags'],
      sourceKinds: ['composer', 'airflow'],
    },
    async collect(ctx) {
      const envId = ctx.env.id;
      const airflow = ctx.airflow();
      let requests = 0;
      let wrote = false;
      let stopped: string | null = null;

      try {
        // The Composer image may already say Airflow 3: no request is spent on an API it does not serve.
        assertSupportedAirflow(ctx.shared.airflowVersion);
        const lastVersion = versionReadAt.get(envId);
        if (lastVersion === undefined || ctx.now() - lastVersion >= VERSION_EVERY_MS) {
          requests++;
          const { version } = await airflow.version().catch(noApiV1);
          ctx.shared.airflowVersion = version;
          versionReadAt.set(envId, ctx.now());
        }
        assertSupportedAirflow(ctx.shared.airflowVersion);

        let pass = passes.get(envId);
        if (!pass) {
          const started = passStartedAt.get(envId);
          if (started !== undefined && ctx.now() - started < PASS_EVERY_MS) return { dataAsOf: null };
          pass = { offset: 0, total: null, first: null, stable: true, dags: new Map<string, DagMeta>() };
          passes.set(envId, pass);
          passStartedAt.set(envId, ctx.now());
        }
        const defaults = await dagDefaults(ctx);
        try {
          while (pass.total === null || pass.offset < pass.total) {
            if (requests >= MAX_REQUESTS) {
              stopped = `The DAG inventory is read a few pages a cycle within the request budget; it continues next cycle at DAG ${pass.offset + 1} of ${pass.total ?? '?'}.`;
              break;
            }
            requests++;
            const page = await airflow.dags({ limit: PAGE_SIZE, offset: pass.offset });
            pass.first ??= page.total;
            if (page.total !== pass.first) pass.stable = false;
            pass.total = page.total;
            for (const d of page.items) if (d.active) pass.dags.set(d.dagId, dagMetaOf(d, defaults));
            // An empty page before the end: the listing shrank while it was paged, and it ends here.
            if (page.items.length === 0) pass.total = pass.offset;
            pass.offset += page.items.length;
          }
        } finally {
          const complete = pass.total !== null && pass.offset >= pass.total && stopped === null;
          // Inside the finally so that a budget stop mid-listing still keeps the pages already read.
          if (pass.dags.size > 0 || complete) {
            await saveDags(ctx, pass, complete);
            wrote = true;
          }
        }
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
        stopped = 'The Airflow request budget is used up; the DAG inventory continues next cycle.';
      }
      if (stopped !== null) ctx.reducedFidelity(stopped);
      return { dataAsOf: wrote ? ctx.now() : null };

      /**
       * A complete pass whose count never changed replaces the stored set in one transaction. Pages read so
       * far, and a pass whose count changed, are upserted; the latter starts the next pass next cycle.
       */
      async function saveDags(c: CollectorContext, pass: Pass, complete: boolean) {
        if (complete && pass.stable) await c.store.replaceDags(envId, [...pass.dags.values()]);
        else await c.store.saveDags(envId, [...pass.dags.values()]);
        if (!complete) return;
        passes.delete(envId);
        if (pass.stable) return;
        passStartedAt.delete(envId);
        stopped = `The DAG list changed while it was read (${pass.first ?? '?'} to ${pass.total ?? '?'} DAGs): a DAG may be missing, or a deleted one kept, until DCAM reads the list again from the next cycle.`;
      }
    },
  };
}
