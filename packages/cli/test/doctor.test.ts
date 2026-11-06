import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DoctorCheck, DoctorProbes, DoctorReport } from '@dcam/application';
import {
  DOCTOR_ENV_KEYS,
  createDoctorProbes,
  doctorJson,
  gcloudVersion,
  inspectDataDir,
  parseCli,
  renderDoctorText,
  runDoctorCommand,
  unwiredDoctorAdapters,
  type DoctorAdapters,
  type ExecFileFn,
} from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
/** Start of an ANSI escape sequence. */
const ANSI = '\u001b[';

const c = (over: Partial<DoctorCheck>): DoctorCheck => ({
  id: 'node.version',
  title: 'Node.js 22.12 or later',
  scope: 'local',
  status: 'pass',
  evidence: 'Node.js 22.20.0',
  details: [],
  fixHint: null,
  docsUrl: null,
  durationMs: 1,
  ...over,
});

const report = (checks: DoctorCheck[]): DoctorReport => {
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const x of checks) summary[x.status]++;
  return { startedAt: NOW, durationMs: 1234, checks, summary, ok: summary.fail === 0 };
};

const sample = report([
  c({}),
  c({
    id: 'data-dir.permissions',
    title: 'Data directory is owner-only',
    status: 'warn',
    evidence: 'Mode 0755: other users on this machine can read DCAM data.',
    fixHint: "chmod 700 '/home/acme/.dcam/data'",
  }),
  c({
    id: 'config.valid',
    title: 'Configuration is valid',
    status: 'fail',
    evidence: '1 problem in /home/acme/dcam.config.yaml.',
    details: ['environments.0.projectId: Required. Fix: Set projectId.'],
    fixHint: 'Correct the listed fields.',
    docsUrl: 'https://docs.cloud.google.com/sdk/docs/install',
  }),
  c({
    id: 'composer.environment',
    title: 'Composer API: environment readable',
    scope: 'acme-composer-prod',
    status: 'skip',
    evidence: 'Skipped because "Application Default Credentials" did not pass.',
  }),
]);

describe('FR-AUTH-05 dcam doctor arguments', () => {
  it('FR-AUTH-05: parses --config, repeated --env and --json', () => {
    expect(parseCli(['doctor'])).toEqual({ command: 'doctor', config: null, envIds: [], json: false });
    expect(
      parseCli(['doctor', '--config', 'acme.yaml', '--env', 'acme-a', '--env', 'acme-b', '--json']),
    ).toEqual({ command: 'doctor', config: 'acme.yaml', envIds: ['acme-a', 'acme-b'], json: true });
  });

  it('FR-AUTH-05: rejects unknown options and missing values', () => {
    expect(() => parseCli(['doctor', '--env'])).toThrow(/--env needs/);
    expect(() => parseCli(['doctor', '--config', '--json'])).toThrow(/--config needs/);
    expect(() => parseCli(['doctor', '--fix'])).toThrow(/Unknown option "--fix"/);
    expect(parseCli(['doctor', '--help'])).toEqual({ command: 'help' });
  });
});

