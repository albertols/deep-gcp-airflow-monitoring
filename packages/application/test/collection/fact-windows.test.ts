import { describe, expect, it } from 'vitest';
import { FactWindowReader, type FactWindowReaderOptions } from '../../src/collection/collectors/fact-windows';
import { Budget, FakeAirflow, H, MIN, T0, ti } from './collectors-harness';

const ENV = 'acme-prod';
const FROM = T0 - 24 * H;
const TO = T0;

const spread = (n: number, from: number, to: number) =>
  Array.from({ length: n }, (_, i) => {
    const at = from + Math.floor(((to - from) * (i + 0.5)) / n);
    return ti({ taskId: `t_${i}`, startAt: at - MIN, endAt: at, updatedAt: at });
  });

const backward = (over: Partial<FactWindowReaderOptions> = {}) =>
  new FactWindowReader({
    direction: 'backward',
    maxRequests: 20,
    laterReserve: 2,
    history: 'task instance backfill',
    ...over,
  });

/** Reads cycles until the reader reaches `FROM` (or `cycles` run out); returns every result. */
async function drain(reader: FactWindowReader, airflow: FakeAirflow, cycles = 50) {
  const results = [];
  const stored = new Map<string, unknown>();
  for (let i = 0; i < cycles && reader.pending.length > 0; i++) {
    const r = await reader.read(airflow, ENV);
    for (const [k, v] of r.rows) stored.set(k, v);
    results.push(r);
    if (r.error !== null) throw r.error instanceof Error ? r.error : new Error('the reader failed');
  }
  return { results, stored };
}

describe('FR-COLL-04 the fact window reader, newest first (backfill)', () => {
  it('FR-COLL-04: reads a window newest first, splitting until each request fits, and covers it without gaps', async () => {
    const tis = spread(1_000, FROM, TO);
    const airflow = new FakeAirflow({ tis });
    const reader = backward();
    reader.reset([{ from: FROM, to: TO }]);
    const { results, stored } = await drain(reader, airflow);

    expect(stored.size).toBe(1_000);
    expect(results.at(-1)?.reached).toBe(FROM);
    // Covered from moves back only, and the first rows accepted are the newest.
    const reached = results.map((r) => r.reached);
    for (let i = 1; i < reached.length; i++) expect(reached[i]).toBeLessThanOrEqual(reached[i - 1] as number);
    const firstAccepted = airflow.tiQueries.find((q, i) => i > 0 && q.offset === 0);
    expect(firstAccepted?.updatedTo).toBe(TO);
    // Every request is one page of 100 at offset 0 (B.3), and every request window lies inside [FROM, TO].
    expect(airflow.tiQueries.every((q) => q.limit === 100 && q.offset === 0)).toBe(true);
    expect(airflow.tiQueries.every((q) => (q.updatedFrom ?? 0) >= FROM && (q.updatedTo ?? 0) <= TO)).toBe(
      true,
    );
  });

  it('FR-COLL-04: knows how many rows are left once the remaining window was counted', async () => {
    const airflow = new FakeAirflow({ tis: spread(1_000, FROM, TO) });
    const reader = backward({ maxRequests: 1 });
    reader.reset([{ from: FROM, to: TO }]);
    expect(reader.remaining()).toBeNull();
    await reader.read(airflow, ENV);
    expect(reader.remaining()).toBe(1_000);
    const r = await reader.read(airflow, ENV);
    expect(reader.remaining()).toBe(1_000 - r.rows.size);
  });

  it('FR-COLL-06: a dense second is paged by offset across cycles; covered from waits at it while older rows are stored', async () => {
    const burst = T0 - 12 * H;
    const dense = Array.from({ length: 450 }, (_, i) =>
      ti({ taskId: 'mapped', mapIndex: i, state: 'skipped', updatedAt: burst }),
    );
    const older = ti({ taskId: 'older', updatedAt: burst - H });
    const airflow = new FakeAirflow({ tis: [...spread(200, FROM, TO), ...dense, older] });
    const reader = backward({ maxRequests: 4, laterReserve: 2 });
    reader.reset([{ from: FROM, to: TO }]);
    const { results, stored } = await drain(reader, airflow, 100);
    expect(stored.size).toBe(200 + 450 + 1);
    expect(results.at(-1)?.reached).toBe(FROM);
    const before = results.findIndex((r) => [...r.rows.keys()].some((k) => k.includes('older')));
    const denseDone = results.findIndex((r) => r.rows.size >= 450);
    // The older row was stored before the dense second was complete, and covered from never passed it.
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThan(denseDone);
    for (const r of results.slice(0, denseDone)) expect(r.reached).toBeGreaterThanOrEqual(burst);
    expect(results.some((r) => r.notes.some((n) => /task instance backfill is stuck at/.test(n)))).toBe(true);
  });

  it('FR-COLL-06: an exhausted budget returns the complete windows read so far and stops', async () => {
    const airflow = new FakeAirflow({ tis: spread(1_000, FROM, TO) }, new Budget('airflow', 4));
    const reader = backward();
    reader.reset([{ from: FROM, to: TO }]);
    const r = await reader.read(airflow, ENV);
    expect(r.stop).toBe('budget');
    expect(r.requests).toBe(4);
    expect(r.reached).toBeLessThan(TO);
    // Exactly the rows in [reached, TO] were returned.
    const expected = airflow.data.tis.filter((t) => t.updatedAt >= r.reached).length;
    expect(r.rows.size).toBe(expected);
  });

  it('FR-COLL-04: sizing parts by the density of the last window read takes fewer requests on uneven history', async () => {
    // A day whose busy hours (8 h) have 9 times the rows of its quiet hours.
    const busy = spread(3_600, T0 - 8 * H, TO);
    const quiet = spread(800, FROM, T0 - 8 * H).map((t, i) => ({ ...t, taskId: `q_${i}` }));
    const requestsWith = async (adaptive: boolean) => {
      const airflow = new FakeAirflow({ tis: [...busy, ...quiet] });
      const reader = backward({ adaptive });
      reader.reset([{ from: FROM, to: TO }]);
      const { stored } = await drain(reader, airflow, 200);
      expect(stored.size).toBe(4_400);
      return airflow.tiQueries.length;
    };
    const fixed = await requestsWith(false);
    const adaptive = await requestsWith(true);
    // Measured: 75 requests by the average density, 59 by the local one (about 75 rows a request).
    expect(adaptive).toBeLessThan(fixed * 0.85);
    // About 80 rows a request at best (a part aims at 80 % of a page).
    expect(adaptive).toBeLessThan((4_400 / 80) * 1.35);
  });
});

