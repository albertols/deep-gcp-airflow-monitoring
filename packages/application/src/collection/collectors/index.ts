/**
 * The M1 collectors (feature 002). The orchestrator passes {@link createCollectors} to the engine.
 * Collectors keep small per-environment state in memory (paging positions), so create one set per
 * engine.
 *
 * @implements FR-COLL-01
 */
import type { Collector } from '../types';
import { afFactsCollector } from './af-facts';
import { afInventoryCollector } from './af-inventory';
import { afLiveCollector } from './af-live';
import { composerConfigCollector } from './composer-config';
import { monCoreCollector } from './mon-core';

export {
  afFactsCollector,
  FACT_STATES,
  FACTS_OVERLAP_MS,
  FACTS_SETTLE_MS,
  FIRST_FACTS_WINDOW_MS,
} from './af-facts';
export { afInventoryCollector } from './af-inventory';
export { afLiveCollector } from './af-live';
export { composerConfigCollector } from './composer-config';
export {
  monCoreCollector,
  targetWorkers,
  workerTypeOf,
  MON_DB_INGESTION_DELAY_MS,
  MON_INGESTION_DELAY_MS,
  MON_TRAILING_MS,
} from './mon-core';
export {
  parseImageVersion,
  teamOf,
  dagMetaOf,
  configFromComposer,
  configFromLimits,
  COMPOSER_DEFAULT_MAX_ACTIVE_RUNS_PER_DAG,
  COMPOSER_DEFAULT_MAX_ACTIVE_TASKS_PER_DAG,
  CATCHUP_BY_DEFAULT,
  type ImageVersion,
} from './mapping';

export function createCollectors(): readonly Collector[] {
  return [
    composerConfigCollector(),
    afInventoryCollector(),
    afLiveCollector(),
    afFactsCollector(),
    monCoreCollector(),
  ];
}
