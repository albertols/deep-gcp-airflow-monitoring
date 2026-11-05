import { describe, expect, it, vi } from 'vitest';
import { TransportError, createGuardedClient, type ResponseEvent } from '../src/index';

const AIRFLOW = 'https://abc123-dot-europe-west1.composer.googleusercontent.com';

/** A clock that advances by `step` milliseconds on every read. */
function steppingClock(start: number, step: number) {
  let t = start - step;
  return () => (t += step);
}

describe('HM-030 observer footprint: every request that reaches the transport is recorded', () => {
  it('HM-030: records time, method, entry, service, status, latency, bytes and outcome', async () => {
    const events: ResponseEvent[] = [];
    const client = createGuardedClient({
      network: 'any',
      transport: async () => new Response('{"version":"2.11.1"}', { status: 200 }),
      now: steppingClock(1_700_000_000_000, 40),
      onResponse: (e) => events.push(e),
    });
    const response = await client.request({
      method: 'GET',
      url: `${AIRFLOW}/api/v1/dags?limit=100&offset=0`,
    });
    expect(await response.text()).toBe('{"version":"2.11.1"}');
    expect(events).toEqual([
      {
        at: 1_700_000_000_000,
        method: 'GET',
        entryId: 'airflow.v1.dags',
        service: 'airflow',
        status: 200,
        latencyMs: 40,
        bytes: 20,
        outcome: 'ok',
      },
    ]);
  });

  it('HM-030: counts body bytes, not characters, and marks HTTP errors', async () => {
    const events: ResponseEvent[] = [];
    const client = createGuardedClient({
      network: 'any',
      transport: async () => new Response('{"detail":"Zürich"}', { status: 403 }),
      onResponse: (e) => events.push(e),
    });
    const response = await client.request({
      method: 'GET',
      url: 'https://monitoring.googleapis.com/v3/projects/acme-prod-123/timeSeries?filter=x',
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('{"detail":"Zürich"}');
    expect(events).toMatchObject([
      { entryId: 'monitoring.read', service: 'monitoring', status: 403, bytes: 20, outcome: 'http-error' },
    ]);
  });

  it('HM-030: events never carry URLs, query strings, headers or tokens', async () => {
    const events: ResponseEvent[] = [];
    const client = createGuardedClient({
      network: 'any',
      transport: async () => new Response('{}', { status: 200, headers: { 'set-cookie': 'acme=1' } }),
      onResponse: (e) => events.push(e),
    });
    await client.request({
      method: 'GET',
      url: 'https://monitoring.googleapis.com/v3/projects/acme-prod-123/timeSeries?filter=acme_secret_filter',
      headers: { authorization: 'Bearer acme-token-value', 'x-goog-user-project': 'acme-prod-123' },
    });
    const text = JSON.stringify(events);
    for (const leak of [
      'acme_secret_filter',
      'acme-token-value',
      'Bearer',
      'acme-prod-123',
      'cookie',
      'https:',
    ])
      expect(text).not.toContain(leak);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(
      ['at', 'bytes', 'entryId', 'latencyMs', 'method', 'outcome', 'service', 'status'].sort(),
    );
  });

  it('HM-030: records a transport failure with status null and outcome network', async () => {
    const events: ResponseEvent[] = [];
    const client = createGuardedClient({
      network: 'any',
      transport: async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:3128'), { code: 'ECONNREFUSED' }),
        });
      },
      onResponse: (e) => events.push(e),
    });
    const error: unknown = await client
      .request({ method: 'GET', url: `${AIRFLOW}/api/v1/pools` })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: 'network', code: 'ECONNREFUSED' });
    expect((error as Error).message).toContain('ECONNREFUSED');
    expect(events).toMatchObject([
      { entryId: 'airflow.v1.pools', service: 'airflow', status: null, bytes: 0, outcome: 'network' },
    ]);
  });

  it('HM-030: records redirects (they reached the transport) and still rejects them', async () => {
    const events: ResponseEvent[] = [];
    const client = createGuardedClient({
      network: 'any',
      transport: async () => new Response(null, { status: 302, headers: { location: '/api/v1/config' } }),
      onResponse: (e) => events.push(e),
    });
    await expect(client.request({ method: 'GET', url: `${AIRFLOW}/api/v1/pools` })).rejects.toMatchObject({
      name: 'GuardError',
      code: 'redirect',
    });
    expect(events).toMatchObject([{ status: 302, outcome: 'http-error' }]);
  });

  it('HM-030: requests rejected by the guard never reach the transport and are not recorded', async () => {
    const onResponse = vi.fn();
    const transport = vi.fn(async () => new Response('{}'));
    const client = createGuardedClient({ network: 'any', transport, onResponse });
    await expect(client.request({ method: 'GET', url: `${AIRFLOW}/api/v1/config` })).rejects.toMatchObject({
      code: 'not-allowlisted',
    });
    expect(transport).not.toHaveBeenCalled();
    expect(onResponse).not.toHaveBeenCalled();
  });

  it('HM-030: a failing footprint recorder never fails the request', async () => {
    const client = createGuardedClient({
      network: 'any',
      transport: async () => new Response('{}'),
      onResponse: () => {
        throw new Error('recorder bug');
      },
    });
    const response = await client.request({ method: 'GET', url: `${AIRFLOW}/api/v1/version` });
    expect(response.status).toBe(200);
  });

  it('HM-030: a 204 response is recorded with zero bytes and returned without a body', async () => {
    const events: ResponseEvent[] = [];
    const client = createGuardedClient({
      network: 'any',
      transport: async () => new Response(null, { status: 204 }),
      onResponse: (e) => events.push(e),
    });
    const response = await client.request({ method: 'GET', url: `${AIRFLOW}/api/v1/health` });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(events).toMatchObject([{ status: 204, bytes: 0, outcome: 'ok' }]);
  });
});

