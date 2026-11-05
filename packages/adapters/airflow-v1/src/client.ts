/**
 * The Airflow REST API v1 (Airflow 2) behind the {@link AirflowApi} port (spec Appendix B, §18.3).
 *
 * - GET only, through the guarded read-only client the composition root passes in.
 * - A Google OAuth 2.0 bearer token for Composer environments; basic authentication only for loopback
 *   URLs such as the local emulator (FR-EMU-02). No `x-goog-user-project`: that header is for Google APIs.
 * - Page sizes of at most 100 (Appendix B.1).
 * - Responses are validated with Zod and reduced to the port types; failures become {@link SourceError}.
 *
 * @implements FR-COLL-08, FR-EMU-02
 */
import { Buffer } from 'node:buffer';
import type { z } from 'zod';
import {
  SourceError,
  type AccessTokenSource,
  type AirflowApi,
  type AirflowPool,
  type HttpResponse,
  type ReadOnlyHttp,
  type TaskInstanceQuery,
} from '@dcam/ports';
import { statusError, thrownError, type AuthKind } from './errors';
import {
  dagCollectionWire,
  healthWire,
  importErrorCountWire,
  poolCollectionWire,
  providersWire,
  taskInstanceCollectionWire,
  toDagPage,
  toHealth,
  toPool,
  toTaskInstancePage,
  versionWire,
} from './wire';

export type AirflowAuth =
  | { readonly kind: 'bearer'; readonly tokens: AccessTokenSource }
  | { readonly kind: 'basic'; readonly username: string; readonly password: string };

export interface AirflowV1Options {
  readonly http: ReadOnlyHttp;
  /** The web server URL: Composer's `airflowUri`, or a loopback URL such as the emulator's. */
  readonly baseUrl: string;
  readonly auth: AirflowAuth;
  /** Per-request timeout in milliseconds (default 20,000). */
  readonly timeoutMs?: number;
  /** Clock for `Retry-After` dates (default `Date.now`). */
  readonly now?: () => number;
}

/** Largest page DCAM requests (Appendix B.1; also Airflow's default `[api] maximum_page_limit`). */
export const MAX_PAGE_SIZE = 100;
/** Pools are few; this stops a server that ignores `offset` from looping forever. */
const MAX_POOL_PAGES = 50;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Hosts on which basic authentication is acceptable (same set as the guard and the config file). */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

