/**
 * `composer.config`: Composer `environments.get` → the environment's limits (`EnvironmentConfig`), the
 * Airflow web server URL and the image, which tells the Composer generation and Airflow version.
 *
 * Pools are not in the Composer API; `af.live` reads them from `/pools` and keeps them in the stored
 * configuration, so this collector carries them over (or takes them from the newest snapshot).
 *
 * @implements FR-COLL-01, FR-COLL-08, FR-COLL-09
 */
import type { PoolConfig } from '@dcam/domain';
import { SourceError } from '@dcam/ports';
import { BudgetExhaustedError, type Collector, type CollectorContext } from '../types';
import { assertSupportedAirflow, configFromComposer, parseImageVersion } from './mapping';

/** How far back a snapshot may be to seed the pools of a new configuration. */
const POOL_SEED_LOOKBACK_MS = 60 * 60_000;

async function knownPools(ctx: CollectorContext): Promise<PoolConfig[]> {
  const stored = await ctx.store.config(ctx.env.id);
  if (stored && stored.pools.length > 0) return [...stored.pools];
  const now = ctx.now();
  const latest = (await ctx.store.snapshots(ctx.env.id, now - POOL_SEED_LOOKBACK_MS, now + 1)).at(-1);
  return latest ? latest.pools.map((p) => ({ name: p.name, slots: p.slots })) : [];
}

export function composerConfigCollector(): Collector {
  return {
    manifest: {
      id: 'composer.config',
      source: 'SRC-COMPOSER',
      api: 'composer',
      cadence: 'composer',
      priority: 'standard',
      maxRequestsPerCycle: 1,
      outputs: ['config'],
      sourceKinds: ['composer'],
    },
    async collect(ctx) {
      const source = ctx.env.source;
      if (source.kind !== 'composer' || !ctx.composer)
        throw new SourceError('unsupported', 'composer.config reads Composer environments only.');
      let env;
      try {
        env = await ctx.composer.environment({
          projectId: source.projectId,
          location: source.location,
          environment: source.environment,
        });
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
        ctx.reducedFidelity(
          'The Composer request budget is used up; the configuration is refreshed next cycle.',
        );
        return { dataAsOf: null };
      }

      const image = env.imageVersion === null ? null : parseImageVersion(env.imageVersion);
      // The bare `airflowUri`: the Airflow adapter appends `/api/v1` itself.
      if (env.airflowUri !== null) ctx.shared.airflowBaseUrl = env.airflowUri;
      ctx.shared.imageVersion = env.imageVersion;
      // `GET /version` (af.inventory) is authoritative; the image fills in until it has run.
      if (image && ctx.shared.airflowVersion === null) ctx.shared.airflowVersion = image.airflowVersion;

      if (image && image.generation < 2)
        throw new SourceError('unsupported', 'Composer 1 environments are not supported', {
          fixHint: 'DCAM reads Composer 2 and Composer 3 environments.',
        });
      assertSupportedAirflow(ctx.shared.airflowVersion);

      const airflowVersion = ctx.shared.airflowVersion ?? image?.airflowVersion ?? 'unknown';
      await ctx.store.saveConfig(
        ctx.env.id,
        configFromComposer(ctx.env, env, await knownPools(ctx), airflowVersion),
      );
      return { dataAsOf: ctx.now() };
    },
  };
}
