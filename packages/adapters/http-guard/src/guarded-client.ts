/**
 * The guarded HTTP client: the single choke point for calls to monitored systems (spec §11.4 rule 7,
 * §18.2, ADR-0006). Requests are checked before any network I/O; rejected requests never reach the
 * transport and are reported as security events. Requests that pass go through the proxy- and CA-aware
 * transport with a per-request timeout (FR-AUTH-07), and each one is reported to the footprint hook
 * (HM-030).
 *
 * @implements NFR-SEC-04, FR-AUTH-07, HM-030
 */
import { ALLOWLIST, type AllowEntry, type AllowedMethod, type Service } from './allowlist';
import { isLoopbackHostname } from './loopback';
import { createNetworkTransport, type NetworkEnv, type Transport } from './transport';
import { TransportError, toTransportError } from './transport-error';

export type NetworkMode = 'any' | 'loopback-only';

export type GuardErrorCode =
  | 'invalid-url'
  | 'unknown-host'
  | 'insecure-scheme'
  | 'non-loopback'
  | 'forbidden-header'
  | 'not-allowlisted'
  | 'invalid-body'
  | 'credentials-in-url'
  | 'redirect';

export class GuardError extends Error {
  override readonly name = 'GuardError';
  constructor(
    readonly code: GuardErrorCode,
    message: string,
    /** The HTTP status of a refused redirect; absent for requests refused before sending. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** For security events and messages: never the query string or embedded credentials. */
function describeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(not a valid URL)';
  }
}

/** A 3xx answer (status 0 for an opaque redirect), refused after the footprint event. */
interface Redirect {
  readonly redirect: number;
}

/** Largest delay Node.js timers accept; longer ones fire at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface GuardedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON body; only allowed for POST entries with a body validator. */
  readonly body?: unknown;
  /** Abort after this many milliseconds (default: the client's `timeoutMs`). */
  readonly timeoutMs?: number;
}

export type ResponseOutcome = 'ok' | 'http-error' | 'timeout' | 'network';

/**
 * One request that reached the transport, for DCAM's own footprint (HM-030). It deliberately holds no
 * URL, query string, header or token.
 */
export interface ResponseEvent {
  /** Start of the request, epoch milliseconds. */
  readonly at: number;
  readonly method: AllowedMethod;
  /** The allowlist entry that admitted the request, for example `airflow.v1.dags`. */
  readonly entryId: string;
  readonly service: Service;
  /** `null` when no response arrived (timeout, network failure). */
  readonly status: number | null;
  /** From the start of the request until the body was read or the request failed, in milliseconds. */
  readonly latencyMs: number;
  /** Body bytes read (after content decoding); 0 without a body. */
  readonly bytes: number;
  /** `ok` is 2xx; `http-error` is any other status, including a refused redirect. */
  readonly outcome: ResponseOutcome;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface GuardedClientOptions {
  readonly network: NetworkMode;
  /** Replaces the proxy- and CA-aware transport (tests); `proxyEnv` and `caBundlePath` then do nothing. */
  readonly transport?: Transport;
  /**
   * Proxy and CA variables for the default transport; the composition root passes `process.env`. Read:
   * `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (either case; lower case wins) and `NODE_EXTRA_CA_CERTS`.
   * Omitted: no proxy. `process.env` is never read implicitly, so tests do not depend on it.
   */
  readonly proxyEnv?: NetworkEnv;
  /** `network.caBundlePath`: a PEM bundle trusted in addition to Node's defaults; read once, here. */
  readonly caBundlePath?: string;
  /** Default per-request timeout in milliseconds (30 s). */
  readonly timeoutMs?: number;
  /** Clock for footprint events, epoch milliseconds. */
  readonly now?: () => number;
  /** Called once per request that reached the transport. Exceptions it throws are ignored. */
  readonly onResponse?: (event: ResponseEvent) => void;
  /** Extra exact `host[:port]` values per service, for example emulator endpoints on loopback. */
  readonly hosts?: Partial<Record<Service, readonly string[]>>;
  readonly onRejected?: (event: { code: GuardErrorCode; method: string; url: string }) => void;
  /**
   * Restrict the client to these ALLOWLIST entry IDs. The allowlist can only be narrowed here, never
   * widened: new entries go into allowlist.ts, which needs security review (spec §18.2 rule 6).
   */
  readonly allowlistIds?: readonly string[];
}

export interface GuardedClient {
  /**
   * Checks the request, sends it and reads the whole body before resolving. Throws {@link GuardError}
   * when the request is refused (never sent) or answered with a redirect, {@link TransportError} on a
   * timeout or a network failure, and `RangeError` for an invalid `timeoutMs`.
   */
  request(req: GuardedRequest): Promise<Response>;
  /** Closes the default transport's connections. */
  close(): Promise<void>;
}

const DEFAULT_HOSTS: Record<Service, (host: string) => boolean> = {
  airflow: (h) => h.endsWith('.composer.googleusercontent.com'),
  monitoring: (h) => h === 'monitoring.googleapis.com',
  logging: (h) => h === 'logging.googleapis.com',
  composer: (h) => h === 'composer.googleapis.com',
  storage: (h) => h === 'storage.googleapis.com',
};

const FORBIDDEN_HEADERS = new Set(['x-http-method-override', 'x-http-method', 'x-method-override']);
/** Statuses whose responses have no body (Fetch standard). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** `DCAM_NETWORK=loopback-only` (set in Claude Code sessions and tests) keeps every call on this machine. */
export function networkModeFromEnv(env: Readonly<Record<string, string | undefined>>): NetworkMode {
  const value = env['DCAM_NETWORK'];
  if (value === undefined || value === '' || value === 'any') return 'any';
  if (value === 'loopback-only') return 'loopback-only';
  // A mistyped safety switch must not silently open the network.
  throw new Error(`DCAM_NETWORK must be "loopback-only" or "any", not "${value}".`);
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `timeoutMs must be a positive number of milliseconds up to ${MAX_TIMEOUT_MS}, not ${timeoutMs}`,
    );
  }
}

