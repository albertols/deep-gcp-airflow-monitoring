/**
 * The system sleeper the collection engine waits with between cycles and for budget tokens.
 *
 * @implements FR-COLL-02
 */
import type { Sleeper } from '@dcam/ports';

/** Largest delay `setTimeout` honours; longer ones fire at once with a `TimeoutOverflowWarning`. */
const MAX_TIMER_MS = 2_147_483_647;

export const systemSleeper: Sleeper = {
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      const until = Date.now() + Math.max(0, ms);
      const arm = () => {
        const left = until - Date.now();
        if (left <= 0) return done();
        timer = setTimeout(left > MAX_TIMER_MS ? arm : done, Math.min(left, MAX_TIMER_MS));
      };
      signal?.addEventListener('abort', done);
      arm();
    });
  },
};
