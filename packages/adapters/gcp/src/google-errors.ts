/**
 * Classifies Google API error responses into {@link SourceError}s with a next step for the user.
 *
 * Shapes, from Google's documentation:
 * - Body `{"error": {"code": <HTTP status>, "message", "status": <google.rpc.Code name>, "details": [Any]}}`,
 *   with `google.rpc.ErrorInfo` details carrying `reason`, `domain` and `metadata` (AIP-193,
 *   https://google.aip.dev/193). Older responses also carry `errors[].reason` (for example
 *   `accessNotConfigured`, `vpcServiceControls`).
 * - Reasons and metadata keys (`SERVICE_DISABLED`, `USER_PROJECT_DENIED`: `consumer`, `service`;
 *   `SECURITY_POLICY_VIOLATED`: `uid`, `consumer`, `service`; `IAM_PERMISSION_DENIED`: `permission`,
 *   `resource`): https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto
 * - VPC Service Controls: a 403 whose message carries `vpcServiceControlsUniqueIdentifier: <id>`, with a
 *   `google.rpc.PreconditionFailure` violation of type `VPC_SERVICE_CONTROLS` whose description is the id,
 *   or the legacy `errors[].reason` `vpcServiceControls`:
 *   https://docs.cloud.google.com/vpc-service-controls/docs/troubleshooting
 * - Quota project with user credentials: errors naming project 764086051850 (the Google Cloud CLI's own
 *   project) mean no quota project was used; the quota project needs `serviceusage.services.use`:
 *   https://docs.cloud.google.com/docs/authentication/adc-troubleshooting/user-creds
 *
 * @implements FR-AUTH-04, FR-AUTH-06
 */
import { z } from 'zod';
import { SourceError, type SourceErrorKind } from '@dcam/ports';

const GCLOUD_CLI_PROJECT = 'projects/764086051850';
const VPC_SC_ID = /vpcServiceControlsUniqueIdentifier:\s*([A-Za-z0-9_-]+)/;

const Detail = z
  .object({
    '@type': z.string().optional(),
    reason: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    violations: z
      .array(z.object({ type: z.string().optional(), description: z.string().optional() }))
      .optional(),
    retryDelay: z.string().optional(),
  })
  .loose();

const ErrorBody = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    details: z.array(z.unknown()).optional(),
    errors: z.array(z.object({ reason: z.string().optional() }).loose()).optional(),
  }),
});

interface Parsed {
  readonly json: boolean;
  readonly message: string;
  readonly status: string | undefined;
  readonly reasons: ReadonlySet<string>;
  readonly metadata: Readonly<Record<string, string>>;
  readonly vpcScViolation: string | undefined;
  readonly vpcScViolated: boolean;
  readonly retryDelayMs: number | undefined;
}

/** Tags stripped and whitespace folded, for bodies that are not Google errors (proxies, load balancers). */
function plain(text: string): string {
  return text
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** A protobuf Duration in JSON: `"2.5s"`. */
function durationMs(value: string | undefined): number | undefined {
  const m = value === undefined ? null : /^(\d+(?:\.\d+)?)s$/.exec(value);
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

function parse(bodyText: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    raw = undefined;
  }
  const body = ErrorBody.safeParse(raw);
  if (!body.success) {
    return {
      json: false,
      message: plain(bodyText),
      status: undefined,
      reasons: new Set(),
      metadata: {},
      vpcScViolation: undefined,
      vpcScViolated: false,
      retryDelayMs: undefined,
    };
  }
  const error = body.data.error;
  const reasons = new Set<string>();
  let metadata: Record<string, string> = {};
  let vpcScViolation: string | undefined;
  let vpcScViolated = false;
  let retryDelayMs: number | undefined;
  for (const item of error.details ?? []) {
    const detail = Detail.safeParse(item);
    if (!detail.success) continue;
    const type = detail.data['@type'] ?? '';
    if (type.endsWith('google.rpc.ErrorInfo') && detail.data.reason) {
      reasons.add(detail.data.reason);
      metadata = { ...metadata, ...detail.data.metadata };
    }
    if (type.endsWith('google.rpc.PreconditionFailure')) {
      for (const v of detail.data.violations ?? []) {
        if (v.type === 'VPC_SERVICE_CONTROLS') {
          vpcScViolated = true;
          vpcScViolation ??= v.description;
        }
      }
    }
    if (type.endsWith('google.rpc.RetryInfo')) retryDelayMs = durationMs(detail.data.retryDelay);
  }
  for (const e of error.errors ?? []) if (e.reason) reasons.add(e.reason);
  return {
    json: true,
    message: (error.message ?? '').slice(0, 400),
    status: error.status,
    reasons,
    metadata,
    vpcScViolation,
    vpcScViolated,
    retryDelayMs,
  };
}

/** `Retry-After` as delay-seconds or an HTTP date (RFC 9110 §10.2.3), in milliseconds from `now`. */
function retryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date) || !/[a-z]/i.test(value)) return undefined;
  return date > now ? date - now : undefined;
}

