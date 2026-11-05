/**
 * The default transport of the guarded client: undici's `fetch` with an `EnvHttpProxyAgent` dispatcher,
 * so DCAM works behind corporate proxies with TLS inspection (FR-AUTH-07, spec §17.3).
 *
 * - Node.js 22.12–22.20's built-in `fetch` ignores `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`, hence undici
 *   7.30.1 (https://github.com/nodejs/undici/blob/v7.30.1/docs/docs/api/EnvHttpProxyAgent.md).
 * - The proxy variables come from an explicit object (the composition root passes `process.env`): the
 *   agent is always given all three values, so it never falls back to reading `process.env` itself.
 * - `network.caBundlePath`: passing `ca` replaces Node's default trust store
 *   (https://nodejs.org/docs/latest-v22.x/api/tls.html#tlscreatesecurecontextoptions), so the list is
 *   Node's defaults + the `NODE_EXTRA_CA_CERTS` file + the bundle, for the origin and the proxy TLS.
 *   Without a bundle no `ca` is passed: Node's default context already includes `NODE_EXTRA_CA_CERTS`
 *   (read at start-up, https://nodejs.org/docs/latest-v22.x/api/cli.html#node_extra_ca_certsfile).
 *
 * @implements FR-AUTH-07
 */
import { readFileSync } from 'node:fs';
import * as tls from 'node:tls';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { isLoopbackHostname } from './loopback';
import { toTransportError } from './transport-error';

/** What the guarded client sends to a transport. */
export interface TransportInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Always `manual`: the guarded client rejects 3xx itself. */
  readonly redirect: 'manual';
  /** Aborted on the per-request timeout. */
  readonly signal: AbortSignal;
}

/** The part of a fetch `Response` the guarded client reads (global and undici responses both fit). */
export interface TransportResponse {
  readonly status: number;
  readonly type?: string;
  readonly headers: { forEach(callback: (value: string, name: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly body?: { cancel(): Promise<void> } | null;
}

export type Transport = (url: string, init: TransportInit) => Promise<TransportResponse>;

/** Proxy and CA variables: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (either case), `NODE_EXTRA_CA_CERTS`. */
export type NetworkEnv = Readonly<Record<string, string | undefined>>;

interface ProxySetting {
  readonly href: string;
  /** `host:port`, safe to show. */
  readonly display: string;
}

/** The first non-empty value; lower case wins over upper case, as in undici and curl. */
function pick(env: NetworkEnv, name: string): [variable: string, value: string] | undefined {
  for (const variable of [name.toLowerCase(), name]) {
    const value = env[variable]?.trim();
    if (value) return [variable, value];
  }
  return undefined;
}

function parseProxy(variable: string, raw: string): { proxy: ProxySetting; secrets: string[] } {
  // curl and most tools accept `host:port` and mean http://host:port.
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${variable} is not a valid proxy URL (value not shown: it may contain credentials). ` +
        'Use http://host:port, or http://user:password@host:port with URL-encoded credentials.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${variable} must be an http:// or https:// URL, not ${url.protocol}//`);
  }
  const secrets = [url.username, url.password].flatMap((s) => {
    let decoded = s;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      // Keep the encoded form only.
    }
    return [s, decoded];
  });
  return { proxy: { href: url.href, display: url.host }, secrets: secrets.filter((s) => s.length >= 3) };
}

