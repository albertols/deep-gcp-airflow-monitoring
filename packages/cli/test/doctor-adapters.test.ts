import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor, type DoctorCheck, type DoctorCheckId, type DoctorReport } from '@dcam/application';
import type { Transport } from '@dcam/http-guard';
import type { AccessTokenSource } from '@dcam/ports';
import { liveDoctorAdapters } from '../src/doctor/adapters';
import { createDoctorProbes, type ExecFileFn } from '../src/doctor/probes';

/**
 * Every program the code under test starts goes through this stand-in: nothing real is started. A
 * gcloud ADC token request prints a fake token; anything else is "not installed".
 */
const started = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    execFile: (file: string, args: readonly string[], ...rest: unknown[]) => {
      started.push([file, ...args]);
      const callback = rest.find((r) => typeof r === 'function') as
        ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
      const token = args.includes('application-default');
      queueMicrotask(() =>
        token
          ? callback?.(null, 'ya29.fake-doctor-token\n', '')
          : callback?.(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', ''),
      );
      return { pid: undefined, kill: () => true };
    },
  };
});
const tokenRequests = () => started.filter((argv) => argv.includes('application-default'));

const COMPOSER_CONFIG = `version: 1
environments:
  - id: acme-composer-prod
    tier: prod
    projectId: acme-prod-123
    location: europe-west1
    environment: acme-composer-prod
`;
const EMULATOR_CONFIG = `version: 1
environments:
  - id: acme-emulator
    tier: dev
    airflow:
      baseUrl: http://127.0.0.1:8080
      usernameEnv: DCAM_EMULATOR_USER
      passwordEnv: DCAM_EMULATOR_PASSWORD
      limits:
        parallelism: 32
        schedulers: 1
        maxActiveTasksPerDag: 16
        maxActiveRunsPerDag: 16
        workerConcurrency: 16
        workers: 2
`;
const AIRFLOW_URI = 'https://acme-dot-europe-west1.composer.googleusercontent.com';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dcam-doctor-'));
});
afterEach(async () => {
  started.length = 0;
  await rm(cwd, { recursive: true, force: true });
});

const adapters = (
  overrides: { tokens?: AccessTokenSource; transport?: Transport } = {},
  configPath?: string,
) => liveDoctorAdapters({ configPath: configPath ?? null, env: {}, cwd, homeDir: cwd, ...overrides });

/** Answers Composer with a running environment and records the Authorization header of every request. */
function fakeGoogle() {
  const sent: Array<{ url: string; authorization: string | undefined }> = [];
  const transport: Transport = async (url, init) => {
    sent.push({ url, authorization: init.headers['authorization'] });
    const body = url.startsWith('https://composer.googleapis.com/')
      ? {
          state: 'RUNNING',
          config: {
            airflowUri: AIRFLOW_URI,
            softwareConfig: { imageVersion: 'composer-3-airflow-2.11.1-build.22' },
          },
        }
      : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', date: new Date(NOW).toUTCString() },
    });
  };
  return { sent, transport };
}

/** `gcloud --version` as the doctor's machine check sees it. */
const gcloudInstalled: ExecFileFn = async () => ({ stdout: 'Google Cloud SDK 540.0.0\n' });

async function doctor(env: Record<string, string>, transport: Transport): Promise<DoctorReport> {
  const wired = liveDoctorAdapters({ configPath: null, env, cwd, homeDir: cwd, transport });
  try {
    const probes = createDoctorProbes({ adapters: wired, env, homeDir: cwd, exec: gcloudInstalled });
    return await runDoctor(probes, { now: () => NOW });
  } finally {
    await wired.close();
  }
}

function check(report: DoctorReport, id: DoctorCheckId, scope = 'local'): DoctorCheck {
  const found = report.checks.find((c) => c.id === id && c.scope === scope);
  if (!found) throw new Error(`no check ${id} in scope ${scope}`);
  return found;
}

