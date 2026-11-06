/**
 * The default transport against real loopback servers: an HTTP proxy (absolute-form and CONNECT), a plain
 * HTTP target and an HTTPS target whose certificate is signed by a test-only CA created in memory.
 * Every socket stays on 127.0.0.1.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import {
  GuardError,
  TransportError,
  createGuardedClient,
  proxyRoute,
  trustedCaCertificates,
  type GuardedClient,
  type GuardedClientOptions,
  type ResponseEvent,
} from '../src/index';
import { createTestPki } from './support/test-pki';

const pki = createTestPki();
const otherPki = createTestPki('DCAM unrelated test-only CA (never trust)');
const dir = mkdtempSync(join(tmpdir(), 'dcam-http-guard-'));
const CA_FILE = join(dir, 'test-only-ca.pem');
const OTHER_CA_FILE = join(dir, 'unrelated-test-only-ca.pem');
writeFileSync(CA_FILE, pki.caCert);
writeFileSync(OTHER_CA_FILE, otherPki.caCert);

const USER = 'acme-proxy-user';
const PASSWORD = 's3cr:t@pw';
const PROXY_AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
const credentials = `${encodeURIComponent(USER)}:${encodeURIComponent(PASSWORD)}`;

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

/** A forward proxy: answers absolute-form requests itself, tunnels CONNECT to loopback ports. */
function createProxy() {
  const seen: string[] = [];
  const auth: Array<string | undefined> = [];
  let requireAuth = false;
  const denied = (req: IncomingMessage) => {
    auth.push(req.headers['proxy-authorization']);
    return requireAuth && req.headers['proxy-authorization'] !== PROXY_AUTH;
  };
  const server = createHttpServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (denied(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="acme"' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"via":"proxy"}');
  });
  const sockets = new Set<Socket>();
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    seen.push(`CONNECT ${req.url}`);
    sockets.add(client);
    if (denied(req)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const [host = '', port = '0'] = (req.url ?? '').split(/:(?=\d+$)/);
    if (host !== '127.0.0.1') {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = netConnect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return {
    server,
    seen,
    auth,
    requireCredentials(v: boolean) {
      requireAuth = v;
    },
    reset() {
      seen.length = 0;
      auth.length = 0;
      requireAuth = false;
    },
    destroySockets() {
      for (const s of sockets) s.destroy();
    },
  };
}

const proxy = createProxy();
const target = createHttpServer((req, res) => {
  if (req.url === '/api/v1/health') return; // never answers: timeout tests
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"via":"direct"}');
});
const tlsTarget = createHttpsServer({ cert: pki.serverCert, key: pki.serverKey }, (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"via":"tls"}');
});
let proxyPort = 0;
let targetPort = 0;
let tlsPort = 0;
let closedPort = 0;

beforeAll(async () => {
  proxyPort = await listen(proxy.server);
  targetPort = await listen(target);
  tlsPort = await listen(tlsTarget);
  const spare = createHttpServer();
  closedPort = await listen(spare);
  await new Promise((r) => spare.close(r));
});

afterAll(async () => {
  proxy.destroySockets();
  target.closeAllConnections();
  tlsTarget.closeAllConnections();
  await Promise.all([proxy.server, target, tlsTarget].map((s) => new Promise((r) => s.close(r))));
  rmSync(dir, { recursive: true, force: true });
});

