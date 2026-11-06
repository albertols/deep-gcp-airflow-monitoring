/**
 * The proxy rules of the transport as a pure function (FR-AUTH-07): `proxyRoute` and
 * `readProxyEnvironment` read the variables exactly as `createNetworkTransport` does, so the doctor's
 * evidence matches what DCAM really sends. transport.test.ts checks that they agree on real sockets.
 */
import { describe, expect, it } from 'vitest';
import { proxyRoute, readProxyEnvironment } from '../src/index';

const COMPOSER = 'https://composer.googleapis.com/v1/projects/acme-prod-123';
const AIRFLOW = 'https://acme-dot-europe-west1.composer.googleusercontent.com/api/v1/health';
const EMULATOR = 'http://127.0.0.1:8080/api/v1/health';
const any = { loopbackOnly: false };

describe('FR-AUTH-07 proxyRoute', () => {
  it('FR-AUTH-07: HTTPS uses the HTTPS proxy, else the HTTP proxy; HTTP uses only the HTTP proxy', () => {
    const both = {
      HTTPS_PROXY: 'http://tls.acme.example:3128',
      HTTP_PROXY: 'http://plain.acme.example:3128',
    };
    expect(proxyRoute(both, COMPOSER, any)).toEqual({
      via: 'proxy',
      proxy: 'tls.acme.example:3128',
      variable: 'HTTPS_PROXY',
    });
    expect(proxyRoute({ HTTP_PROXY: 'http://plain.acme.example:3128' }, COMPOSER, any)).toMatchObject({
      via: 'proxy',
      variable: 'HTTP_PROXY',
    });
    expect(proxyRoute({ HTTPS_PROXY: 'http://tls.acme.example:3128' }, 'http://acme.example/', any)).toEqual({
      via: 'direct',
    });
    expect(proxyRoute({}, COMPOSER, any)).toEqual({ via: 'direct' });
  });

  it('FR-AUTH-07: a value without a scheme means http://, as the transport reads it', () => {
    const env = { HTTPS_PROXY: 'proxy.acme.example:3128' };
    expect(proxyRoute(env, COMPOSER, any)).toMatchObject({ via: 'proxy', proxy: 'proxy.acme.example:3128' });
    expect(readProxyEnvironment(env, any).https).toMatchObject({
      variable: 'HTTPS_PROXY',
      url: 'http://proxy.acme.example:3128',
      schemeAdded: true,
    });
  });

  it('FR-AUTH-07: an empty lower-case variable does not hide the upper-case one', () => {
    const env = { https_proxy: '', HTTPS_PROXY: 'http://proxy.acme.example:3128', no_proxy: ' ' };
    expect(proxyRoute(env, COMPOSER, any)).toMatchObject({ via: 'proxy', variable: 'HTTPS_PROXY' });
    expect(readProxyEnvironment(env, any)).toMatchObject({ noProxy: null, shadowed: [] });
  });

  it('FR-AUTH-07: the lower-case variable wins, and the upper-case one it hides is reported', () => {
    const env = { https_proxy: 'http://a.acme.example:3128', HTTPS_PROXY: 'http://b.acme.example:3128' };
    expect(proxyRoute(env, COMPOSER, any)).toMatchObject({ proxy: 'a.acme.example:3128' });
    expect(readProxyEnvironment(env, any).shadowed).toEqual([
      { used: 'https_proxy', ignored: 'HTTPS_PROXY' },
    ]);
    const same = { https_proxy: 'http://a.acme.example:3128', HTTPS_PROXY: 'http://a.acme.example:3128' };
    expect(readProxyEnvironment(same, any).shadowed).toEqual([]);
  });

  it('FR-AUTH-07: a remote proxy is never used for loopback targets, even without NO_PROXY', () => {
    const env = {
      HTTP_PROXY: 'http://proxy.acme.example:3128',
      HTTPS_PROXY: 'http://proxy.acme.example:3128',
    };
    for (const target of [EMULATOR, 'http://localhost:8080/', 'https://[::1]:8443/'])
      expect(proxyRoute(env, target, any), target).toEqual({ via: 'direct' });
    expect(proxyRoute(env, AIRFLOW, any)).toMatchObject({ via: 'proxy' });
    // A proxy on this machine follows NO_PROXY alone.
    expect(proxyRoute({ HTTP_PROXY: 'http://127.0.0.1:3128' }, EMULATOR, any)).toMatchObject({
      via: 'proxy',
      proxy: '127.0.0.1:3128',
    });
  });

  it('FR-AUTH-07: DCAM_NETWORK=loopback-only drops remote proxies and keeps loopback ones', () => {
    const env = { HTTPS_PROXY: 'http://proxy.acme.example:3128', HTTP_PROXY: 'http://127.0.0.1:3128' };
    const local = { loopbackOnly: true };
    expect(proxyRoute(env, COMPOSER, local)).toMatchObject({ via: 'proxy', proxy: '127.0.0.1:3128' });
    expect(proxyRoute({ HTTPS_PROXY: 'http://proxy.acme.example:3128' }, COMPOSER, local)).toEqual({
      via: 'direct',
    });
    const read = readProxyEnvironment(env, local);
    expect(read.https).toBeNull();
    expect(read.http).toMatchObject({ variable: 'HTTP_PROXY', loopback: true });
    expect(read.dropped).toEqual([expect.objectContaining({ variable: 'HTTPS_PROXY', loopback: false })]);
  });

  it.each<[string, boolean]>([
    ['*', false],
    [' * ', false],
    ['.googleapis.com', false],
    ['*.googleapis.com', false],
    ['GOOGLEAPIS.COM', false],
    ['composer.googleapis.com:443', false],
    ['composer.googleapis.com:8443', true],
    ['acme.example monitoring.googleapis.com,composer.googleapis.com', false],
    ['acme.example', true],
    ['oogleapis.com', true],
  ])('FR-AUTH-07: NO_PROXY=%j → proxied %s (undici 7.30.1 rules)', (noProxy, proxied) => {
    const env = { HTTPS_PROXY: 'http://proxy.acme.example:3128', NO_PROXY: noProxy };
    expect(proxyRoute(env, COMPOSER, any).via).toBe(proxied ? 'proxy' : 'direct');
  });

  it('FR-AUTH-07: credentials are never part of what is returned', () => {
    const env = { HTTPS_PROXY: 'http://alice:s3cret@proxy.acme.example:3128' };
    const text = JSON.stringify([readProxyEnvironment(env, any), proxyRoute(env, COMPOSER, any)]);
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('alice');
    expect(readProxyEnvironment(env, any).https?.url).toBe('http://***@proxy.acme.example:3128');
  });

  it('FR-AUTH-07: values the transport refuses throw its start-up error, without the value', () => {
    expect(() => proxyRoute({ HTTPS_PROXY: 'socks5://proxy.acme.example:1080' }, COMPOSER, any)).toThrow(
      /HTTPS_PROXY must be an http:\/\/ or https:\/\/ URL, not socks5:\/\//,
    );
    let message = '';
    try {
      readProxyEnvironment({ https_proxy: 'http://acme:s3cr@t@[bad' }, any);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/https_proxy is not a valid proxy URL/);
    expect(message).not.toContain('s3cr');
  });
});
