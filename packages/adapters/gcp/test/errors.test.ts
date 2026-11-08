/**
 * Error bodies are hand-written from Google's documentation (fictitious `acme-*` values):
 * - AIP-193 error model and google.rpc.ErrorInfo: https://google.aip.dev/193
 * - ErrorInfo reasons and metadata keys: https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto
 * - VPC Service Controls denials: https://docs.cloud.google.com/vpc-service-controls/docs/troubleshooting
 * - Quota project with user credentials: https://docs.cloud.google.com/docs/authentication/adc-troubleshooting/user-creds
 */
import { describe, expect, it } from 'vitest';
import { SourceError, type SourceErrorKind } from '@dcam/ports';
import { classifyGoogleError } from '../src/index';

const NOW = Date.parse('2026-11-05T10:00:00Z');
const headers = (h: Record<string, string> = {}) => {
  const m = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => m.get(name.toLowerCase()) ?? null };
};

const errorInfo = (reason: string, metadata: Record<string, string>) => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason,
  domain: 'googleapis.com',
  metadata,
});

const body = (code: number, status: string, message: string, details: unknown[] = [], extra = {}) =>
  JSON.stringify({ error: { code, message, status, details, ...extra } });

interface Row {
  readonly name: string;
  readonly status: number;
  readonly body: string;
  readonly headers?: Record<string, string>;
  readonly kind: SourceErrorKind;
  readonly hint?: RegExp;
  readonly vpcScId?: string;
  readonly retryAfterMs?: number;
}

const ROWS: Row[] = [
  {
    name: '401 invalid credentials',
    status: 401,
    body: body(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.', [
      errorInfo('ACCESS_TOKEN_EXPIRED', { service: 'composer.googleapis.com', method: 'GetEnvironment' }),
    ]),
    kind: 'unauthenticated',
    hint: /gcloud auth application-default login/,
  },
  {
    name: '403 IAM permission denied',
    status: 403,
    body: body(403, 'PERMISSION_DENIED', "Permission 'composer.environments.get' denied on resource.", [
      errorInfo('IAM_PERMISSION_DENIED', {
        permission: 'composer.environments.get',
        resource: 'projects/acme-prod-123/locations/europe-west1/environments/acme-composer-prod',
      }),
    ]),
    kind: 'forbidden',
    hint: /composer\.environments\.get/,
  },
  {
    name: '403 without details',
    status: 403,
    body: body(403, 'PERMISSION_DENIED', 'The caller does not have permission'),
    kind: 'forbidden',
  },
  {
    name: 'USER_PROJECT_DENIED (quota project not usable)',
    status: 403,
    body: body(
      403,
      'PERMISSION_DENIED',
      'Caller does not have required permission to use project acme-billing-456.',
      [
        errorInfo('USER_PROJECT_DENIED', {
          consumer: 'projects/acme-billing-456',
          service: 'monitoring.googleapis.com',
        }),
      ],
    ),
    kind: 'quota-project',
    hint: /gcloud auth application-default set-quota-project <project>.*serviceusage\.services\.use|serviceusage\.services\.use.*gcloud auth application-default set-quota-project <project>/s,
  },
  {
    name: 'API requires a quota project (gcloud CLI project 764086051850)',
    status: 403,
    body: body(
      403,
      'PERMISSION_DENIED',
      'Your application is authenticating by using local Application Default Credentials. The monitoring.googleapis.com API requires a quota project, which is not set by default.',
      [
        errorInfo('SERVICE_DISABLED', {
          consumer: 'projects/764086051850',
          service: 'monitoring.googleapis.com',
        }),
      ],
    ),
    kind: 'quota-project',
    hint: /set-quota-project/,
  },
  {
    name: 'SERVICE_DISABLED',
    status: 403,
    body: body(
      403,
      'PERMISSION_DENIED',
      'Cloud Composer API has not been used in project 123456789012 before or it is disabled.',
      [
        errorInfo('SERVICE_DISABLED', {
          consumer: 'projects/123456789012',
          service: 'composer.googleapis.com',
        }),
      ],
    ),
    kind: 'api-disabled',
    hint: /gcloud services enable composer\.googleapis\.com --project=123456789012/,
  },
  {
    name: 'legacy accessNotConfigured',
    status: 403,
    body: JSON.stringify({
      error: {
        code: 403,
        message:
          'Access Not Configured. Cloud Monitoring API has not been used in project 123456789012 before or it is disabled.',
        errors: [{ message: 'Access Not Configured.', domain: 'usageLimits', reason: 'accessNotConfigured' }],
      },
    }),
    kind: 'api-disabled',
    hint: /gcloud services enable/,
  },
  {
    name: 'VPC-SC: ErrorInfo SECURITY_POLICY_VIOLATED with uid',
    status: 403,
    body: body(
      403,
      'PERMISSION_DENIED',
      "Request is prohibited by organization's policy. vpcServiceControlsUniqueIdentifier: acmeVpcScId0001",
      [
        {
          '@type': 'type.googleapis.com/google.rpc.PreconditionFailure',
          violations: [{ type: 'VPC_SERVICE_CONTROLS', description: 'acmeVpcScId0001' }],
        },
        errorInfo('SECURITY_POLICY_VIOLATED', {
          uid: 'acmeVpcScId0001',
          consumer: 'projects/123456789012',
          service: 'monitoring.googleapis.com',
        }),
      ],
    ),
    kind: 'vpc-sc',
    vpcScId: 'acmeVpcScId0001',
    hint: /acmeVpcScId0001/,
  },
  {
    name: 'VPC-SC: PreconditionFailure violation only',
    status: 403,
    body: body(403, 'PERMISSION_DENIED', 'Request is prohibited by organization policy', [
      {
        '@type': 'type.googleapis.com/google.rpc.PreconditionFailure',
        violations: [{ type: 'VPC_SERVICE_CONTROLS', description: 'acmeVpcScId0002' }],
      },
    ]),
    kind: 'vpc-sc',
    vpcScId: 'acmeVpcScId0002',
  },
  {
    name: 'VPC-SC: identifier in the message only',
    status: 403,
    body: body(
      403,
      'PERMISSION_DENIED',
      "Request is prohibited by organization's policy. vpcServiceControlsUniqueIdentifier: acme-Vpc_Sc-0003.",
    ),
    kind: 'vpc-sc',
    vpcScId: 'acme-Vpc_Sc-0003',
  },
  {
    name: 'VPC-SC: legacy errors[].reason vpcServiceControls without identifier',
    status: 403,
    body: JSON.stringify({
      error: {
        code: 403,
        message: 'Request violates VPC Service Controls.',
        errors: [
          {
            message: 'Request violates VPC Service Controls.',
            domain: 'global',
            reason: 'vpcServiceControls',
          },
        ],
      },
    }),
    kind: 'vpc-sc',
  },
  {
    name: '404',
    status: 404,
    body: body(404, 'NOT_FOUND', 'Environment acme-composer-prod not found.'),
    kind: 'not-found',
  },
  {
    name: '429 with Retry-After seconds',
    status: 429,
    body: body(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for quota metric.', [
      errorInfo('RATE_LIMIT_EXCEEDED', {
        consumer: 'projects/123456789012',
        service: 'monitoring.googleapis.com',
        quota_metric: 'acme',
        quota_limit: 'acme',
      }),
    ]),
    headers: { 'Retry-After': '17' },
    kind: 'rate-limited',
    retryAfterMs: 17_000,
  },
  {
    name: '429 with Retry-After HTTP date',
    status: 429,
    body: body(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.'),
    headers: { 'retry-after': 'Thu, 05 Nov 2026 10:00:30 GMT' },
    kind: 'rate-limited',
    retryAfterMs: 30_000,
  },
  {
    name: '429 with google.rpc.RetryInfo and no header',
    status: 429,
    body: body(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', [
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2.5s' },
    ]),
    kind: 'rate-limited',
    retryAfterMs: 2_500,
  },
  {
    name: '500',
    status: 500,
    body: body(500, 'INTERNAL', 'Internal error encountered.'),
    kind: 'unavailable',
  },
  {
    name: '503 with Retry-After',
    status: 503,
    body: body(503, 'UNAVAILABLE', 'The service is currently unavailable.'),
    headers: { 'retry-after': '5' },
    kind: 'unavailable',
    retryAfterMs: 5_000,
  },
  {
    name: 'non-JSON 403 from a proxy',
    status: 403,
    body: '<html><body><h1>Access denied</h1><p>acme corporate proxy</p></body></html>',
    kind: 'forbidden',
    hint: /proxy/i,
  },
  { name: 'non-JSON 502', status: 502, body: 'Bad Gateway', kind: 'unavailable' },
  {
    name: '400 invalid argument',
    status: 400,
    body: body(400, 'INVALID_ARGUMENT', 'Field filter had an invalid value.'),
    kind: 'invalid-response',
  },
];

