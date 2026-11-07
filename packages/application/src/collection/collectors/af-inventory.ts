/**
 * `af.inventory` (background): `GET /version` (FR-COLL-08), `GET /importErrors` (HM-028) and the DAG
 * inventory from `GET /dags`, 100 per page (Appendix B.1; `/dags` is capped at `[api]
 * maximum_page_limit`, default 100). About 2,000 DAGs take 20 pages, so the listing is trickled: each
 * cycle reads at most {@link MAX_REQUESTS} requests, stops early when the budget is used up, reports
 * reduced fidelity, and resumes at the same offset next cycle (spec §7.11 budget arithmetic, "DAG
 * inventory trickled across the hour").
 *
 * Offsets advance by the rows each page returned, not by the limit: a server whose `maximum_page_limit`
 * is below 100 returns shorter pages, and stepping by 100 would skip the rest of each page and still
 * count the pass complete (spec §7.5 "Pagination and consistency", VC-11 open).
 *
 * Until a pass is complete the stored set is the previous set overlaid with the pages read so far
 * (`saveDags` upserts); a complete pass replaces it in one transaction (`replaceDags`), so deleted and
 * inactive DAGs drop out.
 *
 * @implements FR-COLL-01, FR-COLL-06, FR-COLL-08, FR-DAGX-08 (default team rule), HM-028 (import errors)
 */
import type { DagMeta, EnvironmentConfig } from '@dcam/domain';
import { BudgetExhaustedError, type Collector, type CollectorContext } from '../types';
import {
  assertSupportedAirflow,
  COMPOSER_DEFAULT_MAX_ACTIVE_RUNS_PER_DAG,
  COMPOSER_DEFAULT_MAX_ACTIVE_TASKS_PER_DAG,
  dagMetaOf,
} from './mapping';

/** `limit` of every `/dags` page (Appendix B.1: never above 100). */
const PAGE_SIZE = 100;
/** Version, import errors and eight pages: 800 DAGs per cycle at most. */
const MAX_REQUESTS = 10;
/** Appendix B.2: the version is read at connect and then daily. */
const VERSION_EVERY_MS = 24 * 60 * 60_000;

interface Pass {
  offset: number;
  total: number | null;
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

export function afInventoryCollector(): Collector {
  const passes = new Map<string, Pass>();
  const versionReadAt = new Map<string, number>();

  return {
    manifest: {
      id: 'af.inventory',
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowInventory',
      priority: 'background',
      maxRequestsPerCycle: MAX_REQUESTS,
      outputs: ['dags', 'health'],
      sourceKinds: ['composer', 'airflow'],
    },
    async collect(ctx) {
      const envId = ctx.env.id;
      const airflow = ctx.airflow();
      let requests = 0;
      let wrote = false;
      let stopped: string | null = null;

      try {
        const lastVersion = versionReadAt.get(envId);
        if (lastVersion === undefined || ctx.now() - lastVersion >= VERSION_EVERY_MS) {
          requests++;
          const { version } = await airflow.version();
          ctx.shared.airflowVersion = version;
          versionReadAt.set(envId, ctx.now());
        }
        assertSupportedAirflow(ctx.shared.airflowVersion);

        requests++;
        const importErrors = await airflow.importErrorCount();
        // A patch: mon.core writes the other inputs concurrently (HM-028).
        await ctx.store.patchPlatformHealth(envId, { importErrors });
        wrote = true;

        const pass = passes.get(envId) ?? { offset: 0, total: null, dags: new Map<string, DagMeta>() };
        passes.set(envId, pass);
        const defaults = await dagDefaults(ctx);
        try {
          while (pass.total === null || pass.offset < pass.total) {
            if (requests >= MAX_REQUESTS) {
              stopped = `The DAG inventory is read a few pages a cycle within the request budget; it continues next cycle at DAG ${pass.offset + 1} of ${pass.total ?? '?'}.`;
              break;
            }
            requests++;
            const page = await airflow.dags({ limit: PAGE_SIZE, offset: pass.offset });
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

      /** A complete pass replaces the stored set in one transaction; pages read so far are upserted. */
      async function saveDags(c: CollectorContext, pass: Pass, complete: boolean) {
        if (complete) {
          await c.store.replaceDags(envId, [...pass.dags.values()]);
          passes.delete(envId);
        } else await c.store.saveDags(envId, [...pass.dags.values()]);
      }
    },
  };
}
