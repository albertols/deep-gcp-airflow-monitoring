import { describe, expect, it } from 'vitest';
import { readyWaitsSeconds } from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 11, 0, 0);
const t = (readyAt: number | null, queuedAt: number | null, startAt: number | null) => ({
  dagId: 'd',
  taskId: 't',
  runId: 'r',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: 'success',
  readyAt,
  queuedAt,
  startAt,
  endAt: startAt === null ? null : startAt + 60_000,
});

describe('HM-006 wait to start (ready → start)', () => {
  it('HM-006: measures every wait before a try runs, pre-queue and post-queue together', () => {
    expect(readyWaitsSeconds([t(T0, T0 + 240_000, T0 + 300_000)])).toEqual([300]);
  });

  it('HM-006: skips tries without a ready time (history older than live collection) or not started', () => {
    expect(readyWaitsSeconds([t(null, T0, T0 + 5_000), t(T0, null, null), t(T0 + 10_000, T0, T0)])).toEqual(
      [],
    );
  });
});
