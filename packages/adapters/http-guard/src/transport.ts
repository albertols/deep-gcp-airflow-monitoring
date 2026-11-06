/**
 * The default transport of the guarded client: undici's `fetch` with an `EnvHttpProxyAgent` dispatcher,
 * so DCAM works behind corporate proxies with TLS inspection (FR-AUTH-07, spec §17.3).
 *
 * - Node.js 22.12–22.20's built-in `fetch` ignores `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`, hence undici
 *   7.30.1 (https://github.com/nodejs/undici/blob/v7.30.1/docs/docs/api/EnvHttpProxyAgent.md).
 * - The proxy variables come from an explicit object (the composition root passes `process.env`): the
 *   agent is always given all three values, so it never falls back to reading `process.env` itself. How
 *   they are read is in proxy-env.ts, shared with `proxyRoute`.
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
import { resolveProxies, type NetworkEnv } from './proxy-env';
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

export type { NetworkEnv } from './proxy-env';

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
  // The proxy rules live in proxy-env.ts, shared with proxyRoute (the doctor's evidence).
  const proxies = resolveProxies(env, { loopbackOnly: options.loopbackOnly });
  const { secrets, noProxy } = proxies;
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
  /** The proxy a request may have used, for fix hints (NO_PROXY is not evaluated here). */
  const proxyFor = (url: URL) => {
    const proxy = url.protocol === 'https:' ? (proxies.https ?? proxies.http) : proxies.http;
    if (!proxy || (!proxy.loopback && isLoopbackHostname(url.hostname))) return null;
    return proxy.host;
  };

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
