import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createDcamApi, createQueryClient, shouldRetry } from '../src/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ type: 'about:blank', title: 'x', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

describe('FR-UI-07 errors and retries', () => {
  it('FR-UI-07: an API error carries its HTTP status and the problem detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem(404, 'No DAG "x" is known in environment "acme-emulator".')),
    );
    const error = await createDcamApi('http://127.0.0.1:8787')
      .getDagDetail('acme-emulator', 'x', '24h')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: expect.stringMatching(/^No DAG "x"/) });
  });

  it('FR-UI-07: a 4xx answer is final; only server errors and network failures are retried', () => {
    expect(shouldRetry(0, new ApiError('Unknown DAG', 404))).toBe(false);
    expect(shouldRetry(0, new ApiError('Invalid range', 400))).toBe(false);
    expect(shouldRetry(0, new ApiError('Unavailable', 503))).toBe(true);
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(3, new ApiError('Unavailable', 503))).toBe(false);
  });

  it('FR-UI-07: the app’s query client uses that retry rule', () => {
    expect(createQueryClient().getDefaultOptions().queries?.retry).toBe(shouldRetry);
  });
});
