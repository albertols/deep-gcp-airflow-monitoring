/**
 * Network-facing ports. Adapters never import each other (ADR-0004 rule 3), so the Airflow and Google
 * adapters receive the guarded read-only client and the credentials through these interfaces, wired by
 * the composition root (apps/server).
 */

/** The part of a fetch `Response` adapters use (kept structural so ports need no DOM types). */
export interface HttpResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The guarded client's shape (`@dcam/http-guard`): every request is checked against the allowlist. */
export interface ReadOnlyHttp {
  request(req: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    /** Abort the request after this many milliseconds; it then fails with a timeout. */
    readonly timeoutMs?: number;
  }): Promise<HttpResponse>;
}

/** Google OAuth 2.0 access tokens for the active identity, held in memory only (FR-AUTH-01). */
export interface AccessTokenSource {
  /** A valid token, refreshed when it is about to expire. */
  accessToken(): Promise<string>;
  /**
   * Forget the cached token, for example after a 401. With `token`, only if that is still the cached
   * one: a late 401 for an old token must not throw away a fresh one.
   */
  invalidate(token?: string): void;
}

/** Why a call to a monitored system failed, in terms collectors and the doctor act on. */
export type SourceErrorKind =
  /** No usable credentials, or the token was rejected (401). */
  | 'unauthenticated'
  /** The identity lacks a permission or an Airflow role (403). */
  | 'forbidden'
  /** The quota project is missing, or the identity may not use it (FR-AUTH-04). */
  | 'quota-project'
  /** A VPC Service Controls perimeter denied the call (FR-AUTH-06): never retried automatically. */
  | 'vpc-sc'
  /** The API is disabled in the project. */
  | 'api-disabled'
  | 'not-found'
  /** 429: back off, honouring `Retry-After`. */
  | 'rate-limited'
  /** 5xx. */
  | 'unavailable'
  | 'timeout'
  /** DNS, TCP, TLS or proxy failure before an HTTP response. */
  | 'network'
  /** The response did not match the expected schema. */
  | 'invalid-response'
  /** The guarded client refused the request (a bug: DCAM asked for something it must not). */
  | 'guard'
  /** The source does not support this environment, for example Airflow 3 before the v2 adapter. */
  | 'unsupported';

export class SourceError extends Error {
  override readonly name = 'SourceError';
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
    readonly details: {
      readonly status?: number;
      /** From `Retry-After`, in milliseconds. */
      readonly retryAfterMs?: number;
      /** A copyable next step for the user. */
      readonly fixHint?: string;
      /** VPC Service Controls unique identifier, when present (FR-AUTH-06). */
      readonly vpcScId?: string;
    } = {},
  ) {
    super(message);
  }

  /** Errors worth retrying later with backoff; the others need the user to act first. */
  get transient(): boolean {
    return (
      this.kind === 'rate-limited' ||
      this.kind === 'unavailable' ||
      this.kind === 'timeout' ||
      this.kind === 'network'
    );
  }
}
