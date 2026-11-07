/**
 * How DCAM reads the proxy variables, and which way a request goes. `createNetworkTransport` builds its
 * dispatcher from {@link resolveProxies}, and {@link proxyRoute} answers from the same result, so the
 * doctor's evidence always matches what the transport does (FR-AUTH-07). Pure: no I/O.
 *
 * - The first non-empty value wins, lower case before upper case (`https_proxy`, then `HTTPS_PROXY`), as in
 *   curl; values are trimmed, so an empty lower-case variable does not hide the upper-case one.
 * - A value without a scheme means `http://` (curl does the same); only `http:` and `https:` proxies work.
 * - HTTPS requests use the HTTPS proxy, else the HTTP proxy; HTTP requests use the HTTP proxy (undici
 *   7.30.1 `EnvHttpProxyAgent`, https://github.com/nodejs/undici/blob/v7.30.1/lib/dispatcher/env-http-proxy-agent.js).
 * - `DCAM_NETWORK=loopback-only` drops proxies that are not on this machine.
 * - A remote proxy cannot reach this machine's loopback, and must not see local credentials, so loopback
 *   targets always bypass it: `localhost,127.0.0.1,[::1]` is added to `NO_PROXY`.
 * - `NO_PROXY` is matched as undici 7.30.1 does: entries split on commas and white space; `*` only as the
 *   whole value; `host:port` matches that port only (no port in the URL means 80 or 443); a leading `.` or
 *   `*.` is dropped; an entry matches the host itself and its subdomains. ⚠️ VERIFY again on undici 8.
 *
 * @implements FR-AUTH-07
 */
import { isLoopbackHostname } from './loopback';

/** Proxy and CA variables: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (either case), `NODE_EXTRA_CA_CERTS`. */
export type NetworkEnv = Readonly<Record<string, string | undefined>>;

/** One proxy variable as DCAM uses it. Never holds credentials. */
export interface ProxyVariable {
  /** The variable that supplied the value, for example `https_proxy`. */
  readonly variable: string;
  /** The proxy URL with any credentials replaced by `***`, for example `http://***@proxy.example.com:3128`. */
  readonly url: string;
  /** `host:port` of the proxy. */
  readonly host: string;
  /** The value had no scheme, so `http://` was assumed. */
  readonly schemeAdded: boolean;
  /** The proxy runs on this machine. */
  readonly loopback: boolean;
}

/** The proxy variables as the transport reads them, for the doctor. */
export interface ProxyEnvironment {
  readonly http: ProxyVariable | null;
  readonly https: ProxyVariable | null;
  /** `NO_PROXY` as set (either case), before DCAM adds the loopback addresses. */
  readonly noProxy: { readonly variable: string; readonly value: string } | null;
  /** Remote proxies that `DCAM_NETWORK=loopback-only` does not use. */
  readonly dropped: readonly ProxyVariable[];
  /** Both cases set to different values: `used` wins, `ignored` is not read. */
  readonly shadowed: ReadonlyArray<{ readonly used: string; readonly ignored: string }>;
}

export type ProxyRoute =
  | { readonly via: 'direct' }
  | {
      readonly via: 'proxy';
      /** `host:port` of the proxy. */
      readonly proxy: string;
      readonly variable: string;
    };

export interface ProxyRouteOptions {
  /** `DCAM_NETWORK=loopback-only`: proxies that are not on loopback are not used. */
  readonly loopbackOnly: boolean;
}

/** A proxy the transport uses; `href` may hold credentials and never leaves http-guard. */
export interface ResolvedProxy extends ProxyVariable {
  readonly href: string;
}

export interface ResolvedProxies {
  readonly http: ResolvedProxy | undefined;
  readonly https: ResolvedProxy | undefined;
  /** The `NO_PROXY` value given to the dispatcher. */
  readonly noProxy: string;
  /** Proxy credentials (raw and decoded), to remove from error messages. */
  readonly secrets: readonly string[];
  readonly environment: ProxyEnvironment;
}

const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,[::1]';
const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };

/** The first non-empty value, lower case first, and the other case when it is set to something else. */
function pick(
  env: NetworkEnv,
  name: string,
): { variable: string; value: string; shadows: string | null } | undefined {
  const names = [name.toLowerCase(), name];
  const values = names.map((n) => env[n]?.trim() ?? '');
  const index = values.findIndex((v) => v !== '');
  if (index === -1) return undefined;
  const value = values[index] ?? '';
  const other = index === 0 && values[1] !== '' && values[1] !== value ? (names[1] ?? null) : null;
  return { variable: names[index] ?? name, value, shadows: other };
}

