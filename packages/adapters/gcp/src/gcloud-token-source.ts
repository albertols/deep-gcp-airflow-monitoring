/**
 * Google OAuth 2.0 access tokens for the user's Application Default Credentials, asked from the Google
 * Cloud CLI (ADR-0016): `gcloud auth application-default print-access-token` with fixed arguments and no
 * shell. The token is held in memory only, for 30 minutes (tokens last 3600 s; the CLI prints no expiry),
 * and dropped on `invalidate()`, for example after a 401.
 *
 * - Command reference: https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/print-access-token
 * - Windows: `gcloud` is `gcloud.cmd`, which Node.js cannot spawn without a shell since the
 *   CVE-2024-27980 fix (https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2), so it
 *   runs as `cmd.exe /d /s /c gcloud.cmd …` with the same fixed arguments; nothing user-supplied reaches
 *   the command line.
 *
 * @implements FR-AUTH-01, FR-AUTH-02
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { win32 } from 'node:path';
import { SourceError, type AccessTokenSource } from '@dcam/ports';

type Env = Readonly<Record<string, string | undefined>>;

export interface CommandResult {
  /** `null` when the child did not exit normally (killed on timeout). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Runs `file` with `args`, never through a shell. Rejects only when the program cannot be started (for
 * example `code: 'ENOENT'`); a non-zero exit resolves with its code.
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: {
    readonly timeoutMs: number;
    /** The child's whole environment; omitted: inherit this process's. */
    readonly env?: Env;
  },
) => Promise<CommandResult>;

export interface GcloudTokenSourceOptions {
  readonly run?: CommandRunner;
  readonly platform?: NodeJS.Platform;
  /** Environment for locating `cmd.exe` and for the child on Windows (default `process.env`). */
  readonly env?: Env;
  /** Epoch milliseconds. */
  readonly now?: () => number;
  /** How long a token is reused (30 min). */
  readonly ttlMs?: number;
  /** Child process timeout (20 s). */
  readonly timeoutMs?: number;
}

export const GCLOUD_TOKEN_TTL_MS = 30 * 60_000;
export const GCLOUD_TIMEOUT_MS = 20_000;
const ARGS = ['auth', 'application-default', 'print-access-token'] as const;
const INSTALL_URL = 'https://cloud.google.com/sdk/docs/install';
const LOGIN = 'gcloud auth application-default login';

const systemRoot = (env: Env) => env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';

/**
 * Stops a timed-out child. On Windows the tree is killed (`cmd.exe` → `gcloud.cmd` → `python.exe`):
 * killing `cmd.exe` alone would leave Python running. ⚠️ VERIFY on Windows (not testable here).
 */
function stop(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const taskkill = win32.join(systemRoot(process.env), 'System32', 'taskkill.exe');
    execFile(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

/** If a grandchild keeps the output pipes open after the kill, stop waiting after this long. */
const KILL_GRACE_MS = 2_000;

/**
 * The default runner: `execFile` (no shell), output capped at 64 KiB, hidden window on Windows, and its
 * own timeout so that the whole process tree can be stopped.
 */
export const runCommand: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      action();
    };
    const child = execFile(
      file,
      [...args],
      {
        maxBuffer: 64 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        shell: false,
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
      },
      (error, stdout, stderr) =>
        settle(() => {
          if (timedOut) return resolve({ exitCode: null, stdout, stderr, timedOut: true });
          if (!error) return resolve({ exitCode: 0, stdout, stderr, timedOut: false });
          const failure = error as NodeJS.ErrnoException & { code?: unknown; signal?: unknown };
          if (typeof failure.code === 'number') {
            return resolve({ exitCode: failure.code, stdout, stderr, timedOut: false });
          }
          if ((failure.code === null || failure.code === undefined) && typeof failure.signal === 'string') {
            // Ended by a signal from elsewhere.
            return resolve({ exitCode: null, stdout, stderr, timedOut: false });
          }
          // Spawn failures (ENOENT, EACCES) and output overflow: no stdout in the error.
          reject(
            Object.assign(new Error(`could not run ${file}: ${String(failure.code)}`), {
              code: failure.code,
            }),
          );
        }),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      stop(child);
      grace = setTimeout(
        () => settle(() => resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true })),
        KILL_GRACE_MS,
      );
    }, options.timeoutMs);
  });

