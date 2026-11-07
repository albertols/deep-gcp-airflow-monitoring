/**
 * Failures before a complete HTTP response: the per-request timeout, and DNS, TCP, TLS or proxy errors.
 * Each carries the most specific error code found in the cause chain and, where the user can act, a fix
 * hint (FR-AUTH-07). Messages never contain proxy credentials, headers or query strings.
 *
 * @implements FR-AUTH-07
 */
import { isLoopbackHostname } from './loopback';

export type TransportErrorKind = 'timeout' | 'network';

export class TransportError extends Error {
  override readonly name = 'TransportError';
  /** For example `ECONNREFUSED`, `ENOTFOUND` or `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. */
  readonly code: string | undefined;
  /** A next step for the user, when one is known. */
  readonly fixHint: string | undefined;
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
    details: { readonly code?: string; readonly fixHint?: string } = {},
  ) {
    super(message);
    this.code = details.code;
    this.fixHint = details.fixHint;
  }
}

/** Certificate chain problems, typical behind a TLS-inspecting corporate proxy. */
const UNTRUSTED_CERT = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_CHAIN_TOO_LONG',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UND_ERR_PRX_TLS',
]);
const CERT_DATES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']);
const DNS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL']);

interface Cause {
  readonly message: string;
  readonly code: string | undefined;
}

/** The error and its causes, outermost first (bounded, cycle-safe). */
function causes(error: unknown): Cause[] {
  const out: Cause[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current) && out.length < 6) {
    seen.add(current);
    const code: unknown = (current as { code?: unknown }).code;
    out.push({ message: current.message, code: typeof code === 'string' ? code : undefined });
    // Happy-eyeballs connection attempts fail with an AggregateError of the per-address errors.
    current =
      current.cause ?? (current instanceof AggregateError ? (current.errors as unknown[])[0] : undefined);
  }
  return out;
}

export interface FailureContext {
  readonly method: string;
  readonly url: URL;
  /** `host:port` of the proxy configured for this URL's scheme, without credentials; `null` without one. */
  readonly proxy: string | null;
  /** Removes secrets (proxy credentials) from text taken from lower layers. */
  readonly redact?: (text: string) => string;
}

/** Strips `user:password@` from any URL-looking text. */
const stripUserInfo = (text: string) => text.replace(/\/\/[^/\s@]*@/g, '//');

/** Maps an error thrown by a transport to a {@link TransportError} with a fix hint. */
export function toTransportError(error: unknown, context: FailureContext): TransportError {
  if (error instanceof TransportError) return error;
  const chain = causes(error);
  const clean = (t: string) => stripUserInfo(context.redact ? context.redact(t) : t);
  // The deepest code is the most specific (a system or TLS code under undici's wrapper).
  const code = [...chain].reverse().find((c) => c.code !== undefined)?.code;
  const messages = [...new Set(chain.map((c) => clean(c.message)).filter((m) => m !== ''))];
  const what = `${context.method} ${context.url.host}${context.url.pathname}`;
  const message = `${what} failed${code ? ` (${code})` : ''}: ${messages.join('; ') || 'unknown error'}`;
  const fixHint = hintFor(code, messages.join(' '), context);
  return new TransportError('network', message, {
    ...(code === undefined ? {} : { code }),
    ...(fixHint === undefined ? {} : { fixHint }),
  });
}

function hintFor(code: string | undefined, text: string, context: FailureContext): string | undefined {
  const host = context.url.host;
  if (/proxy/i.test(text) && /\b407\b/.test(text)) {
    return (
      'The proxy asked for authentication (407). Check HTTPS_PROXY and HTTP_PROXY: proxy credentials go in ' +
      'the URL as http://user:password@host:port, URL-encoded.'
    );
  }
  if (code !== undefined && UNTRUSTED_CERT.has(code)) {
    return (
      `The TLS certificate presented for ${host} is not trusted (${code}). Behind a TLS-inspecting ` +
      "corporate proxy, save your organisation's root CA bundle as a PEM file and either start DCAM with " +
      'NODE_EXTRA_CA_CERTS=<file> or set network.caBundlePath in dcam.config.yaml. If you use a proxy, ' +
      'also check HTTPS_PROXY.'
    );
  }
  if (code !== undefined && CERT_DATES.has(code)) {
    return (
      `The TLS certificate presented for ${host} has expired or is not valid yet (${code}). Check this ` +
      "computer's date and time; if a TLS-inspecting proxy presented it, tell its administrators."
    );
  }
  if (/proxy/i.test(text) || context.proxy !== null) {
    const via = context.proxy === null ? 'a proxy' : `the proxy ${context.proxy}`;
    return (
      `The request through ${via} failed${code ? ` (${code})` : ''}. Check HTTPS_PROXY and HTTP_PROXY ` +
      '(host, port and credentials), and NO_PROXY for hosts that must be reached directly.'
    );
  }
  if (isLoopbackHostname(context.url.hostname)) {
    return `Nothing answered on ${host}. Is the local server (for example the emulator) running?`;
  }
  if (code !== undefined && DNS.has(code)) {
    return (
      `${context.url.hostname} could not be resolved (${code}). If this network reaches the internet only ` +
      'through a proxy, set HTTPS_PROXY (and NO_PROXY for internal hosts) before starting DCAM.'
    );
  }
  return (
    `Could not connect to ${host}${code ? ` (${code})` : ''}. Check the network connection; if this ` +
    'network reaches the internet only through a proxy, set HTTPS_PROXY before starting DCAM.'
  );
}
