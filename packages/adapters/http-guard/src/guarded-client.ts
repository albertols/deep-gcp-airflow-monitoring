/**
 * The guarded HTTP client: the single choke point for calls to monitored systems (spec §11.4 rule 7,
 * §18.2, ADR-0006). Requests are checked before any network I/O; rejected requests never reach the
 * transport and are reported as security events.
 *
 * @implements NFR-SEC-04
 */
import { ALLOWLIST, type AllowEntry, type Service } from './allowlist';

export type NetworkMode = 'any' | 'loopback-only';

export type GuardErrorCode =
  | 'invalid-url'
  | 'unknown-host'
  | 'insecure-scheme'
  | 'non-loopback'
  | 'forbidden-header'
  | 'not-allowlisted'
  | 'invalid-body';

export class GuardError extends Error {
  override readonly name = 'GuardError';
  constructor(
    readonly code: GuardErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface GuardedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON body; only allowed for POST entries with a body validator. */
  readonly body?: unknown;
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface GuardedClientOptions {
  readonly network: NetworkMode;
  readonly transport?: Transport;
  /** Extra exact `host[:port]` values per service, for example emulator endpoints on loopback. */
  readonly hosts?: Partial<Record<Service, readonly string[]>>;
  readonly onRejected?: (event: { code: GuardErrorCode; method: string; url: string }) => void;
  readonly allowlist?: readonly AllowEntry[];
}

export interface GuardedClient {
  request(req: GuardedRequest): Promise<Response>;
}

const DEFAULT_HOSTS: Record<Service, (host: string) => boolean> = {
  airflow: (h) => h.endsWith('.composer.googleusercontent.com'),
  monitoring: (h) => h === 'monitoring.googleapis.com',
  logging: (h) => h === 'logging.googleapis.com',
  composer: (h) => h === 'composer.googleapis.com',
  storage: (h) => h === 'storage.googleapis.com',
};

const FORBIDDEN_HEADERS = new Set(['x-http-method-override', 'x-http-method', 'x-method-override']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `DCAM_NETWORK=loopback-only` (set in Claude Code sessions and tests) keeps every call on this machine. */
export function networkModeFromEnv(env: Readonly<Record<string, string | undefined>>): NetworkMode {
  return env['DCAM_NETWORK'] === 'loopback-only' ? 'loopback-only' : 'any';
}

export function createGuardedClient(options: GuardedClientOptions): GuardedClient {
  const transport: Transport = options.transport ?? ((url, init) => fetch(url, init));
  const allowlist = options.allowlist ?? ALLOWLIST;

  function serviceFor(url: URL): Service | undefined {
    for (const service of Object.keys(DEFAULT_HOSTS) as Service[]) {
      if (options.hosts?.[service]?.includes(url.host)) return service;
      if (DEFAULT_HOSTS[service](url.hostname)) return service;
    }
    return undefined;
  }

  function check(req: GuardedRequest): { url: URL; entry: AllowEntry } {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new GuardError('invalid-url', `not a valid URL: ${req.url}`);
    }
    const loopback = LOOPBACK.has(url.hostname);
    if (options.network === 'loopback-only' && !loopback) {
      throw new GuardError('non-loopback', `DCAM_NETWORK=loopback-only forbids ${url.host}`);
    }
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      throw new GuardError('insecure-scheme', `only HTTPS is allowed for ${url.host}`);
    }
    const service = serviceFor(url);
    if (!service) throw new GuardError('unknown-host', `${url.host} is not a monitored service`);
    for (const name of Object.keys(req.headers ?? {})) {
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
        throw new GuardError('forbidden-header', `header ${name} could change the HTTP method`);
      }
    }
    const method = req.method.toUpperCase();
    const entry = allowlist.find((e) => e.service === service && e.method === method && e.path.test(url.pathname));
    if (!entry) throw new GuardError('not-allowlisted', `${method} ${url.pathname} is not an allowed read`);
    if (entry.body ? !entry.body(req.body) : req.body !== undefined) {
      throw new GuardError('invalid-body', `${method} ${url.pathname} has a body that is not a pure read`);
    }
    return { url, entry };
  }

  return {
    async request(req) {
      let checked: { url: URL; entry: AllowEntry };
      try {
        checked = check(req);
      } catch (error) {
        if (error instanceof GuardError) options.onRejected?.({ code: error.code, method: req.method, url: req.url });
        throw error;
      }
      const init: RequestInit = { method: checked.entry.method, headers: { ...req.headers } };
      if (checked.entry.body) {
        init.body = JSON.stringify(req.body);
        init.headers = { 'content-type': 'application/json', ...req.headers };
      }
      return transport(checked.url.toString(), init);
    },
  };
}
