import { defineConfig } from 'vitest/config';

/**
 * `pnpm emulator:test`: the opt-in integration test against the running Airflow 2.11.1 emulator
 * (tools/emulator, FR-EMU-02). Plain `vitest run` skips that file because DCAM_EMULATOR is unset.
 */
export default defineConfig({
  test: {
    include: ['test/emulator.integration.test.ts'],
    env: { DCAM_EMULATOR: '1' },
    // The emulator's DAGs produce task instances within minutes; tests poll until they appear.
    testTimeout: 600_000,
  },
});
