/**
 * Airflow API failures as {@link SourceError}. Messages name the endpoint and the HTTP status only:
 * response bodies are never quoted, stored or logged (spec §7.1 rule 4).
 *
 * @implements FR-COLL-08, FR-COLL-06
 */
import { SourceError, type HttpResponse } from '@dcam/ports';

export type AuthKind = 'bearer' | 'basic';

const HINT_401: Record<AuthKind, string> = {
  bearer:
    'Sign in again with `gcloud auth application-default login`. If that does not help, ask an Airflow ' +
    'administrator whether your identity is registered as a user of this Airflow.',
  basic:
    'Check the Airflow user name and password in the environment variables that usernameEnv and ' +
    'passwordEnv name in the configuration file.',
};

const HINT_403: Record<AuthKind, string> = {
  bearer:
    'Ask an administrator of this environment to give your identity the Airflow Viewer role (DCAM needs ' +
    'no other Airflow role) and the IAM role roles/composer.viewer on its project (spec §18.3).',
  // Airflow 2.11.1 with the FAB provider 1.5.4 of the official image answers a missing or wrong basic
  // password with 403 PermissionDenied, not 401 (observed on the emulator, tools/emulator).
  basic:
    'Check the Airflow user name and password in the environment variables that usernameEnv and ' +
    'passwordEnv name: Airflow 2 answers 403 when they are wrong. If they are right, ask an Airflow ' +
    'administrator to give the user the Viewer role.',
};

const HINT_404 =
  'Check the Airflow URL. DCAM reads the Airflow REST API v1 under <url>/api/v1; Airflow 3 serves ' +
  '/api/v2 instead, which this version of DCAM does not support yet.';

const HINT_REDIRECT: Record<AuthKind, string> = {
  bearer:
    'The web server answered with a redirect, usually to a sign-in page, so it did not accept the access ' +
    "token. Check that the URL is the environment's airflowUri and sign in again with " +
    '`gcloud auth application-default login`. DCAM never follows redirects.',
  basic:
    'The web server answered with a redirect, usually to a sign-in page, so it did not accept the user ' +
    'name and password. Check that [api] auth_backends includes airflow.api.auth.backend.basic_auth. ' +
    'DCAM never follows redirects.',
};

/** `Retry-After` (RFC 9110 §10.2.3) in milliseconds: delay-seconds or an HTTP date measured from now. */
export function retryAfterMs(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The error for a non-2xx response. */
export function statusError(endpoint: string, res: HttpResponse, auth: AuthKind, now: number): SourceError {
  const status = res.status;
  const what = `Airflow API ${endpoint} answered HTTP ${status}`;
  const retry = retryAfterMs(res.headers.get('retry-after'), now);
  const withRetry = retry === undefined ? { status } : { status, retryAfterMs: retry };
  if (status === 401)
    return new SourceError('unauthenticated', `${what}: not signed in`, { status, fixHint: HINT_401[auth] });
  if (status === 403)
    return new SourceError('forbidden', `${what}: permission denied`, { status, fixHint: HINT_403[auth] });
  if (status === 404)
    return new SourceError('not-found', `${what}: not found`, { status, fixHint: HINT_404 });
  if (status === 429) return new SourceError('rate-limited', `${what}: too many requests`, withRetry);
  if (status >= 500)
    return new SourceError('unavailable', `${what}: the web server is unavailable`, withRetry);
  return new SourceError('invalid-response', `${what}: the API refused the request`, { status });
}

interface GuardLike {
  readonly name: 'GuardError';
  readonly code: string;
  readonly message: string;
}

/** `GuardError` of the guarded client, recognised by shape: adapters do not import each other. */
function isGuardError(error: unknown): error is GuardLike {
  return (
    error instanceof Error &&
    error.name === 'GuardError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** The error for a request that produced no HTTP response. */
export function thrownError(endpoint: string, error: unknown, auth: AuthKind): SourceError {
  if (error instanceof SourceError) return error;
  if (isGuardError(error)) {
    if (error.code === 'redirect')
      return new SourceError('unauthenticated', `Airflow API ${endpoint} answered with a redirect`, {
        fixHint: HINT_REDIRECT[auth],
      });
    return new SourceError('guard', `The guarded client refused Airflow API ${endpoint} (${error.code})`);
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError')
    return new SourceError('timeout', `Airflow API ${endpoint} timed out`);
  const detail = error instanceof Error ? `: ${error.message}` : '';
  return new SourceError('network', `Airflow API ${endpoint} failed before a response${detail}`);
}
