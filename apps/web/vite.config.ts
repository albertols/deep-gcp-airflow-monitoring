import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // ARCH-EMB-02: never assume the UI is served at "/" when embedded later; relative asset URLs.
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // Page tests render whole MUI pages in jsdom; allow for loaded CI runners.
    testTimeout: 20_000,
  },
});
