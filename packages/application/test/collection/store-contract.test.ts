import { describe, expect, it } from 'vitest';
import { MemoryStore } from './collectors-harness';
import { STORE_CONTRACT } from './store-contract';

// The same cases run against DuckDB in @dcam/duckdb-store (test/contract.test.ts).
describe('FR-COLL-03 the collector tests’ MemoryStore keeps the CollectionStore contract', () => {
  for (const c of STORE_CONTRACT) it(c.name, () => c.run(new MemoryStore(), expect));
});