describe('FR-AUTH-05 doctor adapters wired to the configuration and the guarded client', () => {
  it('FR-AUTH-05: a missing configuration file is reported with the path DCAM looked at', async () => {
    await expect(adapters().loadConfig()).resolves.toEqual({
      kind: 'missing',
      path: join(cwd, 'dcam.config.yaml'),
    });
    await expect(adapters({}, 'other.yaml').loadConfig()).resolves.toEqual({
      kind: 'missing',
      path: join(cwd, 'other.yaml'),
    });
  });

  it('FR-AUTH-05: an invalid configuration is reported with its issues', async () => {
    await writeFile(join(cwd, 'dcam.config.yaml'), 'version: 1\nenvironments:\n  - id: Acme_Prod\n');
    const result = await adapters().loadConfig();
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.path).toBe(join(cwd, 'dcam.config.yaml'));
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('FR-AUTH-05: a valid configuration is returned for the environment checks', async () => {
    await writeFile(join(cwd, 'dcam.config.yaml'), COMPOSER_CONFIG);
    const result = await adapters().loadConfig();
    expect(result).toMatchObject({
      kind: 'valid',
      config: { environments: [{ id: 'acme-composer-prod' }] },
    });
  });

  it('FR-AUTH-01: the ADC check and every environment check share one gcloud token', async () => {
    await writeFile(join(cwd, 'dcam.config.yaml'), COMPOSER_CONFIG);
    const { sent, transport } = fakeGoogle();
    const report = await doctor({}, transport);
    expect(check(report, 'adc.token').status).toBe('pass');
    expect(check(report, 'composer.environment', 'acme-composer-prod').status).toBe('pass');
    expect(tokenRequests()).toHaveLength(1);
    const google = sent.filter((s) => s.url.startsWith('https://composer.googleapis.com/v1/projects/'));
    expect(google[0]?.authorization).toBe('Bearer ya29.fake-doctor-token');
    expect(sent.some((s) => s.url.startsWith(AIRFLOW_URI))).toBe(true);
    for (const s of sent.filter((x) => x.authorization !== undefined))
      expect(s.authorization).toBe('Bearer ya29.fake-doctor-token');
  });

  it('NFR-SEC-04: with DCAM_NETWORK=loopback-only the doctor starts no gcloud for a token and sends nothing', async () => {
    await writeFile(join(cwd, 'dcam.config.yaml'), COMPOSER_CONFIG);
    const { sent, transport } = fakeGoogle();
    const report = await doctor({ DCAM_NETWORK: 'loopback-only' }, transport);
    const reason = 'DCAM_NETWORK=loopback-only: no Google token is requested';
    expect(check(report, 'adc.token')).toMatchObject({ status: 'skip' });
    expect(check(report, 'adc.token').evidence).toContain(reason);
    for (const id of ['composer.environment', 'monitoring.read', 'clock.skew'] as const) {
      expect(check(report, id, 'acme-composer-prod').status, id).toBe('skip');
      expect(check(report, id, 'acme-composer-prod').evidence, id).toContain(reason);
    }
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(started).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('FR-AUTH-07: a proxy given without a scheme is shown and used as http://', async () => {
    await writeFile(join(cwd, 'dcam.config.yaml'), COMPOSER_CONFIG);
    const { transport } = fakeGoogle();
    const report = await doctor({ HTTPS_PROXY: 'proxy.acme.example:3128' }, transport);
    expect(check(report, 'network.proxy')).toMatchObject({ status: 'pass' });
    expect(check(report, 'network.proxy').evidence).toContain(
      'HTTPS_PROXY=http://proxy.acme.example:3128 (no scheme given, so http:// is used)',
    );
    expect(check(report, 'composer.environment', 'acme-composer-prod').evidence).toContain(
      'through proxy proxy.acme.example:3128',
    );
  });

  it('FR-AUTH-07: a remote proxy and the emulator on loopback need no NO_PROXY: no warning, no export', async () => {
    await writeFile(join(cwd, 'dcam.config.yaml'), EMULATOR_CONFIG);
    const transport: Transport = async () =>
      new Response(
        JSON.stringify({ metadatabase: { status: 'healthy' }, scheduler: { status: 'healthy' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', date: new Date(NOW).toUTCString() },
        },
      );
    const report = await doctor(
      {
        https_proxy: 'http://proxy.acme.example:3128',
        HTTP_PROXY: 'http://proxy.acme.example:3128',
        NO_PROXY: '10.0.0.0/8',
        DCAM_EMULATOR_USER: 'acme',
        DCAM_EMULATOR_PASSWORD: 'acme-password',
      },
      transport,
    );
    const proxy = check(report, 'network.proxy');
    expect(proxy.status).toBe('pass');
    expect(proxy.fixHint).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(/export NO_PROXY|\$env:NO_PROXY/);
    expect(check(report, 'airflow.health', 'acme-emulator').status).toBe('pass');
    expect(check(report, 'airflow.health', 'acme-emulator').evidence).not.toContain('through proxy');
  });
});