describe('FR-AUTH-07 per-request timeout', () => {
  it('FR-AUTH-07: aborts after timeoutMs with a timeout TransportError, even if the transport ignores the signal', async () => {
    const events: ResponseEvent[] = [];
    let seenSignal: AbortSignal | undefined;
    const client = createGuardedClient({
      network: 'any',
      transport: (_url, init) => {
        seenSignal = init.signal;
        return new Promise<Response>(() => undefined);
      },
      onResponse: (e) => events.push(e),
    });
    const error: unknown = await client
      .request({ method: 'GET', url: `${AIRFLOW}/api/v1/health`, timeoutMs: 50 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: 'timeout' });
    expect((error as Error).message).toMatch(/50 ms/);
    expect(seenSignal?.aborted).toBe(true);
    expect(events).toMatchObject([{ status: null, outcome: 'timeout' }]);
  });

  it('FR-AUTH-07: the timeout also covers reading the body', async () => {
    const client = createGuardedClient({
      network: 'any',
      transport: async () => ({
        status: 200,
        headers: new Headers(),
        arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined),
        body: null,
      }),
    });
    await expect(
      client.request({ method: 'GET', url: `${AIRFLOW}/api/v1/health`, timeoutMs: 50 }),
    ).rejects.toMatchObject({ name: 'TransportError', kind: 'timeout' });
  });

  it('FR-AUTH-07: uses the client default timeout, 30 s unless set', async () => {
    vi.useFakeTimers();
    try {
      const client = createGuardedClient({ network: 'any', transport: () => new Promise(() => undefined) });
      const pending = client
        .request({ method: 'GET', url: `${AIRFLOW}/api/v1/health` })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(29_999);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ kind: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('FR-AUTH-07: rejects a timeout that is not a positive number before any I/O', async () => {
    const transport = vi.fn(async () => new Response('{}'));
    const client = createGuardedClient({ network: 'any', transport });
    // Node.js timers fire at once above 2^31 − 1 ms, so those values are refused too.
    expect(() => createGuardedClient({ network: 'any', transport, timeoutMs: 2 ** 31 })).toThrow(RangeError);
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await expect(
        client.request({ method: 'GET', url: `${AIRFLOW}/api/v1/health`, timeoutMs }),
      ).rejects.toBeInstanceOf(RangeError);
    }
    expect(transport).not.toHaveBeenCalled();
  });
});