describe('FR-AUTH-05 doctor output', () => {
  it('FR-AUTH-05: plain text groups checks by scope, aligns the columns and shows fixes for warnings and failures', () => {
    const text = renderDoctorText(sample, { color: false, version: '0.0.0' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('DCAM doctor 0.0.0 · 2026-11-05 12:00 UTC');
    expect(text).toContain('\nThis machine\n');
    expect(text).toContain('\nEnvironment acme-composer-prod\n');
    const rows = lines.filter((l) => /^ {2}(PASS|WARN|FAIL|SKIP) /.test(l));
    expect(rows).toHaveLength(4);
    // The evidence column starts at the same offset on every row.
    const offsets = new Set(rows.map((r, i) => r.indexOf(sample.checks[i]!.evidence)));
    expect(offsets.size).toBe(1);
    expect(text).toContain("        Fix:  chmod 700 '/home/acme/.dcam/data'");
    expect(text).toContain('        - environments.0.projectId: Required. Fix: Set projectId.');
    expect(text).toContain('        Docs: https://docs.cloud.google.com/sdk/docs/install');
    // A passing or skipped check shows no fix line.
    expect(text.match(/Fix: {2}/g)).toHaveLength(2);
    expect(text).toContain('1 passed, 1 warning, 1 failed, 1 skipped.');
    expect(text).toMatch(/Fix the failed checks, then run the doctor again\.\n$/);
    expect(text).not.toContain(ANSI);
  });

  it('FR-AUTH-05: colour is added only when asked for', () => {
    const text = renderDoctorText(sample, { color: true, version: '0.0.0' });
    expect(text).toContain('\u001b[32mPASS\u001b[0m');
    expect(text).toContain('\u001b[31mFAIL\u001b[0m');
  });

  it('FR-AUTH-05: the closing line says what to do next', () => {
    const allPass = renderDoctorText(report([c({})]), { color: false, version: '0.0.0' });
    expect(allPass).toMatch(/Start it with pnpm dcam\.\n$/);
    const warned = renderDoctorText(report([c({ status: 'warn', fixHint: 'x' })]), {
      color: false,
      version: '0.0.0',
    });
    expect(warned).toMatch(/No check failed\. Review the warnings above\.\n$/);
  });

  it('FR-AUTH-05: --json has a stable, documented shape', () => {
    const json = doctorJson(sample, '0.0.0');
    expect(Object.keys(json)).toEqual([
      'schemaVersion',
      'dcamVersion',
      'startedAt',
      'durationMs',
      'ok',
      'summary',
      'checks',
    ]);
    expect(json).toMatchObject({
      schemaVersion: 1,
      dcamVersion: '0.0.0',
      startedAt: '2026-11-05T12:00:00.000Z',
      durationMs: 1234,
      ok: false,
      summary: { pass: 1, warn: 1, fail: 1, skip: 1 },
    });
    expect(Object.keys(json.checks[0]!)).toEqual([
      'id',
      'title',
      'scope',
      'status',
      'evidence',
      'details',
      'fixHint',
      'docsUrl',
      'durationMs',
    ]);
  });
});

describe('FR-AUTH-05 dcam doctor command', () => {
  const probesWith = (status: 'pass' | 'fail'): DoctorProbes => ({
    platform: 'linux',
    nodeVersion: status === 'pass' ? '22.20.0' : '20.0.0',
    env: {},
    defaultDataDir: '/home/acme/.dcam/data',
    loadDuckDb: async () => undefined,
    loadConfig: async () => ({
      kind: 'valid',
      config: {
        path: '/home/acme/dcam.config.yaml',
        dataDir: '/home/acme/.dcam/data',
        quotaProjectId: null,
        caBundlePath: null,
        profiles: {} as never,
        budgets: {} as never,
        environments: [],
      },
    }),
    dataDir: async (path) => ({ path, state: 'directory', writable: true, mode: 0o700, freeBytes: 2 ** 40 }),
    gcloudVersion: async () => 'Google Cloud SDK 540.0.0',
    proxySettings: () => ({ http: null, https: null, noProxy: null, dropped: [], shadowed: [] }),
    proxyRoute: () => ({ via: 'direct' }),
    tokens: { accessToken: async () => 'unused', invalidate: () => undefined },
    readTextFile: async () => '',
    environment: () => {
      throw new Error('no environments');
    },
  });

  const capture = (isTTY: boolean) => {
    const out = { text: '', isTTY, write: (s: string) => ((out.text += s), true) };
    return out;
  };

  it.each<['pass' | 'fail', number]>([
    ['pass', 0],
    ['fail', 1],
  ])('FR-AUTH-05: exit code when the checks %s is %d', async (status, code) => {
    const stdout = capture(false);
    const exit = await runDoctorCommand(
      { command: 'doctor', config: null, envIds: [], json: false },
      { probes: () => probesWith(status), stdout, env: {}, version: '0.0.0', now: () => NOW },
    );
    expect(exit).toBe(code);
    expect(stdout.text).toContain('This machine');
  });

  it('FR-AUTH-05: --json prints one JSON document and passes --config to the probes', async () => {
    const stdout = capture(true);
    let configPath: string | null = null;
    const exit = await runDoctorCommand(
      { command: 'doctor', config: 'acme.yaml', envIds: [], json: true },
      {
        probes: (path) => ((configPath = path), probesWith('fail')),
        stdout,
        env: {},
        version: '0.0.0',
        now: () => NOW,
      },
    );
    expect(exit).toBe(1);
    expect(configPath).toBe('acme.yaml');
    const parsed = JSON.parse(stdout.text);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(stdout.text).not.toContain(ANSI);
  });

  it.each<[boolean, Record<string, string>, boolean]>([
    [true, {}, true],
    [true, { NO_COLOR: '1' }, false],
    [true, { NO_COLOR: '' }, true],
    [false, {}, false],
  ])('FR-AUTH-05: TTY %s with %j → colour %s', async (isTTY, env, colour) => {
    const stdout = capture(isTTY);
    await runDoctorCommand(
      { command: 'doctor', config: null, envIds: [], json: false },
      { probes: () => probesWith('pass'), stdout, env, version: '0.0.0', now: () => NOW },
    );
    expect(stdout.text.includes(ANSI)).toBe(colour);
  });
});

describe('FR-AUTH-05 local probes', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dcam-doctor-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('FR-AUTH-05: reads an existing data directory without changing it', async () => {
    await chmod(dir, 0o700);
    const facts = await inspectDataDir(dir, process.platform);
    expect(facts).toMatchObject({ path: dir, state: 'directory', writable: true });
    if (process.platform !== 'win32') expect(facts.mode).toBe(0o700);
    expect(facts.freeBytes).toBeGreaterThan(0);
  });

  it('FR-AUTH-05: a missing data directory is judged by its nearest existing parent', async () => {
    const facts = await inspectDataDir(join(dir, 'a', 'b'), process.platform);
    expect(facts).toMatchObject({ state: 'missing', writable: true, mode: null });
    expect(facts.freeBytes).toBeGreaterThan(0);
  });

  it('FR-AUTH-05: a file in place of the data directory is reported', async () => {
    const file = join(dir, 'data');
    await writeFile(file, '');
    expect((await inspectDataDir(file, process.platform)).state).toBe('not-a-directory');
  });

  it('FR-AUTH-05: Windows reports no POSIX mode', async () => {
    expect((await inspectDataDir(dir, 'win32')).mode).toBeNull();
  });

  const execRecorder = (result: { stdout: string } | Error) => {
    const calls: Array<[string, readonly string[]]> = [];
    const exec: ExecFileFn = async (file, args) => {
      calls.push([file, args]);
      if (result instanceof Error) throw result;
      return result;
    };
    return { exec, calls };
  };

  it('FR-AUTH-02: runs gcloud --version with fixed arguments and no shell, and keeps the first line', async () => {
    const { exec, calls } = execRecorder({
      stdout: 'Google Cloud SDK 540.0.0\nbq 2.1.25\ncore 2026.10.31\n',
    });
    expect(await gcloudVersion('darwin', {}, exec)).toBe('Google Cloud SDK 540.0.0');
    expect(calls).toEqual([['gcloud', ['--version']]]);
  });

  it('FR-AUTH-02: on Windows runs gcloud.cmd through cmd.exe with fixed arguments', async () => {
    const { exec, calls } = execRecorder({ stdout: 'Google Cloud SDK 540.0.0\r\n' });
    expect(await gcloudVersion('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, exec)).toBe(
      'Google Cloud SDK 540.0.0',
    );
    expect(calls).toEqual([
      ['C:\\Windows\\system32\\cmd.exe', ['/d', '/s', '/c', 'gcloud.cmd', '--version']],
    ]);
  });

  it.each<[string, string, Error & { code?: unknown; stderr?: string }]>([
    ['darwin', 'ENOENT', Object.assign(new Error('spawn gcloud ENOENT'), { code: 'ENOENT' })],
    [
      'win32',
      'exit 9009',
      Object.assign(new Error('Command failed'), {
        code: 9009,
        stderr: "'gcloud.cmd' is not recognized as an internal or external command",
      }),
    ],
  ])('FR-AUTH-02: gcloud missing on %s (%s) → null', async (platform, _why, error) => {
    const { exec } = execRecorder(error);
    expect(await gcloudVersion(platform, {}, exec)).toBeNull();
  });

  it('FR-AUTH-02: other gcloud failures are reported, not hidden', async () => {
    const { exec } = execRecorder(Object.assign(new Error('gcloud crashed'), { code: 1 }));
    await expect(gcloudVersion('linux', {}, exec)).rejects.toThrow(/gcloud crashed/);
  });

  it('FR-AUTH-07: the probes see only the CA and credential variables', () => {
    const probes = createDoctorProbes({
      adapters: unwiredDoctorAdapters({ configPath: null }),
      env: {
        HTTPS_PROXY: 'http://proxy.acme.example:3128',
        NODE_EXTRA_CA_CERTS: '/home/acme/acme-root.pem',
        ACME_SECRET: 'x',
        DCAM_DATA_DIR: '~/acme-data',
      },
      homeDir: '/home/acme',
      platform: 'linux',
    });
    expect(Object.keys(probes.env)).toEqual(['NODE_EXTRA_CA_CERTS']);
    expect(DOCTOR_ENV_KEYS).toEqual(['NODE_EXTRA_CA_CERTS', 'GOOGLE_APPLICATION_CREDENTIALS']);
    expect(probes.defaultDataDir).toBe(join('/home/acme', 'acme-data'));
  });

  it('FR-AUTH-05: without DCAM_DATA_DIR the data directory is ~/.dcam/data', () => {
    const probes = createDoctorProbes({
      adapters: unwiredDoctorAdapters({ configPath: null }),
      env: {},
      homeDir: '/home/acme',
    });
    expect(probes.defaultDataDir).toBe(join('/home/acme', '.dcam', 'data'));
  });

  it('FR-AUTH-05: adapters that are not wired yet fail honestly instead of passing', async () => {
    const adapters: DoctorAdapters = unwiredDoctorAdapters({ configPath: null });
    await expect(adapters.loadConfig()).rejects.toThrow(/not wired/);
    await expect(adapters.tokens.accessToken()).rejects.toThrow(/not wired/);
  });
});

describe('FR-AUTH-07 proxy probes read the variables as the transport does (http-guard)', () => {
  const PROXY = 'proxy.acme.example:3128';
  const EMULATOR = 'http://127.0.0.1:8080/api/v1/health';
  const COMPOSER = 'https://composer.googleapis.com/v1/projects/acme-prod-123';
  const probesFor = (env: Record<string, string>) =>
    createDoctorProbes({ adapters: unwiredDoctorAdapters({ configPath: null }), env, homeDir: '/home/acme' });

  it('FR-AUTH-07: a proxy without a scheme is used as http://, as the transport does', () => {
    const probes = probesFor({ HTTPS_PROXY: PROXY });
    expect(probes.proxySettings().https).toMatchObject({
      variable: 'HTTPS_PROXY',
      url: `http://${PROXY}`,
      schemeAdded: true,
    });
    expect(probes.proxyRoute(COMPOSER)).toEqual({ via: 'proxy', proxy: PROXY });
  });

  it('FR-AUTH-07: a remote proxy never carries loopback requests, so the emulator needs no NO_PROXY', () => {
    const probes = probesFor({ https_proxy: `http://${PROXY}`, http_proxy: `http://${PROXY}` });
    expect(probes.proxyRoute(EMULATOR)).toEqual({ via: 'direct' });
    expect(probes.proxyRoute('http://localhost:8080/')).toEqual({ via: 'direct' });
    expect(probes.proxyRoute(COMPOSER)).toEqual({ via: 'proxy', proxy: PROXY });
  });

  it('FR-AUTH-07: an empty lower-case variable does not hide the upper-case one', () => {
    const probes = probesFor({ https_proxy: '', HTTPS_PROXY: `http://${PROXY}` });
    expect(probes.proxySettings().https?.variable).toBe('HTTPS_PROXY');
    expect(probes.proxySettings().shadowed).toEqual([]);
    expect(probes.proxyRoute(COMPOSER)).toEqual({ via: 'proxy', proxy: PROXY });
  });

  it('FR-AUTH-07: DCAM_NETWORK=loopback-only drops a remote proxy', () => {
    const probes = probesFor({ DCAM_NETWORK: 'loopback-only', HTTPS_PROXY: `http://${PROXY}` });
    const settings = probes.proxySettings();
    expect(settings.https).toBeNull();
    expect(settings.dropped.map((v) => v.variable)).toEqual(['HTTPS_PROXY']);
    expect(probes.proxyRoute(COMPOSER)).toEqual({ via: 'direct' });
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ['a socks5 proxy', { HTTPS_PROXY: 'socks5://proxy.acme.example:1080' }, /HTTPS_PROXY must be an http/],
    ['a mistyped DCAM_NETWORK', { DCAM_NETWORK: 'loopback' }, /DCAM_NETWORK must be/],
  ])("FR-AUTH-07: %s throws the transport's own error", (_name, env, message) => {
    const probes = probesFor(env);
    expect(() => probes.proxySettings()).toThrow(message);
    expect(() => probes.proxyRoute(COMPOSER)).toThrow(message);
  });

  it('FR-AUTH-07: proxy credentials never reach the probes', () => {
    const probes = probesFor({ HTTPS_PROXY: 'http://alice:s3cret@proxy.acme.example:3128' });
    expect(JSON.stringify(probes.proxySettings())).not.toContain('s3cret');
    expect(JSON.stringify(probes.proxyRoute(COMPOSER))).not.toContain('s3cret');
  });
});
