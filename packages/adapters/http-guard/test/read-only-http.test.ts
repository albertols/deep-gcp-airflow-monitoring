import { describe, expect, it, vi } from 'vitest';
import { SourceError } from '@dcam/ports';
import { createGuardedClient, toReadOnlyHttp, type Transport } from '../src/index';

const AIRFLOW = 'https://abc123-dot-europe-west1.composer.googleusercontent.com';

function http(transport: Transport, defaults?: { timeoutMs?: number }) {
  return toReadOnlyHttp(createGuardedClient({ network: 'any', transport }), defaults);
}

function failing(error: unknown): Transport {
  return async () => {
    throw error;
  };
}

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('FR-AUTH-07 toReadOnlyHttp maps transport and guard failures to SourceError', () => {
  it('FR-AUTH-07: passes the response through', async () => {
    const res = await http(async () => new Response('{"a":1}', { status: 200 })).request({
      method: 'GET',
      url: `${AIRFLOW}/api/v1/version`,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"a":1}');
  });

  it('FR-AUTH-07: a timeout becomes SourceError timeout (transient)', async () => {
    const error: unknown = await http(() => new Promise(() => undefined))
      .request({ method: 'GET', url: `${AIRFLOW}/api/v1/version`, timeoutMs: 20 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ kind: 'timeout', transient: true });
  });

  it('FR-AUTH-07: the default timeout applies when a request sets none', async () => {
    const error: unknown = await http(() => new Promise(() => undefined), { timeoutMs: 20 })
      .request({ method: 'GET', url: `${AIRFLOW}/api/v1/version` })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'timeout' });
    expect((error as Error).message).toMatch(/20 ms/);
  });

  it.each([
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', /NODE_EXTRA_CA_CERTS/],
    ['SELF_SIGNED_CERT_IN_CHAIN', /NODE_EXTRA_CA_CERTS/],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /NODE_EXTRA_CA_CERTS/],
    ['CERT_HAS_EXPIRED', /clock|expired/i],
    ['ENOTFOUND', /HTTPS_PROXY/],
    ['ECONNREFUSED', /HTTPS_PROXY/],
  ])('FR-AUTH-07: %s becomes SourceError network with a fix hint', async (code, hint) => {
    const error: unknown = await http(
      failing(new TypeError('fetch failed', { cause: withCode(`${code} happened`, code) })),
    )
      .request({ method: 'GET', url: `${AIRFLOW}/api/v1/version` })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ kind: 'network', transient: true });
    expect((error as SourceError).message).toContain(code);
    expect((error as SourceError).details.fixHint).toMatch(hint);
  });

  it('FR-AUTH-07: a proxy authentication failure gets a proxy hint', async () => {
    const error: unknown = await http(
      failing(
        new TypeError('fetch failed', {
          cause: withCode('Proxy response (407) !== 200 when HTTP Tunneling', 'UND_ERR_ABORTED'),
        }),
      ),
    )
      .request({ method: 'GET', url: `${AIRFLOW}/api/v1/version` })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'network' });
    expect((error as SourceError).details.fixHint).toMatch(/HTTPS_PROXY.*credentials/);
  });

  it('FR-AUTH-07: a guard rejection becomes SourceError guard, never sent', async () => {
    const transport = vi.fn(async () => new Response('{}'));
    const error: unknown = await http(transport)
      .request({ method: 'GET', url: `${AIRFLOW}/api/v1/config` })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ kind: 'guard', transient: false });
    expect((error as Error).message).toMatch(/not-allowlisted/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('FR-AUTH-07: a redirect becomes SourceError guard', async () => {
    const error: unknown = await http(
      async () => new Response(null, { status: 302, headers: { location: '/x' } }),
    )
      .request({ method: 'GET', url: `${AIRFLOW}/api/v1/pools` })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'guard' });
  });

  it('FR-AUTH-07: programming errors such as an invalid timeout are not disguised', async () => {
    await expect(
      http(async () => new Response('{}')).request({
        method: 'GET',
        url: `${AIRFLOW}/api/v1/pools`,
        timeoutMs: -1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
