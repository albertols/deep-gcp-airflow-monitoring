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

describe('FR-DAGD-08 / FR-DAGD-09 comparison calls', () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const urlOf = (call: unknown[] | undefined) => new URL((call?.[0] as Request).url);

  it('FR-DAGD-08: compares DAGs with the env:dag list and the range', async () => {
    const fetchMock = vi.fn(async (_request: Request) => ok({ dags: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await createDcamApi('http://127.0.0.1:8787').getDagComparison(
      'acme-prod:orders_daily,acme-test:orders_daily',
      '7d',
    );
    const url = urlOf(fetchMock.mock.calls[0]);
    expect(url.pathname).toBe('/api/v1/compare/dags');
    expect(url.searchParams.get('dags')).toBe('acme-prod:orders_daily,acme-test:orders_daily');
    expect(url.searchParams.get('range')).toBe('7d');
  });

  it('FR-DAGD-09: compares run b with run a of one DAG over the range', async () => {
    const fetchMock = vi.fn(async (_request: Request) => ok({ tasks: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await createDcamApi('http://127.0.0.1:8787').getRunComparison(
      'acme-prod',
      'orders_daily',
      'scheduled__2026-11-05T10:00:00+00:00',
      'scheduled__2026-11-05T11:00:00+00:00',
      '24h',
    );
    const url = urlOf(fetchMock.mock.calls[0]);
    expect(url.pathname).toBe('/api/v1/environments/acme-prod/dags/orders_daily/runs/compare');
    expect(url.searchParams.get('a')).toBe('scheduled__2026-11-05T10:00:00+00:00');
    expect(url.searchParams.get('b')).toBe('scheduled__2026-11-05T11:00:00+00:00');
    expect(url.searchParams.get('range')).toBe('24h');
  });
});
