import { describe, expect, it } from 'vitest';
import { afBackfillCollector, afFactsCollector, FACTS_SETTLE_MS } from '../../src/index';
import { fakeContext, FakeAirflow, H, MemoryStore, MIN, storeKey, T0, ti } from './collectors-harness';

const ENV = 'acme-prod';
const shared = { airflowBaseUrl: 'https://acme-composer-prod.example.test', airflowVersion: '2.11.1' };
/** af.facts' first window end at T0, and so the backfill's boundary. */
const A = T0 - FACTS_SETTLE_MS;
const BURST = A - 20 * MIN;
const DENSE = 1_500;
const CAP = 50;

/** Returns one row of a page it counted whole, once: what a row leaving the window between count and select does. */
class RacyAirflow extends FakeAirflow {
  raced = false;
  override async taskInstances(q: Parameters<FakeAirflow['taskInstances']>[0]) {
    const page = await super.taskInstances(q);
    if (this.raced || page.total < 2 || page.items.length !== page.total) return page;
    this.raced = true;
    return { items: page.items.slice(0, 1), total: page.total };
  }
}

/** Finished task instances in af.facts' first window: a steady flow, and 1,500 mapped tasks marked in one second. */
const scenario = () => {
  const steady = Array.from({ length: 300 }, (_, i) => {
    const at = A - H + MIN + Math.floor(((H - 2 * MIN) * i) / 300);
    return ti({ taskId: `t_${i}`, startAt: at - MIN, endAt: at, updatedAt: at });
  });
  const dense = Array.from({ length: DENSE }, (_, i) =>
    ti({ taskId: 'mapped', mapIndex: i, state: 'skipped', updatedAt: BURST }),
  );
  const airflow = new RacyAirflow({ tis: [...steady, ...dense] });
  airflow.pageCap = CAP;
  return airflow;
};

const sorted = (store: MemoryStore) => [...store.tries.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

describe('FR-COLL-06 one set of window rules for af.facts and af.backfill (fact-windows.ts)', () => {
  it('FR-COLL-06: a race, a dense second of 1,500 rows and a page cap of 50 store the same rows through both collectors', async () => {
    // af.facts: its first window [A − 1 h, A] holds every row; later cycles read the minutes after A.
    const live = scenario();
    const facts = new MemoryStore();
    const factsCtx = fakeContext({ airflow: live, store: facts, shared });
    const factsCollector = afFactsCollector();
    for (let i = 0; i < 40 && ((await facts.watermark(ENV, 'af.facts')) ?? 0) < A; i++) {
      await factsCollector.collect(factsCtx);
      factsCtx.advance(MIN);
    }
    expect(await facts.watermark(ENV, 'af.facts')).toBeGreaterThanOrEqual(A);

    // af.backfill: [A − 7 days, A] newest first, once af.facts has committed A.
    const history = scenario();
    const backfilled = new MemoryStore();
    await backfilled.commitFacts(ENV, 'af.facts', [], A);
    const backfillCtx = fakeContext({ airflow: history, store: backfilled, shared });
    const backfillCollector = afBackfillCollector();
    for (let i = 0; i < 40 && backfillCtx.reports.at(-1)?.state !== 'complete'; i++) {
      await backfillCollector.collect(backfillCtx);
      backfillCtx.advance(MIN);
    }
    expect(backfillCtx.reports.at(-1)?.state).toBe('complete');

    // Both met the race and paged the dense second by the server's page of 50.
    for (const airflow of [live, history]) {
      expect(airflow.raced).toBe(true);
      const offsets = airflow.tiQueries.filter((q) => q.offset > 0).map((q) => q.offset);
      expect(offsets.length).toBeGreaterThanOrEqual(DENSE / CAP - 1);
      expect(offsets.every((o) => o % CAP === 0)).toBe(true);
    }
    const expected = new Set(live.data.tis.map((t) => storeKey(ENV, t)));
    expect(new Set(facts.tries.keys())).toEqual(expected);
    expect(sorted(backfilled)).toEqual(sorted(facts));
    // Nothing was kept partially by either.
    for (const fidelity of [factsCtx.fidelity, backfillCtx.fidelity])
      expect(fidelity.filter((f) => /missing from the history/.test(f))).toEqual([]);
  });
});