/** A command line to give a {@link CommandRunner}: the program, its fixed arguments, and its environment. */
export interface GcloudCommand {
  readonly file: string;
  readonly args: readonly string[];
  /** The child's whole environment; absent: inherit this process's. */
  readonly env?: Env;
}

/**
 * `gcloud <args>` as DCAM starts it, for the token source and the doctor's `gcloud --version`. On
 * Windows: the system `cmd.exe` by full path (a bare name would also match one in the current
 * directory), and `NoDefaultCurrentDirectoryInExePath` so that `cmd.exe` looks up `gcloud.cmd` on PATH
 * only (https://learn.microsoft.com/windows/win32/api/processenv/nf-processenv-needcurrentdirectoryforexepathw).
 * `args` must be fixed strings: nothing user-supplied may reach the command line.
 */
export function gcloudCommand(
  args: readonly string[],
  /** `process.platform`; only `win32` changes the command line. */
  platform: string,
  env: Env,
): GcloudCommand {
  if (platform !== 'win32') return { file: 'gcloud', args: [...args] };
  return {
    file: env['ComSpec'] ?? env['COMSPEC'] ?? win32.join(systemRoot(env), 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/c', 'gcloud.cmd', ...args],
    env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' },
  };
}

/** Removes anything that looks like a token from CLI diagnostics, and keeps them short. */
function sanitize(text: string): string {
  return text
    .replace(/ya29\.[\w.-]+/g, '[token]')
    .replace(/[A-Za-z0-9._~+/=-]{40,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** An access token is one printable word (RFC 6750 b64token characters). */
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

export function createGcloudTokenSource(options: GcloudTokenSourceOptions = {}): AccessTokenSource {
  const run = options.run ?? runCommand;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? GCLOUD_TOKEN_TTL_MS;
  const timeoutMs = options.timeoutMs ?? GCLOUD_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const command = gcloudCommand(ARGS, platform, env);

  let cached: { token: string; until: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const missing = () =>
    new SourceError('unauthenticated', 'The Google Cloud CLI (gcloud) was not found on PATH.', {
      fixHint: `Install the Google Cloud CLI (${INSTALL_URL}), then run: ${LOGIN}`,
    });

  async function refresh(): Promise<string> {
    let result: CommandResult;
    try {
      result = await run(
        command.file,
        command.args,
        command.env === undefined ? { timeoutMs } : { timeoutMs, env: command.env },
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT') throw missing();
      throw new SourceError('unauthenticated', `Could not run the Google Cloud CLI (${String(code)}).`, {
        fixHint: `Check the Google Cloud CLI installation (${INSTALL_URL}), then run: ${LOGIN}`,
      });
    }
    if (result.timedOut) {
      throw new SourceError('timeout', `gcloud did not print an access token within ${timeoutMs} ms.`, {
        fixHint: `Run "gcloud auth application-default print-access-token" in a terminal to see what it waits for; if it needs a proxy, set HTTPS_PROXY (https://docs.cloud.google.com/sdk/docs/proxy-settings).`,
      });
    }
    // cmd.exe exits with 9009 when a command is not found.
    if (result.exitCode === 9009 || (platform === 'win32' && /is not recognized/i.test(result.stderr))) {
      throw missing();
    }
    if (result.exitCode !== 0) {
      const detail = sanitize(result.stderr);
      throw new SourceError(
        'unauthenticated',
        `gcloud could not print an Application Default Credentials access token (exit code ${String(result.exitCode)})${detail ? `: ${detail}` : '.'}`,
        { fixHint: `Sign in for Application Default Credentials: ${LOGIN}` },
      );
    }
    const token = result.stdout.trim();
    if (!TOKEN.test(token)) {
      throw new SourceError('unauthenticated', 'gcloud printed no usable access token.', {
        fixHint: `Sign in again: ${LOGIN}`,
      });
    }
    cached = { token, until: now() + ttlMs };
    return token;
  }

  return {
    accessToken() {
      if (cached && now() < cached.until) return Promise.resolve(cached.token);
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    invalidate(token?: string) {
      // A late 401 for an older token must not discard a fresh one.
      if (token === undefined || cached?.token === token) cached = undefined;
    },
  };
}
