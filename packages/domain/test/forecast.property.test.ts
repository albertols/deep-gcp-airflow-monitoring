import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dagRunProfiles, percentile, type DemandTry } from '../src/index';

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5, 12, 0);

/** A run: tries as [queued offset, start delay, duration] in seconds from the run's planned start. */
const arbRun = fc.array(
  fc.tuple(
    fc.integer({ min: 0, max: 600 }),
    fc.integer({ min: 0, max: 120 }),
    fc.integer({ min: 1, max: 1_800 }),
  ),
  { minLength: 1, maxLength: 4 },
);

describe('dagRunProfiles properties (HM-010)', () => {
  it('HM-010: p10, p50 and p90 per minute equal type-7 percentiles of the runs’ own per-minute demand', () => {
    fc.assert(
      fc.property(fc.array(arbRun, { minLength: 1, maxLength: 30 }), (runs) => {
        const tries: DemandTry[] = runs.flatMap((run, r) =>
          run.map(([queued, delay, duration], i): DemandTry => {
            const queuedAt = NOW - (r + 1) * DAY + queued * 1000;
            return {
              dagId: 'acme_orders_daily',
              runId: `scheduled__${r}`,
              taskId: `task_${i}`,
              mapIndex: -1,
              tryNumber: 1,
              pool: 'default_pool',
              poolSlots: 1,
              queuedAt,
              startAt: queuedAt + delay * 1000,
              endAt: queuedAt + (delay + duration) * 1000,
            };
          }),
        );
        // Reference: each run's demand per minute since its first queued try, then sort-based percentiles.
        const perRun = runs.map((run) => {
          const start = Math.min(...run.map(([q]) => q * 1000));
          const minutes = new Array<number>(60).fill(0);
          for (const [q, d, len] of run) {
            const a = q * 1000 - start;
            const b = (q + d + len) * 1000 - start;
            for (let k = 0; k < 60; k++)
              minutes[k] =
                (minutes[k] ?? 0) + Math.max(0, Math.min(b, (k + 1) * MIN) - Math.max(a, k * MIN)) / MIN;
          }
          return minutes;
        });
        const profile = dagRunProfiles(tries, { readFrom: NOW - 60 * DAY }).get('acme_orders_daily');
        expect(profile?.runs).toBe(runs.length);
        const length = profile?.p50.length ?? 0;
        for (let k = 0; k < 60; k++) {
          const values = perRun.map((m) => m[k] ?? 0);
          const at = (band: Float64Array | undefined) => (k < length ? (band?.[k] ?? 0) : 0);
          expect(at(profile?.p10)).toBeCloseTo(percentile(values, 0.1) ?? 0, 9);
          expect(at(profile?.p50)).toBeCloseTo(percentile(values, 0.5) ?? 0, 9);
          expect(at(profile?.p90)).toBeCloseTo(percentile(values, 0.9) ?? 0, 9);
        }
      }),
      { numRuns: 200 },
    );
  });
});
