/**
 * Proxy variables as DCAM's HTTP transport reads them (undici 7.x `EnvHttpProxyAgent`, see the platform
 * facts in specs/002-coll-live-mode), for the doctor's evidence only: the transport itself is http-guard.
 *
 * Rules mirrored from undici v7.30.2 `lib/dispatcher/env-http-proxy-agent.js` and
 * `docs/docs/api/EnvHttpProxyAgent.md` (read 2026-11-05):
 * - the lower-case variable wins over the upper-case one (`http_proxy ?? HTTP_PROXY`), even when empty;
 * - HTTPS requests use `https_proxy`, falling back to `http_proxy`; HTTP requests use `http_proxy`;
 * - `no_proxy` is split on commas and white space; `*` disables proxying only as the whole value; an
 *   entry may carry `:port` (then only that port matches; requests without a port count as 80 or 443);
 *   a leading `.` or `*.` is dropped, and an entry matches the host itself or any subdomain.
 * ⚠️ VERIFY again when http-guard moves to undici 8, which also accepts `*` inside a list.
 *
 * @implements FR-AUTH-07
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface ProxyVariable {
  /** The variable that supplied the value, for example `https_proxy`. */
  readonly name: string;
  readonly value: string;
}

export interface ProxySettings {
  readonly https: ProxyVariable | null;
  readonly http: ProxyVariable | null;
  readonly noProxy: ProxyVariable | null;
  /** Lower- and upper-case variables that are both set to different values. */
  readonly conflicts: readonly string[];
}

function pick(env: Env, lower: string, upper: string, conflicts: string[]): ProxyVariable | null {
  const lo = env[lower];
  const up = env[upper];
  if (lo !== undefined && up !== undefined && lo !== up)
    conflicts.push(`${lower} and ${upper} differ, and ${lower} is used`);
  const name = lo !== undefined ? lower : upper;
  const value = (lo ?? up ?? '').trim();
  return value ? { name, value } : null;
}

export function readProxySettings(env: Env): ProxySettings {
  const conflicts: string[] = [];
  return {
    https: pick(env, 'https_proxy', 'HTTPS_PROXY', conflicts),
    http: pick(env, 'http_proxy', 'HTTP_PROXY', conflicts),
    noProxy: pick(env, 'no_proxy', 'NO_PROXY', conflicts),
    conflicts,
  };
}

export function parseProxyUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The proxy URL without credentials, for display. */
export function displayProxy(value: string): string {
  const url = parseProxyUrl(value);
  if (!url) return value.replace(/^[^@/]*@/, '***@');
  const auth = url.username || url.password ? '***@' : '';
  return `${url.protocol}//${auth}${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

function excluded(host: string, port: string, noProxy: string): boolean {
  if (noProxy.trim() === '*') return true;
  for (const raw of noProxy.split(/[,\s]/)) {
    if (!raw) continue;
    const m = /^(.+):(\d+)$/.exec(raw);
    const name = (m?.[1] ?? raw).replace(/^\*?\./, '').toLowerCase();
    const entryPort = m?.[2];
    if (entryPort && entryPort !== port) continue;
    if (host === name || host.endsWith(`.${name}`)) return true;
  }
  return false;
}

/** `host:port` of the proxy a request to `target` goes through, or `null` for a direct connection. */
export function proxyFor(target: string, settings: ProxySettings): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const chosen = url.protocol === 'https:' ? (settings.https ?? settings.http) : settings.http;
  if (!chosen) return null;
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (settings.noProxy && excluded(host, port, settings.noProxy.value)) return null;
  return parseProxyUrl(chosen.value)?.host ?? null;
}

/** ` (through proxy host:port)` for evidence, or an empty string. */
export function viaProxy(target: string, settings: ProxySettings): string {
  const proxy = proxyFor(target, settings);
  return proxy ? ` (through proxy ${proxy})` : '';
}
