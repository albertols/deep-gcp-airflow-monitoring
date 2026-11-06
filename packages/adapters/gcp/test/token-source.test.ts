import { describe, expect, it, vi } from 'vitest';
import { SourceError } from '@dcam/ports';
import { createGcloudTokenSource, gcloudCommand, type CommandResult, type CommandRunner } from '../src/index';

// A fictitious token shape; real tokens never appear in this repository.
const TOKEN = 'acme-test-access-token-0001';
const ok = (stdout = `${TOKEN}\n`): CommandResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

function runner(...results: Array<CommandResult | Error>) {
  const queue = [...results];
  return vi.fn<CommandRunner>(async () => {
    const next = queue.shift();
    if (!next) throw new Error('no more results');
    if (next instanceof Error) throw next;
    return next;
  });
}

const enoent = () => Object.assign(new Error('spawn gcloud ENOENT'), { code: 'ENOENT' });

async function failure(promise: Promise<unknown>): Promise<SourceError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SourceError);
  return error as SourceError;
}

describe('FR-AUTH-01 ADC access tokens from the Google Cloud CLI', () => {
  it('FR-AUTH-01: runs gcloud with fixed arguments and no shell on POSIX, and trims the token', async () => {
    const run = runner(ok());
    const tokens = createGcloudTokenSource({ run, platform: 'darwin' });
    expect(await tokens.accessToken()).toBe(TOKEN);
    expect(run).toHaveBeenCalledWith(
      'gcloud',
      ['auth', 'application-default', 'print-access-token'],
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
  });

  it('FR-AUTH-01: on Windows runs gcloud.cmd through the system cmd.exe, never one from the current directory', async () => {
    const run = runner(ok('acme-test-access-token-0001\r\n'), ok(), ok());
    const env = { ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATH: 'C:\\acme\\bin' };
    const tokens = createGcloudTokenSource({ run, platform: 'win32', env });
    expect(await tokens.accessToken()).toBe(TOKEN);
    expect(run).toHaveBeenCalledWith(
      'C:\\Windows\\system32\\cmd.exe',
      ['/d', '/s', '/c', 'gcloud.cmd', 'auth', 'application-default', 'print-access-token'],
      {
        timeoutMs: 20_000,
        // cmd.exe then looks up gcloud.cmd on PATH only, not in the current directory.
        env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' },
      },
    );
    const withoutComSpec = createGcloudTokenSource({
      run,
      platform: 'win32',
      env: { SystemRoot: 'D:\\Win' },
    });
    await withoutComSpec.accessToken();
    expect(run.mock.calls[1]?.[0]).toBe('D:\\Win\\System32\\cmd.exe');
    await createGcloudTokenSource({ run, platform: 'win32', env: {} }).accessToken();
    expect(run.mock.calls[2]?.[0]).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('FR-AUTH-01: invalidate(token) only drops that token, so late 401s keep a fresh one', async () => {
    const run = runner(ok(), ok('acme-test-access-token-0002\n'), ok('acme-test-access-token-0003\n'));
    const tokens = createGcloudTokenSource({ run });
    expect(await tokens.accessToken()).toBe(TOKEN);
    tokens.invalidate(TOKEN);
    expect(await tokens.accessToken()).toBe('acme-test-access-token-0002');
    tokens.invalidate(TOKEN); // a late 401 for the old token
    expect(await tokens.accessToken()).toBe('acme-test-access-token-0002');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('FR-AUTH-01: caches the token for 30 minutes, then refreshes it', async () => {
    let now = 1_700_000_000_000;
    const run = runner(ok(), ok('acme-test-access-token-0002\n'));
    const tokens = createGcloudTokenSource({ run, now: () => now });
    expect(await tokens.accessToken()).toBe(TOKEN);
    now += 30 * 60_000 - 1;
    expect(await tokens.accessToken()).toBe(TOKEN);
    expect(run).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await tokens.accessToken()).toBe('acme-test-access-token-0002');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('FR-AUTH-01: concurrent callers share one refresh', async () => {
    let release: (r: CommandResult) => void = () => undefined;
    const run = vi.fn<CommandRunner>(() => new Promise((resolve) => (release = resolve)));
    const tokens = createGcloudTokenSource({ run });
    const all = Promise.all([tokens.accessToken(), tokens.accessToken(), tokens.accessToken()]);
    release(ok());
    expect(await all).toEqual([TOKEN, TOKEN, TOKEN]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('FR-AUTH-01: invalidate() forces the next call to ask gcloud again', async () => {
    const run = runner(ok(), ok('acme-test-access-token-0002\n'));
    const tokens = createGcloudTokenSource({ run });
    await tokens.accessToken();
    tokens.invalidate();
    expect(await tokens.accessToken()).toBe('acme-test-access-token-0002');
  });

  it('FR-AUTH-01: a failed refresh is not cached; the next call tries again', async () => {
    const run = runner({ exitCode: 1, stdout: '', stderr: 'ERROR: boom', timedOut: false }, ok());
    const tokens = createGcloudTokenSource({ run });
    await failure(tokens.accessToken());
    expect(await tokens.accessToken()).toBe(TOKEN);
  });

  it('FR-AUTH-01: a missing gcloud is unauthenticated with the install link', async () => {
    const error = await failure(createGcloudTokenSource({ run: runner(enoent()) }).accessToken());
    expect(error.kind).toBe('unauthenticated');
    expect(error.message).toMatch(/Google Cloud CLI/);
    expect(error.details.fixHint).toContain('https://cloud.google.com/sdk/docs/install');
  });

  it('FR-AUTH-01: on Windows, "not recognized" from cmd.exe (exit 9009) also means gcloud is missing', async () => {
    const run = runner({
      exitCode: 9009,
      stdout: '',
      stderr: "'gcloud.cmd' is not recognized as an internal or external command,",
      timedOut: false,
    });
    const error = await failure(createGcloudTokenSource({ run, platform: 'win32' }).accessToken());
    expect(error.details.fixHint).toContain('https://cloud.google.com/sdk/docs/install');
  });

  it('FR-AUTH-01: no ADC or a needed re-authentication is unauthenticated with the login command', async () => {
    const run = runner({
      exitCode: 1,
      stdout: '',
      stderr:
        'ERROR: (gcloud.auth.application-default.print-access-token) Your default credentials were not found.',
      timedOut: false,
    });
    const error = await failure(createGcloudTokenSource({ run }).accessToken());
    expect(error.kind).toBe('unauthenticated');
    expect(error.message).toMatch(/exit code 1/);
    expect(error.message).toMatch(/default credentials were not found/);
    expect(error.details.fixHint).toContain('gcloud auth application-default login');
  });

  it('FR-AUTH-01: a gcloud that hangs times out (transient) after the child timeout', async () => {
    const run = runner({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    const error = await failure(createGcloudTokenSource({ run }).accessToken());
    expect(error.kind).toBe('timeout');
    expect(error.transient).toBe(true);
  });

  it('FR-AUTH-01: the token and stdout never appear in errors', async () => {
    // Fictitious value in the shape of a Google access token, to prove it is redacted.
    const secret = 'ya29.acme-secret-token-value-that-must-not-leak'; // hygiene-scan: allow
    for (const result of [
      { exitCode: 1, stdout: secret, stderr: `ERROR: refresh failed for ${secret}`, timedOut: false },
      { exitCode: 0, stdout: `${secret} trailing words\n`, stderr: '', timedOut: false },
      { exitCode: 0, stdout: '   \n', stderr: '', timedOut: false },
    ]) {
      const error = await failure(createGcloudTokenSource({ run: runner(result) }).accessToken());
      expect(error.kind).toBe('unauthenticated');
      const text = [error.message, error.stack, JSON.stringify(error), error.details.fixHint].join('\n');
      expect(text).not.toContain('acme-secret-token');
    }
  });

  it('FR-AUTH-01: the default runner reports a missing executable as ENOENT', async () => {
    const { runCommand } = await import('../src/gcloud-token-source');
    await expect(
      runCommand('dcam-no-such-command-acme', ['--version'], { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('FR-AUTH-01: the default runner returns exit code and output without a shell', async () => {
    const { runCommand } = await import('../src/gcloud-token-source');
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("a b");process.exit(3)'], {
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ exitCode: 3, stdout: 'a b', stderr: '', timedOut: false });
  });

  it('FR-AUTH-01: the default runner kills a child that hangs and reports a timeout', async () => {
    const { runCommand } = await import('../src/gcloud-token-source');
    const started = Date.now();
    const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 300,
    });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('FR-AUTH-01: the default runner refuses oversized output without echoing it', async () => {
    const { runCommand } = await import('../src/gcloud-token-source');
    const error: unknown = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("acmeleak".repeat(10000))'],
      { timeoutMs: 10_000 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    expect((error as Error).message).not.toContain('acmeleak');
  });
});

describe('FR-AUTH-02 the gcloud command line, shared with the doctor', () => {
  it('FR-AUTH-02: POSIX runs gcloud itself with the fixed arguments and inherits the environment', () => {
    expect(gcloudCommand(['--version'], 'darwin', { PATH: '/usr/bin' })).toEqual({
      file: 'gcloud',
      args: ['--version'],
    });
  });

  it('FR-AUTH-02: Windows runs gcloud.cmd through the system cmd.exe, looked up on PATH only', () => {
    const env = { ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATH: 'C:\\acme\\bin' };
    expect(gcloudCommand(['--version'], 'win32', env)).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', 'gcloud.cmd', '--version'],
      env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' },
    });
    // Never a bare cmd.exe, which Windows would also look for in the current directory.
    expect(gcloudCommand(['--version'], 'win32', { SystemRoot: 'D:\\Win' }).file).toBe(
      'D:\\Win\\System32\\cmd.exe',
    );
    expect(gcloudCommand(['--version'], 'win32', {}).file).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});