describe('FR-AUTH-06 Google error classification', () => {
  it.each(ROWS.map((r) => [r.name, r] as const))('FR-AUTH-06: %s', (_name, row) => {
    const error = classifyGoogleError(row.status, row.body, headers(row.headers), NOW);
    expect(error).toBeInstanceOf(SourceError);
    expect(error.kind).toBe(row.kind);
    expect(error.details.status).toBe(row.status);
    if (row.hint) expect(error.details.fixHint).toMatch(row.hint);
    if (row.vpcScId) expect(error.details.vpcScId).toBe(row.vpcScId);
    if (row.retryAfterMs !== undefined) expect(error.details.retryAfterMs).toBe(row.retryAfterMs);
    expect(error.message.length).toBeLessThan(600);
  });

  it('FR-AUTH-06: a VPC-SC denial is never transient (not retried automatically)', () => {
    const vpc = ROWS.find((r) => r.kind === 'vpc-sc');
    expect(vpc).toBeDefined();
    if (vpc) expect(classifyGoogleError(vpc.status, vpc.body, headers()).transient).toBe(false);
  });

  it('FR-AUTH-06: the Google message is shown, HTML is not', () => {
    expect(
      classifyGoogleError(404, body(404, 'NOT_FOUND', 'Environment acme-x not found.'), headers()).message,
    ).toContain('Environment acme-x not found.');
    const html = classifyGoogleError(403, '<html><body>denied</body></html>', headers());
    expect(html.message).not.toContain('<');
  });

  it('FR-AUTH-06: an unusable Retry-After is ignored', () => {
    for (const value of ['soon', '-3', 'Mon, 01 Jan 2001 00:00:00 GMT']) {
      const error = classifyGoogleError(429, '{}', headers({ 'retry-after': value }), NOW);
      expect(error.kind).toBe('rate-limited');
      expect(error.details.retryAfterMs ?? 0).toBe(0);
    }
  });
});