export function createGuardedClient(options: GuardedClientOptions): GuardedClient {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertTimeout(defaultTimeoutMs);
  const now = options.now ?? Date.now;
  let allowlist: readonly AllowEntry[] = ALLOWLIST;
  if (options.allowlistIds) {
    const known = new Set(ALLOWLIST.map((e) => e.id));
    const unknown = options.allowlistIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`Unknown allowlist entry: ${unknown.join(', ')}`);
    const wanted = new Set(options.allowlistIds);
    allowlist = ALLOWLIST.filter((e) => wanted.has(e.id));
  }
  const network = options.transport
    ? undefined
    : createNetworkTransport({
        loopbackOnly: options.network === 'loopback-only',
        ...(options.proxyEnv === undefined ? {} : { env: options.proxyEnv }),
        ...(options.caBundlePath === undefined ? {} : { caBundlePath: options.caBundlePath }),
      });
  const transport: Transport | undefined = options.transport ?? network?.transport;
  if (!transport) throw new Error('unreachable: no transport');

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
      throw new GuardError('invalid-url', 'not a valid URL');
    }
    if (url.username || url.password) {
      throw new GuardError('credentials-in-url', 'credentials must not be embedded in URLs');
    }
    const loopback = isLoopbackHostname(url.hostname);
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
    const entry = allowlist.find(
      (e) => e.service === service && e.method === method && e.path.test(url.pathname),
    );
    if (!entry) throw new GuardError('not-allowlisted', `${method} ${url.pathname} is not an allowed read`);
    if (entry.body ? !entry.body(req.body) : req.body !== undefined) {
      throw new GuardError('invalid-body', `${method} ${url.pathname} has a body that is not a pure read`);
    }
    return { url, entry };
  }

  function emit(event: ResponseEvent): void {
    try {
      options.onResponse?.(event);
    } catch {
      // The footprint is best effort: a recorder bug must never fail a collection request.
    }
  }

  async function perform(
    send: Transport,
    url: URL,
    entry: AllowEntry,
    req: GuardedRequest,
    timeoutMs: number,
  ): Promise<Response | Redirect> {
    const what = `${entry.method} ${url.host}${url.pathname}`;
    const controller = new AbortController();
    // Redirects are never followed: a 3xx could point at a forbidden route or another host,
    // and fetch would replay the method, body and (same-origin) credentials there.
    const init = {
      method: entry.method,
      headers: entry.body ? { 'content-type': 'application/json', ...req.headers } : { ...req.headers },
      redirect: 'manual' as const,
      signal: controller.signal,
      ...(entry.body ? { body: JSON.stringify(req.body) } : {}),
    };
    const at = now();
    let status: number | null = null;
    let bytes = 0;
    let outcome: ResponseOutcome = 'network';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, rejectTimeout) => {
      timer = setTimeout(() => {
        const error = new TransportError('timeout', `${what} timed out after ${timeoutMs} ms`, {
          fixHint:
            'The server, or a proxy on the way, did not answer in time. DCAM retries later with backoff; ' +
            'if this persists, check the network connection and HTTPS_PROXY.',
        });
        controller.abort(error);
        rejectTimeout(error);
      }, timeoutMs);
    });

    const exchange = async (): Promise<Response | Redirect> => {
      const response = await send(url.toString(), init);
      status = response.status;
      if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
        await response.body?.cancel().catch(() => undefined);
        return { redirect: status };
      }
      if (status < 200 || status > 599) {
        throw new TransportError('network', `${what} answered with an invalid status ${status}`);
      }
      // The whole body is read here, under the timeout, so the footprint counts its bytes.
      const buffer = NULL_BODY.has(status) ? null : new Uint8Array(await response.arrayBuffer());
      bytes = buffer?.byteLength ?? 0;
      const headers = new Headers();
      response.headers.forEach((value, name) => headers.append(name, value));
      return new Response(buffer, { status, headers });
    };

    try {
      const result = await Promise.race([exchange(), timedOut]);
      outcome = status !== null && status >= 200 && status < 300 ? 'ok' : 'http-error';
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        outcome = 'timeout';
        const reason: unknown = controller.signal.reason;
        throw reason instanceof TransportError ? reason : error;
      }
      const failure = toTransportError(error, { method: entry.method, url, proxy: null });
      outcome = failure.kind;
      throw failure;
    } finally {
      clearTimeout(timer);
      emit({
        at,
        method: entry.method,
        entryId: entry.id,
        service: entry.service,
        status,
        latencyMs: Math.max(0, now() - at),
        bytes,
        outcome,
      });
    }
  }

  return {
    async request(req) {
      const reject = (error: unknown): never => {
        if (error instanceof GuardError)
          options.onRejected?.({ code: error.code, method: req.method, url: describeUrl(req.url) });
        throw error;
      };
      let checked: { url: URL; entry: AllowEntry } | undefined;
      try {
        checked = check(req);
      } catch (error) {
        reject(error);
      }
      if (!checked) throw new GuardError('not-allowlisted', 'unreachable');
      const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
      assertTimeout(timeoutMs);
      const result = await perform(transport, checked.url, checked.entry, req, timeoutMs);
      if (!(result instanceof Response)) {
        return reject(
          new GuardError(
            'redirect',
            `${checked.url.host} answered ${result.redirect}; DCAM does not follow redirects`,
            result.redirect,
          ),
        );
      }
      return result;
    },
    close: () => network?.close() ?? Promise.resolve(),
  };
}