function parseProxy(variable: string, raw: string): { proxy: ResolvedProxy; secrets: string[] } {
  const schemeAdded = !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const value = schemeAdded ? `http://${raw}` : raw;
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
  const auth = url.username || url.password ? '***@' : '';
  const path = url.pathname === '/' ? '' : url.pathname;
  return {
    proxy: {
      variable,
      href: url.href,
      url: `${url.protocol}//${auth}${url.host}${path}`,
      host: url.host,
      schemeAdded,
      loopback: isLoopbackHostname(url.hostname),
    },
    secrets: secrets.filter((s) => s.length >= 3),
  };
}

const publicView = (p: ResolvedProxy): ProxyVariable => ({
  variable: p.variable,
  url: p.url,
  host: p.host,
  schemeAdded: p.schemeAdded,
  loopback: p.loopback,
});

/** Reads the proxy variables. Throws on a value that is not an http:// or https:// URL. */
export function resolveProxies(env: NetworkEnv, options: ProxyRouteOptions): ResolvedProxies {
  const secrets: string[] = [];
  const used: Partial<Record<'http' | 'https', ResolvedProxy>> = {};
  const dropped: ResolvedProxy[] = [];
  const shadowed: Array<{ used: string; ignored: string }> = [];
  for (const [scheme, name] of [
    ['http', 'HTTP_PROXY'],
    ['https', 'HTTPS_PROXY'],
  ] as const) {
    const found = pick(env, name);
    if (!found) continue;
    if (found.shadows) shadowed.push({ used: found.variable, ignored: found.shadows });
    const parsed = parseProxy(found.variable, found.value);
    secrets.push(...parsed.secrets);
    if (options.loopbackOnly && !parsed.proxy.loopback) dropped.push(parsed.proxy);
    else used[scheme] = parsed.proxy;
  }
  const noProxyVariable = pick(env, 'NO_PROXY');
  if (noProxyVariable?.shadows)
    shadowed.push({ used: noProxyVariable.variable, ignored: noProxyVariable.shadows });
  const remoteProxy = [used.http, used.https].some((p) => p !== undefined && !p.loopback);
  const userNoProxy = noProxyVariable?.value;
  // `*` works only as the whole value, so nothing may be appended to it.
  const noProxy =
    userNoProxy === '*'
      ? '*'
      : [userNoProxy, remoteProxy ? LOOPBACK_NO_PROXY : undefined]
          .filter((v) => v !== undefined && v !== '')
          .join(',');
  return {
    http: used.http,
    https: used.https,
    noProxy,
    secrets,
    environment: {
      http: used.http ? publicView(used.http) : null,
      https: used.https ? publicView(used.https) : null,
      noProxy: noProxyVariable ? { variable: noProxyVariable.variable, value: noProxyVariable.value } : null,
      dropped: dropped.map(publicView),
      shadowed,
    },
  };
}

/** `NO_PROXY` matching of undici 7.30.1 `EnvHttpProxyAgent` (`#shouldProxy`, `#parseNoProxy`). */
export function bypassesProxy(noProxy: string, url: URL): boolean {
  const entries = noProxy
    .split(/[,\s]/)
    .filter((entry) => entry !== '')
    .map((entry) => {
      const parsed = /^(.+):(\d+)$/.exec(entry);
      return {
        hostname: (parsed?.[1] ?? entry).replace(/^\*?\./, '').toLowerCase(),
        port: parsed?.[2] === undefined ? 0 : Number.parseInt(parsed[2], 10),
      };
    });
  if (entries.length === 0) return false;
  if (noProxy === '*') return true;
  // undici strips the port from `host`, which keeps the brackets of IPv6 addresses.
  const hostname = url.host.replace(/:\d*$/, '').toLowerCase();
  const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0;
  return entries.some(
    (e) =>
      (e.port === 0 || e.port === port) && (hostname === e.hostname || hostname.endsWith(`.${e.hostname}`)),
  );
}

/** The proxy variables as the transport reads them. Throws like the transport on an invalid value. */
export function readProxyEnvironment(env: NetworkEnv, options: ProxyRouteOptions): ProxyEnvironment {
  return resolveProxies(env, options).environment;
}

/**
 * The way DCAM's transport sends a request to `url`: direct, or through which proxy. Throws like the
 * transport on an invalid proxy value. `DCAM_NETWORK=loopback-only` refusing the URL itself is the
 * guarded client's job, not this function's.
 */
export function proxyRoute(env: NetworkEnv, url: string | URL, options: ProxyRouteOptions): ProxyRoute {
  const target = typeof url === 'string' ? new URL(url) : url;
  const proxies = resolveProxies(env, options);
  const proxy = target.protocol === 'https:' ? (proxies.https ?? proxies.http) : proxies.http;
  if (!proxy || bypassesProxy(proxies.noProxy, target)) return { via: 'direct' };
  return { via: 'proxy', proxy: proxy.host, variable: proxy.variable };
}