const clients: GuardedClient[] = [];
afterEach(async () => {
  proxy.reset();
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

function client(options: Partial<GuardedClientOptions> = {}): GuardedClient {
  const c = createGuardedClient({
    network: 'loopback-only',
    hosts: { airflow: [`127.0.0.1:${targetPort}`, `127.0.0.1:${tlsPort}`] },
    ...options,
  });
  clients.push(c);
  return c;
}

const httpUrl = () => `http://127.0.0.1:${targetPort}/api/v1/pools`;
const httpsUrl = () => `https://127.0.0.1:${tlsPort}/api/v1/pools`;
const body = async (c: GuardedClient, url: string) => (await c.request({ method: 'GET', url })).text();
const failure = (c: GuardedClient, url: string, timeoutMs?: number) =>
  c.request(timeoutMs === undefined ? { method: 'GET', url } : { method: 'GET', url, timeoutMs }).then(
    () => {
      throw new Error('expected the request to fail');
    },
    (e: unknown) => e as TransportError,
  );

describe('FR-AUTH-07 proxy variables', () => {
  it('FR-AUTH-07: an http target goes through HTTP_PROXY (absolute-form request)', async () => {
    const c = client({ proxyEnv: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` } });
    expect(await body(c, httpUrl())).toBe('{"via":"proxy"}');
    expect(proxy.seen).toEqual([`GET ${httpUrl()}`]);
  });

  it('FR-AUTH-07: lower-case http_proxy is honoured, and a value without a scheme means http://', async () => {
    const c = client({ proxyEnv: { http_proxy: `127.0.0.1:${proxyPort}` } });
    expect(await body(c, httpUrl())).toBe('{"via":"proxy"}');
  });

  it('FR-AUTH-07: NO_PROXY bypasses the proxy (host, host:port, lower case)', async () => {
    for (const noProxy of [
      { NO_PROXY: '127.0.0.1' },
      { NO_PROXY: `acme.internal, 127.0.0.1:${targetPort}` },
      { no_proxy: '127.0.0.1' },
    ]) {
      const c = client({ proxyEnv: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, ...noProxy } });
      expect(await body(c, httpUrl())).toBe('{"via":"direct"}');
    }
    expect(proxy.seen).toEqual([]);
  });

  it('FR-AUTH-07: without proxy variables the request goes direct (process.env is never read)', async () => {
    const saved = process.env['HTTP_PROXY'];
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    try {
      expect(await body(client(), httpUrl())).toBe('{"via":"direct"}');
      expect(proxy.seen).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env['HTTP_PROXY'];
      else process.env['HTTP_PROXY'] = saved;
    }
  });

  it('FR-AUTH-07: an https target goes through HTTPS_PROXY with CONNECT, and the CA bundle applies inside the tunnel', async () => {
    const c = client({ proxyEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }, caBundlePath: CA_FILE });
    expect(await body(c, httpsUrl())).toBe('{"via":"tls"}');
    expect(proxy.seen).toEqual([`CONNECT 127.0.0.1:${tlsPort}`]);
  });

  it('FR-AUTH-07: user:password@ in the proxy URL is sent as Basic proxy authorization', async () => {
    proxy.requireCredentials(true);
    const proxyUrl = `http://${credentials}@127.0.0.1:${proxyPort}`;
    const c = client({ proxyEnv: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }, caBundlePath: CA_FILE });
    expect(await body(c, httpUrl())).toBe('{"via":"proxy"}');
    expect(await body(c, httpsUrl())).toBe('{"via":"tls"}');
    expect(proxy.auth).toEqual([PROXY_AUTH, PROXY_AUTH]);
  });

  it('FR-AUTH-07: proxy credentials never appear in errors or events', async () => {
    proxy.requireCredentials(true);
    const events: ResponseEvent[] = [];
    const wrong = `http://${USER}:${encodeURIComponent('not-the-s3cr:t@pw')}@127.0.0.1:${proxyPort}`;
    const unreachable = `http://${credentials}@127.0.0.1:${closedPort}`;
    const errors: TransportError[] = [];
    for (const proxyUrl of [wrong, unreachable]) {
      const c = client({
        proxyEnv: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl },
        caBundlePath: CA_FILE,
        onResponse: (e) => events.push(e),
      });
      errors.push(await failure(c, httpUrl()), await failure(c, httpsUrl()));
    }
    for (const error of errors) {
      expect(error).toBeInstanceOf(TransportError);
      expect(error.kind).toBe('network');
      const text = [error.message, error.stack, error.fixHint, JSON.stringify(error)].join('\n');
      for (const secret of ['s3cr', USER, encodeURIComponent(PASSWORD), PROXY_AUTH.slice(6)])
        expect(text).not.toContain(secret);
      expect(error.fixHint).toMatch(/HTTPS_PROXY/);
    }
    expect(errors[0]?.message).toMatch(/407/);
    expect(JSON.stringify(events)).not.toContain('s3cr');
    expect(events).toHaveLength(4);
  });

  it('FR-AUTH-07: an invalid proxy URL fails at start-up without echoing the value', () => {
    let message = '';
    try {
      createGuardedClient({ network: 'any', proxyEnv: { HTTPS_PROXY: 'http://acme:s3cr@t@[bad' } });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/HTTPS_PROXY/);
    expect(message).not.toContain('s3cr');
    expect(() =>
      createGuardedClient({ network: 'any', proxyEnv: { HTTP_PROXY: 'ftp://127.0.0.1:21' } }),
    ).toThrow(/HTTP_PROXY.*http:\/\/ or https:\/\//);
  });

  it('FR-AUTH-07: loopback-only mode never sends a request to a non-loopback proxy', async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed. Using it as a proxy would fail the request.
    const c = client({ proxyEnv: { HTTP_PROXY: 'http://192.0.2.1:3128' } });
    expect(await body(c, httpUrl())).toBe('{"via":"direct"}');
  });

  it('FR-AUTH-07: loopback targets never go through a remote proxy, even without NO_PROXY', async () => {
    // A remote proxy cannot reach this machine's loopback, and must not see local credentials.
    const c = client({
      network: 'any',
      proxyEnv: { HTTP_PROXY: 'http://192.0.2.1:3128', NO_PROXY: 'acme.internal' },
    });
    expect(await body(c, httpUrl())).toBe('{"via":"direct"}');
  });

  it('FR-AUTH-07: loopback-only mode still rejects non-loopback targets when a proxy is set', async () => {
    const c = client({ proxyEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` } });
    await expect(
      c.request({
        method: 'GET',
        url: 'https://monitoring.googleapis.com/v3/projects/acme-prod-123/timeSeries',
      }),
    ).rejects.toMatchObject({ name: 'GuardError', code: 'non-loopback' });
    expect(proxy.seen).toEqual([]);
  });
});

describe('FR-AUTH-07 proxyRoute agrees with the transport', () => {
  it('FR-AUTH-07: for every variable combination, proxyRoute says "proxy" exactly when the proxy saw the request', async () => {
    const via = () => `http://127.0.0.1:${proxyPort}`;
    const cases: Array<[Record<string, string>, string]> = [
      [{ HTTP_PROXY: via() }, httpUrl()],
      [{ http_proxy: `127.0.0.1:${proxyPort}` }, httpUrl()],
      [{ http_proxy: '', HTTP_PROXY: via() }, httpUrl()],
      [{ HTTP_PROXY: via(), NO_PROXY: '127.0.0.1' }, httpUrl()],
      [{ HTTP_PROXY: via(), NO_PROXY: `127.0.0.1:${closedPort}` }, httpUrl()],
      [{ HTTP_PROXY: via(), NO_PROXY: `127.0.0.1:${targetPort}` }, httpUrl()],
      [{ HTTP_PROXY: via(), NO_PROXY: '*' }, httpUrl()],
      [{ HTTP_PROXY: via(), NO_PROXY: '.0.0.1' }, httpUrl()],
      [{ HTTP_PROXY: via(), NO_PROXY: 'localhost' }, httpUrl()],
      [{ HTTP_PROXY: via(), no_proxy: '', NO_PROXY: '127.0.0.1' }, httpUrl()],
      [{ HTTPS_PROXY: via() }, httpUrl()],
      [{ HTTP_PROXY: via() }, httpsUrl()],
      [{ HTTPS_PROXY: via(), NO_PROXY: `127.0.0.1:${tlsPort}` }, httpsUrl()],
    ];
    const proxied: boolean[] = [];
    for (const [env, url] of cases) {
      proxy.reset();
      await body(client({ proxyEnv: env, caBundlePath: CA_FILE }), url);
      const expected = proxyRoute(env, url, { loopbackOnly: true }).via === 'proxy';
      expect(proxy.seen.length > 0, JSON.stringify({ env, url })).toBe(expected);
      proxied.push(expected);
    }
    // Both routes occur, so the comparison means something.
    expect(new Set(proxied)).toEqual(new Set([true, false]));
  });
});

describe('FR-AUTH-07 custom CA bundles', () => {
  it('FR-AUTH-07: without caBundlePath, TLS to a server signed by an unknown CA fails with a certificate hint', async () => {
    const error = await failure(client(), httpsUrl());
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: 'network', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    expect(error.fixHint).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(error.fixHint).toMatch(/caBundlePath/);
  });

  it('FR-AUTH-07: caBundlePath makes TLS succeed on a direct connection', async () => {
    expect(await body(client({ caBundlePath: CA_FILE }), httpsUrl())).toBe('{"via":"tls"}');
  });

  it('FR-AUTH-07: NODE_EXTRA_CA_CERTS still applies when caBundlePath replaces the default roots', async () => {
    const onlyOther = client({ caBundlePath: OTHER_CA_FILE });
    expect(await failure(onlyOther, httpsUrl())).toMatchObject({ kind: 'network' });
    const both = client({ caBundlePath: OTHER_CA_FILE, proxyEnv: { NODE_EXTRA_CA_CERTS: CA_FILE } });
    expect(await body(both, httpsUrl())).toBe('{"via":"tls"}');
  });

  it("FR-AUTH-07: the combined trust list keeps Node's roots, adds NODE_EXTRA_CA_CERTS and the bundle", () => {
    expect(trustedCaCertificates({})).toBeUndefined();
    expect(trustedCaCertificates({ extraCaCertsPath: CA_FILE })).toBeUndefined();
    const list = trustedCaCertificates({ caBundlePath: OTHER_CA_FILE, extraCaCertsPath: CA_FILE }) ?? [];
    for (const root of rootCertificates) expect(list).toContain(root);
    expect(list).toContain(pki.caCert);
    expect(list).toContain(otherPki.caCert);
    // An unreadable NODE_EXTRA_CA_CERTS is skipped, as Node.js does at start-up.
    expect(
      trustedCaCertificates({ caBundlePath: CA_FILE, extraCaCertsPath: join(dir, 'missing.pem') }),
    ).toContain(pki.caCert);
  });

  it('FR-AUTH-07: an unreadable or non-PEM caBundlePath fails at start-up with a clear message', () => {
    expect(() => createGuardedClient({ network: 'any', caBundlePath: join(dir, 'missing.pem') })).toThrow(
      /network\.caBundlePath.*missing\.pem/,
    );
    const notPem = join(dir, 'not-pem.txt');
    writeFileSync(notPem, 'hello');
    expect(() => createGuardedClient({ network: 'any', caBundlePath: notPem })).toThrow(
      /network\.caBundlePath.*PEM/,
    );
  });
});

describe('FR-AUTH-07 timeouts and guard with the real transport', () => {
  it('FR-AUTH-07: a server that never answers fails with a timeout TransportError', async () => {
    const started = Date.now();
    const error = await failure(client(), `http://127.0.0.1:${targetPort}/api/v1/health`, 150);
    expect(error).toMatchObject({ name: 'TransportError', kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('FR-AUTH-07: a refused connection is a network TransportError', async () => {
    const c = client({ hosts: { airflow: [`127.0.0.1:${closedPort}`] } });
    const error = await failure(c, `http://127.0.0.1:${closedPort}/api/v1/pools`);
    expect(error).toMatchObject({ name: 'TransportError', kind: 'network', code: 'ECONNREFUSED' });
    expect(error).not.toBeInstanceOf(GuardError);
  });
});
