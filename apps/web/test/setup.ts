import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without globals, so Testing Library cannot register its automatic cleanup.
afterEach(cleanup);

// jsdom rendering of MUI pages is slow on loaded CI runners (every package tests in parallel);
// give findBy* queries more than the 1 s default.
configure({ asyncUtilTimeout: 5_000 });