function apiRoot(baseUrl: string, auth: AirflowAuth): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('The Airflow baseUrl is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new TypeError('The Airflow baseUrl must use http or https.');
  if (url.username !== '' || url.password !== '')
    throw new TypeError('The Airflow baseUrl must not contain a user name or password.');
  if (auth.kind === 'basic' && !LOOPBACK_HOSTS.includes(url.hostname))
    throw new TypeError(
      `Basic authentication is allowed only for loopback Airflow URLs (127.0.0.1, localhost, [::1]), not ${url.host}. ` +
        'Other environments use a Google access token (FR-EMU-02).',
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/v1`;
}

function checkPage(limit: number, offset: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
    throw new RangeError(
      `Page size must be an integer from 1 to ${MAX_PAGE_SIZE}, not ${limit} (Appendix B.1).`,
    );
  if (!Number.isInteger(offset) || offset < 0)
    throw new RangeError(`Offset must be a non-negative integer, not ${offset}.`);
}

/** Largest epoch time a JavaScript Date can hold (ECMA-262 §21.4.1.1), in milliseconds. */
const MAX_EPOCH_MS = 8.64e15;

function isoTime(ms: number, name: string): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS)
    throw new RangeError(`${name} must be an epoch time in milliseconds within the range of a date.`);
  return new Date(ms).toISOString();
}

/** Names the failing field and the kind of problem, never the value (bodies are not quoted). */
function schemaProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unexpected response';
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
  const expected =
    'expected' in issue && typeof issue.expected === 'string' ? `, expected ${issue.expected}` : '';
  return `${path}: ${issue.code}${expected}`;
}

export function createAirflowV1Api(opts: AirflowV1Options): AirflowApi {
  const root = apiRoot(opts.baseUrl, opts.auth);
  const auth = opts.auth;
  const authKind: AuthKind = auth.kind;
  const tokens = auth.kind === 'bearer' ? auth.tokens : null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  // RFC 7617 with UTF-8 user name and password.
  const basic =
    auth.kind === 'basic'
      ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`
      : null;

  async function authorization(endpoint: string): Promise<string> {
    if (tokens === null) return basic ?? '';
    try {
      return `Bearer ${await tokens.accessToken()}`;
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError('unauthenticated', `No Google access token for Airflow API ${endpoint}`, {
        fixHint: 'Sign in with `gcloud auth application-default login`.',
      });
    }
  }

  /** One GET; a non-2xx status is returned, a failure before a response is thrown as SourceError. */
  async function send(
    path: string,
    query?: URLSearchParams,
  ): Promise<{ endpoint: string; res: HttpResponse }> {
    const endpoint = `GET /api/v1${path}`;
    const headers = { accept: 'application/json', authorization: await authorization(endpoint) };
    const qs = query?.toString();
    const url = `${root}${path}${qs ? `?${qs}` : ''}`;
    try {
      return { endpoint, res: await opts.http.request({ method: 'GET', url, headers, timeoutMs }) };
    } catch (error) {
      throw transportFailure(endpoint, error);
    }
  }

  function transportFailure(endpoint: string, error: unknown): SourceError {
    const e = thrownError(endpoint, error, authKind);
    // A redirect to a sign-in page means the token was rejected: fetch a fresh one next time (FR-AUTH-01).
    if (e.kind === 'unauthenticated') tokens?.invalidate();
    return e;
  }

  function fail(endpoint: string, res: HttpResponse): SourceError {
    // A rejected token is not retried here; the next call fetches a fresh one (FR-AUTH-01).
    if (res.status === 401) tokens?.invalidate();
    return statusError(endpoint, res, authKind, now());
  }

  async function discard(res: HttpResponse): Promise<void> {
    // Read and drop the body so the connection can be reused; it is never inspected.
    await res.text().catch(() => undefined);
  }

  async function parse<T>(endpoint: string, res: HttpResponse, schema: z.ZodType<T>): Promise<T> {
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      // A timeout or reset while the body arrives is transient, unlike a malformed body.
      throw transportFailure(endpoint, error);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SourceError('invalid-response', `Airflow API ${endpoint} did not answer with JSON`, {
        status: res.status,
      });
    }
    const result = schema.safeParse(json);
    if (!result.success)
      throw new SourceError(
        'invalid-response',
        `Airflow API ${endpoint} answered in an unexpected shape (${schemaProblem(result.error)})`,
        { status: res.status },
      );
    return result.data;
  }

  async function get<T>(path: string, schema: z.ZodType<T>, query?: URLSearchParams): Promise<T> {
    const { endpoint, res } = await send(path, query);
    if (res.status < 200 || res.status > 299) {
      await discard(res);
      throw fail(endpoint, res);
    }
    return parse(endpoint, res, schema);
  }

  const page = (limit: number, offset: number) =>
    new URLSearchParams({ limit: String(limit), offset: String(offset) });

  return {
    async version() {
      const w = await get('/version', versionWire);
      return { version: w.version };
    },

    async health() {
      return toHealth(await get('/health', healthWire));
    },

    async dags({ limit, offset }) {
      checkPage(limit, offset);
      return toDagPage(await get('/dags', dagCollectionWire, page(limit, offset)));
    },

    async pools() {
      const byName = new Map<string, AirflowPool>();
      let offset = 0;
      for (let n = 0; n < MAX_POOL_PAGES; n += 1) {
        const w = await get('/pools', poolCollectionWire, page(MAX_PAGE_SIZE, offset));
        for (const p of w.pools) byName.set(p.name, toPool(p));
        offset += w.pools.length;
        if (w.pools.length === 0 || offset >= w.total_entries) break;
      }
      return [...byName.values()];
    },

    async importErrorCount() {
      const w = await get('/importErrors', importErrorCountWire, new URLSearchParams({ limit: '1' }));
      return w.total_entries;
    },

    async taskInstances(q: TaskInstanceQuery) {
      checkPage(q.limit, q.offset);
      const query = new URLSearchParams();
      for (const state of q.states ?? []) query.append('state', state);
      if (q.updatedFrom !== undefined) query.set('updated_at_gte', isoTime(q.updatedFrom, 'updatedFrom'));
      if (q.updatedTo !== undefined) query.set('updated_at_lte', isoTime(q.updatedTo, 'updatedTo'));
      query.set('limit', String(q.limit));
      query.set('offset', String(q.offset));
      // `~` is the wildcard for dag_id and dag_run_id (v1.yaml at 2.11.1).
      return toTaskInstancePage(
        await get('/dags/~/dagRuns/~/taskInstances', taskInstanceCollectionWire, query),
      );
    },

    // `false` means only that the probe got 403. An identity without any Airflow role, or a wrong basic
    // password on Airflow 2.11.1, also gets 403: read it after an authenticated read has succeeded.
    async canReadProviders() {
      const { endpoint, res } = await send('/providers', new URLSearchParams({ limit: '1' }));
      if (res.status === 403) {
        await discard(res);
        return false;
      }
      if (res.status < 200 || res.status > 299) {
        await discard(res);
        throw fail(endpoint, res);
      }
      await parse(endpoint, res, providersWire);
      return true;
    },
  };
}
