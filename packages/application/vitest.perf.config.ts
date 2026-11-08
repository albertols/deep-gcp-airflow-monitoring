import { defineConfig } from 'vitest/config';

/**
 * `pnpm --filter @dcam/application test:perf`: the opt-in NFR-PERF-01 benchmark (7 days at 2,000 DAGs;
 * add DCAM_PERF_LONG=1 for 30 and 90 days). Plain `vitest run` skips it because DCAM_PERF is unset.
 */
export default defineConfig({
  test: {
    include: ['test/long-range.perf.test.ts'],
    env: { DCAM_PERF: '1' },
    // Generating 90 days of tries takes minutes on a laptop; the use cases themselves are timed.
    testTimeout: 1_200_000,
  },
});