describe('FR-COLL-06 the fact window reader, oldest first (live facts)', () => {
  it('FR-COLL-06: reads oldest first and reaches the end of the last complete window', async () => {
    const airflow = new FakeAirflow({ tis: spread(350, T0 - H, T0) });
    const reader = new FactWindowReader({
      direction: 'forward',
      maxRequests: 6,
      laterReserve: 2,
      history: 'finished task instance history',
    });
    reader.reset([{ from: T0 - H, to: T0 }]);
    const { results, stored } = await drain(reader, airflow);
    expect(stored.size).toBe(350);
    expect(results.at(-1)?.reached).toBe(T0);
    const reached = results.map((r) => r.reached);
    for (let i = 1; i < reached.length; i++)
      expect(reached[i]).toBeGreaterThanOrEqual(reached[i - 1] as number);
  });
});

describe('FR-COLL-06 page caps below 100 (spec §7.5, VC-11 open)', () => {
  it('FR-COLL-06: a cap is learned when two short pages agree, so a capped server still completes', async () => {
    const airflow = new FakeAirflow({ tis: spread(300, FROM, TO) });
    airflow.pageCap = 40;
    const reader = backward();
    reader.reset([{ from: FROM, to: TO }]);
    const { stored, results } = await drain(reader, airflow, 100);
    expect(stored.size).toBe(300);
    expect(results.at(-1)?.reached).toBe(FROM);
  });

  it('FR-COLL-06: a window with fewer rows than 100 but more than the server returns is halved, never read twice in a row', async () => {
    const airflow = new FakeAirflow({ tis: spread(80, FROM, TO) });
    airflow.pageCap = 50;
    const reader = backward();
    reader.reset([{ from: FROM, to: TO }]);
    const { stored } = await drain(reader, airflow, 10);
    expect(stored.size).toBe(80);
    const windows = airflow.tiQueries.map((q) => `${q.updatedFrom}-${q.updatedTo}-${q.offset}`);
    for (let i = 1; i < windows.length; i++) expect(windows[i]).not.toBe(windows[i - 1]);
  });

  it('FR-COLL-06: one short page (a count and select race) teaches no cap, so windows are not cut to it', async () => {
    /** Returns one row fewer than it counted, once: what a row leaving the window between count and select does. */
    class RacyAirflow extends FakeAirflow {
      raced = false;
      override async taskInstances(q: Parameters<FakeAirflow['taskInstances']>[0]) {
        const page = await super.taskInstances(q);
        if (this.raced || page.total < 2 || page.items.length !== page.total) return page;
        this.raced = true;
        return { items: page.items.slice(0, 1), total: page.total };
      }
    }
    const airflow = new RacyAirflow({ tis: spread(600, FROM, TO) });
    const reader = backward();
    reader.reset([{ from: FROM, to: TO }]);
    const { stored } = await drain(reader, airflow, 100);
    expect(stored.size).toBe(600);
    // Parts stay sized for pages of 100: a learned cap of 1 would cut every window to the 1 s minimum.
    expect(reader.pageRows()).toBe(100);
    expect(airflow.tiQueries.length).toBeLessThan(30);
  });

  it('FR-COLL-06: a full page forgets a learned cap', async () => {
    const airflow = new FakeAirflow({ tis: spread(300, FROM, TO) });
    airflow.pageCap = 40;
    const reader = backward({ maxRequests: 6 });
    reader.reset([{ from: FROM, to: TO }]);
    await drain(reader, airflow, 3);
    expect(reader.pageRows()).toBe(40);
    // The server's cap is lifted (a new Composer build): the next uncounted window comes back as a full page.
    airflow.pageCap = Number.POSITIVE_INFINITY;
    reader.reset([{ from: FROM, to: TO }]);
    await reader.read(airflow, ENV);
    expect(reader.pageRows()).toBe(100);
  });
});
