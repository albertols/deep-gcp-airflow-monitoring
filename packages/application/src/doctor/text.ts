/**
 * Evidence hygiene: every line the doctor prints passes through {@link evidence}, which removes
 * credentials (proxy user info, bearer and OAuth tokens) and keeps it to one line (spec §18.6).
 *
 * @implements FR-AUTH-01, FR-AUTH-05, FR-AUTH-07
 */

const MAX_EVIDENCE = 400;

/** Replaces credentials in free text, for example adapter error messages. */
export function redactSecrets(text: string): string {
  return (
    text
      // user:password@ in any URL, including proxy URLs.
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***')
      // Google OAuth 2.0 access tokens start with "ya29.".
      .replace(/\bya29\.[A-Za-z0-9._-]+/g, 'ya29.***')
      .replace(
        /\b(access_token|refresh_token|id_token|client_secret|password)(["']?\s*[:=]\s*["']?)[^\s"',&]+/gi,
        '$1$2***',
      )
  );
}

/** One redacted line, shortened to a readable length. */
export function evidence(text: string): string {
  const line = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return line.length > MAX_EVIDENCE ? `${line.slice(0, MAX_EVIDENCE - 1)}…` : line;
}

/** A path quoted for a POSIX shell, for copyable commands. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
