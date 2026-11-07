import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemSleeper } from '../src/live/sleeper';

afterEach(() => {
  vi.useRealTimers();
});

describe('system sleeper (FR-COLL-02)', () => {
  it('FR-COLL-02: resolves after the delay', async () => {
    vi.useFakeTimers();
    let done = false;
    const sleeping = systemSleeper.sleep(30_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });

  it('FR-COLL-02: resolves early, without throwing, when the signal aborts', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let done = false;
    const sleeping = systemSleeper.sleep(3_600_000, abort.signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    abort.abort();
    await sleeping;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('FR-COLL-02: an aborted signal resolves at once', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(systemSleeper.sleep(3_600_000, abort.signal)).resolves.toBeUndefined();
  });

  it('FR-COLL-02: a delay beyond the timer maximum waits instead of firing at once', async () => {
    vi.useFakeTimers();
    let done = false;
    const sleeping = systemSleeper.sleep(2 ** 31 + 5_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(5_001);
    await sleeping;
    expect(done).toBe(true);
  });
});