const projectOf = (consumer: string | undefined) => consumer?.replace(/^projects\//, '');

/**
 * Maps a non-2xx Google API response to a {@link SourceError}. `now` (epoch ms) resolves an HTTP-date
 * `Retry-After`.
 */
export function classifyGoogleError(
  status: number,
  bodyText: string,
  headers: { get(name: string): string | null },
  now: number = Date.now(),
): SourceError {
  const p = parse(bodyText);
  const said = p.message ? `: ${p.message}` : '';
  const code = p.status ? `${status} ${p.status}` : String(status);
  const make = (
    kind: SourceErrorKind,
    message: string,
    fixHint?: string,
    extra: { retryAfterMs?: number } = {},
  ) => new SourceError(kind, message, { status, ...extra, ...(fixHint === undefined ? {} : { fixHint }) });

  // VPC Service Controls first: it is a 403 like IAM, but no role grant fixes it (FR-AUTH-06).
  const messageId = VPC_SC_ID.exec(p.message)?.[1];
  if (
    p.reasons.has('SECURITY_POLICY_VIOLATED') ||
    p.reasons.has('vpcServiceControls') ||
    p.vpcScViolated ||
    messageId !== undefined ||
    /violates VPC Service Controls/i.test(p.message)
  ) {
    const id = p.metadata['uid'] ?? p.vpcScViolation ?? messageId;
    return new SourceError(
      'vpc-sc',
      `A VPC Service Controls perimeter denied the request (${code})${id ? `, unique identifier ${id}` : ''}.`,
      {
        status,
        ...(id === undefined ? {} : { vpcScId: id }),
        fixHint:
          `Send ${id ? `the unique identifier ${id}` : 'the time of the request'} to your security administrators: ` +
          'they can look it up in the VPC Service Controls violation analyzer ' +
          '(https://docs.cloud.google.com/vpc-service-controls/docs/troubleshooter) and add an ingress rule ' +
          'for your identity. DCAM does not retry this call until you re-run the check.',
      },
    );
  }

  const consumer = p.metadata['consumer'];
  if (
    p.reasons.has('USER_PROJECT_DENIED') ||
    consumer === GCLOUD_CLI_PROJECT ||
    /\b764086051850\b/.test(p.message) ||
    /requires a quota project/i.test(p.message)
  ) {
    const denied = consumer && consumer !== GCLOUD_CLI_PROJECT ? ` (${projectOf(consumer)})` : '';
    return make(
      'quota-project',
      `The quota project${denied} cannot be used for this request (${code})${said}`,
      'Use a quota project where you have serviceusage.services.use (role Service Usage Consumer) and the API ' +
        'is enabled: set auth.quotaProjectId in dcam.config.yaml (DCAM sends it as x-goog-user-project), and for ' +
        'other tools run: gcloud auth application-default set-quota-project <project>',
    );
  }

  if (p.reasons.has('SERVICE_DISABLED') || p.reasons.has('accessNotConfigured')) {
    const service = p.metadata['service'] ?? /([a-z]+\.googleapis\.com)/.exec(p.message)?.[1];
    const project = projectOf(consumer) ?? /in project (\S+?) before/.exec(p.message)?.[1];
    const command = `gcloud services enable ${service ?? '<service>.googleapis.com'} --project=${project ?? '<project>'}`;
    return make(
      'api-disabled',
      `${service ?? 'The API'} is not enabled in ${project ? `project ${project}` : 'the project'} (${code})${said}`,
      `DCAM never changes your projects. Ask a project owner to enable the API, or run it yourself if you may: ${command}`,
    );
  }

  const retry = retryAfter(headers.get('retry-after'), now) ?? p.retryDelayMs;
  const retryExtra = retry === undefined ? {} : { retryAfterMs: retry };

  if (status === 401) {
    return make(
      'unauthenticated',
      `Google rejected the access token (${code})${said}`,
      'Sign in again for Application Default Credentials: gcloud auth application-default login',
    );
  }
  if (status === 403) {
    if (!p.json) {
      return make(
        'forbidden',
        `Access denied (${code}), and the response is not a Google API error${p.message ? `: ${p.message}` : ''}`,
        'The answer may come from a proxy or firewall on the way: check HTTPS_PROXY and that the proxy allows *.googleapis.com.',
      );
    }
    const permission = p.metadata['permission'];
    return make(
      'forbidden',
      `Permission denied (${code})${said}`,
      permission
        ? `Ask for a role that grants ${permission}${p.metadata['resource'] ? ` on ${p.metadata['resource']}` : ''}.`
        : 'Ask for read access: roles/composer.user for Composer and roles/monitoring.viewer for Cloud Monitoring.',
    );
  }
  if (status === 404)
    return make(
      'not-found',
      `Not found (${code})${said}`,
      'Check the project, location and environment names in dcam.config.yaml.',
    );
  if (status === 429) {
    return make('rate-limited', `Rate limited (${code})${said}`, undefined, retryExtra);
  }
  if (status >= 500)
    return make('unavailable', `Google API unavailable (${code})${said}`, undefined, retryExtra);
  return make('invalid-response', `Google rejected the request (${code})${said}`);
}