function readPem(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * The CA certificates to pass as `ca` when `caBundlePath` is set, else `undefined` (keep Node's default
 * context). An unreadable `NODE_EXTRA_CA_CERTS` file is skipped, as Node.js does at start-up.
 */
export function trustedCaCertificates(input: {
  readonly caBundlePath?: string;
  readonly extraCaCertsPath?: string;
}): string[] | undefined {
  if (input.caBundlePath === undefined) return undefined;
  let bundle: string;
  try {
    bundle = readPem(input.caBundlePath);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(
      `network.caBundlePath: cannot read ${input.caBundlePath}${typeof code === 'string' ? ` (${code})` : ''}. ` +
        "Point it at your organisation's root CA bundle in PEM format.",
      { cause: error },
    );
  }
  if (!bundle.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(
      `network.caBundlePath: ${input.caBundlePath} contains no PEM certificate ("-----BEGIN CERTIFICATE-----"). ` +
        'Export the root CA as Base-64 (PEM), not binary DER.',
    );
  }
  // tls.getCACertificates (Node.js ≥ 22.15) also covers --use-system-ca; older 22.x: the bundled roots.
  const defaults =
    typeof tls.getCACertificates === 'function'
      ? tls.getCACertificates('default')
      : [...tls.rootCertificates];
  let extra: string[] = [];
  if (input.extraCaCertsPath) {
    try {
      extra = [readPem(input.extraCaCertsPath)];
    } catch {
      extra = [];
    }
  }
  return [...defaults, ...extra, bundle];
}

export interface NetworkTransportOptions {
  /** Drop proxies that are not on loopback: `DCAM_NETWORK=loopback-only` keeps every socket local. */
  readonly loopbackOnly: boolean;
  readonly env?: NetworkEnv;
  readonly caBundlePath?: string;
}

export interface NetworkTransport {
  readonly transport: Transport;
  close(): Promise<void>;
}

/** Builds the proxy- and CA-aware transport. Throws on an invalid proxy URL or CA bundle. */
export function createNetworkTransport(options: NetworkTransportOptions): NetworkTransport {
  const env = options.env ?? {};
  const secrets: string[] = [];
  const proxies: Partial<Record<'http' | 'https', ProxySetting>> = {};
  for (const [scheme, name] of [
    ['http', 'HTTP_PROXY'],
    ['https', 'HTTPS_PROXY'],
  ] as const) {
    const found = pick(env, name);
    if (!found) continue;
    const parsed = parseProxy(...found);
    secrets.push(...parsed.secrets);
    if (options.loopbackOnly && !isLoopbackHostname(new URL(parsed.proxy.href).hostname)) continue;
    proxies[scheme] = parsed.proxy;
  }
  const noProxy = pick(env, 'NO_PROXY')?.[1] ?? '';
  const extraCaCertsPath = env['NODE_EXTRA_CA_CERTS'];
  const ca = trustedCaCertificates({
    ...(options.caBundlePath === undefined ? {} : { caBundlePath: options.caBundlePath }),
    ...(extraCaCertsPath ? { extraCaCertsPath } : {}),
  });
  const tlsOptions = ca ? { ca } : {};
  const dispatcher = new EnvHttpProxyAgent({
    // Empty strings, never undefined: undefined would make undici read process.env.
    httpProxy: proxies.http?.href ?? '',
    // EnvHttpProxyAgent falls back to the HTTP proxy for https URLs when no HTTPS proxy is set.
    httpsProxy: proxies.https?.href ?? '',
    noProxy,
    // Plain-HTTP targets are sent in absolute form (`GET http://host/path`), as curl does; HTTPS
    // targets always use a CONNECT tunnel.
    proxyTunnel: false,
    connect: tlsOptions,
    requestTls: tlsOptions,
    proxyTls: tlsOptions,
  });
  const redact = (text: string) => secrets.reduce((t, s) => t.split(s).join('***'), text);
  const proxyFor = (url: URL) =>
    (url.protocol === 'https:' ? (proxies.https ?? proxies.http) : proxies.http)?.display ?? null;

  const transport: Transport = async (url, init) => {
    try {
      return await undiciFetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: init.redirect,
        signal: init.signal,
        dispatcher,
      });
    } catch (error) {
      if (init.signal.aborted) throw error;
      const target = new URL(url);
      throw toTransportError(error, { method: init.method, url: target, proxy: proxyFor(target), redact });
    }
  };
  return { transport, close: () => dispatcher.close() };
}
