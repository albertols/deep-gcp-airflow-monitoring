import { describe, expect, it } from 'vitest';
// The contract lives beside the collector tests' in-memory store, which runs the same cases.
import { STORE_CONTRACT } from '../../../application/test/collection/store-contract';
import { openStore } from '../src/index';

// Real DuckDB I/O on a shared 4-vCPU runner: Vitest's default 5 s is too tight (see store.test.ts).
describe('FR-COLL-03 DuckDbStore keeps the CollectionStore contract', { timeout: 60_000 }, () => {
  for (const c of STORE_CONTRACT)
    it(c.name, async () => {
      const store = await openStore({ path: ':memory:' });
      try {
        await c.run(store, expect);
      } finally {
        store.close();
      }
    });
});
