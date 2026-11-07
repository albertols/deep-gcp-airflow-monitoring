import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '@dcam/gcp';
import { SourceError } from '@dcam/ports';
import { LOOPBACK_ONLY_NO_TOKEN, createAdcTokenSource } from '../src/live/tokens';

/** A gcloud stand-in: records each call and prints a fake token. Nothing is started. */
const fakeRunner = () =>
  vi.fn<CommandRunner>(async () => ({
    exitCode: 0,
    stdout: 'ya29.fake-token\n',
    stderr: '',
    timedOut: false,
  }));

describe('the ADC token source of the composition roots (FR-AUTH-01, NFR-SEC-04)', () => {
  it('NFR-SEC-04: DCAM_NETWORK=loopback-only requests no Google token and starts no process', async () => {
    const run = fakeRunner();
    const tokens = createAdcTokenSource({ env: { DCAM_NETWORK: 'loopback-only' }, run });
    const error = await tokens.accessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ kind: 'guard', message: LOOPBACK_ONLY_NO_TOKEN });
    expect(LOOPBACK_ONLY_NO_TOKEN).toBe('DCAM_NETWORK=loopback-only: no Google token is requested');
    expect(run).not.toHaveBeenCalled();
  });

  it('NFR-SEC-04: a mistyped DCAM_NETWORK requests no token either', async () => {
    const run = fakeRunner();
    const tokens = createAdcTokenSource({ env: { DCAM_NETWORK: 'loopback' }, run });
    await expect(tokens.accessToken()).rejects.toMatchObject({
      kind: 'guard',
      message: expect.stringMatching(/DCAM_NETWORK must be/),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('FR-AUTH-01: otherwise gcloud prints the token, located through the given environment', async () => {
    const run = fakeRunner();
    const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe', Path: 'C:\\acme\\google-cloud-sdk\\bin' };
    const tokens = createAdcTokenSource({ env, run, platform: 'win32' });
    await expect(tokens.accessToken()).resolves.toBe('ya29.fake-token');
    expect(run).toHaveBeenCalledTimes(1);
    const [file, , options] = run.mock.calls[0] ?? [];
    expect(file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(options?.env).toMatchObject({ Path: 'C:\\acme\\google-cloud-sdk\\bin' });
  });
});
