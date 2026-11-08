/**
 * One authenticated GET to a Google API through the guarded client: bearer token, `x-goog-user-project`
 * (FR-AUTH-04), JSON body, errors classified. A 401 invalidates the token and the request is retried once
 * with a fresh one: `gcloud` may hand out a cached token close to its expiry, and DCAM reuses tokens for
 * 30 minutes (ADR-0016).
 *
 * @implements FR-AUTH-01, FR-AUTH-04
 */
import { SourceError, type AccessTokenSource, type ReadOnlyHttp } from '@dcam/ports';
import { classifyGoogleError } from './google-errors';

export interface GoogleApiDeps {
  readonly http: ReadOnlyHttp;
  readonly tokens: AccessTokenSource;
  /** `auth.quotaProjectId`; `null` means the project of the resource being read. */
  readonly quotaProjectId: string | null;
  /** Epoch milliseconds, for `Retry-After` dates. */
  readonly now?: () => number;
}

/** A resource-name segment: no separators, no custom-method colon, nothing that needs escaping tricks. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function segment(name: string, value: string): string {
  if (!SEGMENT.test(value)) throw new RangeError(`${name} "${value}" is not a valid resource name segment`);
  return value;
}

export async function googleGetJson(
  deps: GoogleApiDeps,
  url: string,
  resourceProject: string,
): Promise<unknown> {
  const quotaProject = deps.quotaProjectId ?? resourceProject;
  for (let attempt = 1; ; attempt++) {
    const token = await deps.tokens.accessToken();
    const response = await deps.http.request({
      method: 'GET',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        'x-goog-user-project': quotaProject,
        accept: 'application/json',
      },
    });
    const text = await response.text();
    if (response.status === 401) deps.tokens.invalidate(token);
    if (response.status === 401 && attempt === 1) continue;
    if (response.status < 200 || response.status >= 300) {
      throw classifyGoogleError(response.status, text, response.headers, (deps.now ?? Date.now)());
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SourceError(
        'invalid-response',
        `${new URL(url).host} answered ${response.status} with a body that is not JSON.`,
        {
          status: response.status,
        },
      );
    }
  }
}
