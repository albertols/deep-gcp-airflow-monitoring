import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SourceError,
  type AirflowApi,
  type AirflowHealth,
  type ComposerApi,
  type ComposerEnvironment,
  type EnvironmentEntry,
  type MetricQuery,
  type MetricSeries,
  type MonitoringApi,
  type WorkspaceConfig,
} from '@dcam/ports';
import {
  DOCTOR_DOCS,
  runDoctor,
  type DataDirFacts,
  type DoctorCheck,
  type DoctorCheckId,
  type DoctorProbes,
  type DoctorProxyRoute,
  type DoctorProxySettings,
  type DoctorReport,
} from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

const composerEntry = (id = 'acme-composer-prod'): EnvironmentEntry => ({
  id,
  displayName: 'Acme prod',
  tier: 'prod',
  profile: 'standard',
  source: { kind: 'composer', projectId: 'acme-prod-123', location: 'europe-west1', environment: id },
});

const emulatorEntry: EnvironmentEntry = {
  id: 'acme-emulator',
  displayName: 'Acme emulator',
  tier: 'dev',
  profile: 'live',
  source: {
    kind: 'airflow',
    baseUrl: 'http://127.0.0.1:8080',
    usernameEnv: 'DCAM_EMULATOR_USER',
    passwordEnv: 'DCAM_EMULATOR_PASSWORD',
    limits: {
      parallelism: 32,
      schedulers: 1,
      maxActiveTasksPerDag: 16,
      maxActiveRunsPerDag: 16,
      workerConcurrency: 16,
      workers: 2,
    },
  },
};

const cadences = { airflowLive: 30, airflowFacts: 120, airflowInventory: 900, monitoring: 60, composer: 900 };
const workspace = (
  environments: readonly EnvironmentEntry[],
  over: Partial<WorkspaceConfig> = {},
): WorkspaceConfig => ({
  path: '/home/acme/dcam.config.yaml',
  dataDir: '/home/acme/.dcam/data',
  quotaProjectId: null,
  caBundlePath: null,
  profiles: { live: cadences, standard: cadences, eco: cadences },
  budgets: {
    airflowApi: { live: 60, standard: 30, eco: 10, background: 10, maxConcurrent: 2 },
    monitoringPerProjectPerMinute: 30,
    composerApiPerMinute: 6,
  },
  environments,
  ...over,
});

const runningEnv: ComposerEnvironment = {
  state: 'RUNNING',
  airflowUri: 'https://acme-prod-dot-europe-west1.composer.googleusercontent.com',
  imageVersion: 'composer-3-airflow-2.11.1-build.22',
  airflowConfigOverrides: {},
  worker: { minCount: 1, maxCount: 3, cpu: 2, memoryGb: 7.5 },
  schedulerCount: 2,
};

const healthy: AirflowHealth = {
  metadatabase: 'healthy',
  scheduler: { status: 'healthy', latestHeartbeat: NOW - 5_000 },
};

interface EnvFakes {
  composer?: () => Promise<ComposerEnvironment>;
  health?: () => Promise<AirflowHealth>;
  version?: () => Promise<{ version: string }>;
  dags?: () => Promise<{ items: []; total: number }>;
  providers?: () => Promise<boolean>;
  series?: (q: MetricQuery) => Promise<readonly MetricSeries[]>;
  serverDate?: (url: string) => Promise<number | null>;
}

interface Calls {
  airflowBaseUrls: string[];
  serverDateUrls: string[];
  metricQueries: MetricQuery[];
  routedUrls: string[];
}

const NO_PROXIES: DoctorProxySettings = { http: null, https: null, noProxy: null, dropped: [], shadowed: [] };
const PROXY_HOST = 'proxy.acme.example:3128';
const corpProxy = (variable: string, schemeAdded = false) => ({
  variable,
  url: `http://${PROXY_HOST}`,
  schemeAdded,
});
/** What http-guard's proxyRoute answers for a remote proxy: loopback targets always go direct. */
const remoteProxyRoute = (url: string): DoctorProxyRoute =>
  /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)
    ? { via: 'direct' }
    : { via: 'proxy', proxy: PROXY_HOST };

interface FakeOptions {
  platform?: string;
  nodeVersion?: string;
  env?: Record<string, string | undefined>;
  duckdb?: () => Promise<void>;
  config?: DoctorProbes['loadConfig'];
  dataDir?: Partial<DataDirFacts>;
  gcloud?: () => Promise<string | null>;
  token?: () => Promise<string>;
  files?: Record<string, string>;
  envs?: Record<string, EnvFakes>;
  proxySettings?: () => DoctorProxySettings;
  proxyRoute?: (url: string) => DoctorProxyRoute;
}

function fakeProbes(config: WorkspaceConfig, o: FakeOptions = {}): { probes: DoctorProbes; calls: Calls } {
  const calls: Calls = { airflowBaseUrls: [], serverDateUrls: [], metricQueries: [], routedUrls: [] };
  const probes: DoctorProbes = {
    platform: o.platform ?? 'darwin',
    nodeVersion: o.nodeVersion ?? '22.20.0',
    env: o.env ?? {},
    defaultDataDir: '/home/acme/.dcam/data',
    loadDuckDb: o.duckdb ?? (async () => undefined),
    loadConfig: o.config ?? (async () => ({ kind: 'valid', config })),
    dataDir: async (path) => ({
      path,
      state: 'directory',
      writable: true,
      mode: 0o700,
      freeBytes: 50 * 2 ** 30,
      ...o.dataDir,
    }),
    gcloudVersion: o.gcloud ?? (async () => 'Google Cloud SDK 540.0.0'),
    proxySettings: o.proxySettings ?? (() => NO_PROXIES),
    proxyRoute: (url) => {
      calls.routedUrls.push(url);
      return o.proxyRoute ? o.proxyRoute(url) : { via: 'direct' };
    },
    tokens: { accessToken: o.token ?? (async () => 'fake-token-value'), invalidate: () => undefined },
    readTextFile: async (path) => {
      const text = o.files?.[path];
      if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return text;
    },
    environment: (entry) => {
      const f = o.envs?.[entry.id] ?? {};
      const composer: ComposerApi = { environment: f.composer ?? (async () => runningEnv) };
      const monitoring: MonitoringApi = {
        series: async (q) => {
          calls.metricQueries.push(q);
          return f.series ? f.series(q) : [{ metricLabels: {}, resourceLabels: {}, points: [] }];
        },
      };
      const airflow = (baseUrl: string): AirflowApi => {
        calls.airflowBaseUrls.push(baseUrl);
        const unused = async (): Promise<never> => {
          throw new Error('not used by the doctor');
        };
        return {
          version: f.version ?? (async () => ({ version: '2.11.1' })),
          health: f.health ?? (async () => healthy),
          dags: f.dags ?? (async () => ({ items: [], total: 2000 })),
          pools: unused,
          importErrorCount: unused,
          taskInstances: unused,
          canReadProviders: f.providers ?? (async () => false),
        };
      };
      return {
        ...(entry.source.kind === 'composer' ? { composer, monitoring } : {}),
        airflow,
        serverDate: async (url) => {
          calls.serverDateUrls.push(url);
          return f.serverDate ? f.serverDate(url) : NOW;
        },
      };
    },
  };
  return { probes, calls };
}

const run = (probes: DoctorProbes, envIds?: readonly string[]): Promise<DoctorReport> =>
  runDoctor(probes, { now: () => NOW, envIds });

function check(report: DoctorReport, id: DoctorCheckId, scope = 'local'): DoctorCheck {
  const found = report.checks.find((c) => c.id === id && c.scope === scope);
  if (!found) throw new Error(`no check ${id} in scope ${scope}`);
  return found;
}

const statuses = (report: DoctorReport, scope: string): Array<[DoctorCheckId, string]> =>
  report.checks.filter((c) => c.scope === scope).map((c) => [c.id, c.status]);

afterEach(() => {
  vi.useRealTimers();
});

describe('FR-AUTH-05 doctor report', () => {
  it('FR-AUTH-05: a healthy machine and Composer environment pass every check, in a stable order', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]));
    const report = await run(probes);
    expect(statuses(report, 'local')).toEqual([
      ['node.version', 'pass'],
      ['duckdb.load', 'pass'],
      ['config.valid', 'pass'],
      ['data-dir.writable', 'pass'],
      ['data-dir.permissions', 'pass'],
      ['data-dir.free-space', 'pass'],
      ['network.proxy', 'pass'],
      ['network.ca-bundle', 'pass'],
      ['gcloud.installed', 'pass'],
      ['adc.token', 'pass'],
    ]);
    expect(statuses(report, 'acme-composer-prod')).toEqual([
      ['composer.environment', 'pass'],
      ['airflow.version', 'pass'],
      ['airflow.health', 'pass'],
      ['airflow.role', 'pass'],
      ['monitoring.read', 'pass'],
      ['clock.skew', 'pass'],
    ]);
    expect(report.ok).toBe(true);
    expect(report.summary).toEqual({ pass: 16, warn: 0, fail: 0, skip: 0 });
    expect(report.startedAt).toBe(NOW);
  });

  it('FR-AUTH-05: every check has a title, one line of evidence, and a fix and docs link when it does not pass', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      nodeVersion: '20.11.1',
      token: async () => {
        throw new SourceError('unauthenticated', 'gcloud: Reauthentication required.');
      },
    });
    const report = await run(probes);
    for (const c of report.checks) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.evidence).not.toMatch(/\n/);
      expect(c.evidence.length).toBeGreaterThan(0);
      if (c.status === 'fail') {
        expect(c.fixHint, c.id).not.toBeNull();
        expect(c.docsUrl, c.id).toMatch(/^https:\/\//);
      }
    }
    expect(report.ok).toBe(false);
  });
});

describe('FR-AUTH-05 local checks', () => {
  it.each([
    ['22.12.0', 'pass'],
    ['22.20.0', 'pass'],
    ['24.1.0', 'pass'],
    ['22.11.0', 'fail'],
    ['20.18.1', 'fail'],
  ])('FR-AUTH-05: Node.js %s → %s', async (version, status) => {
    const { probes } = fakeProbes(workspace([]), { nodeVersion: version });
    const c = check(await run(probes), 'node.version');
    expect(c.status).toBe(status);
    expect(c.evidence).toContain(version);
    if (status === 'fail') {
      expect(c.fixHint).toMatch(/22\.12/);
      expect(c.docsUrl).toBe(DOCTOR_DOCS.nodeDownload);
    }
  });

  it('FR-AUTH-05: a DuckDB binary that does not load fails with the loader error', async () => {
    const { probes } = fakeProbes(workspace([]), {
      duckdb: async () => {
        throw new Error('Cannot find module duckdb.node');
      },
    });
    const c = check(await run(probes), 'duckdb.load');
    expect(c.status).toBe('fail');
    expect(c.evidence).toContain('Cannot find module duckdb.node');
    expect(c.fixHint).toMatch(/pnpm install/);
  });

  it('FR-SETUP-02: an invalid configuration fails, lists every issue with its path and fix, and no environment is checked', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      config: async () => ({
        kind: 'invalid',
        path: '/home/acme/dcam.config.yaml',
        issues: [
          { path: 'environments.0.projectId', message: 'Required', fixHint: 'Set projectId.' },
          { path: 'budgets.composerApiPerMinute', message: 'Above 60', fixHint: 'Use 60 or less.' },
        ],
      }),
    });
    const report = await run(probes);
    const c = check(report, 'config.valid');
    expect(c.status).toBe('fail');
    expect(c.evidence).toMatch(/2 problems/);
    expect(c.details).toEqual([
      'environments.0.projectId: Required. Fix: Set projectId.',
      'budgets.composerApiPerMinute: Above 60. Fix: Use 60 or less.',
    ]);
    expect(report.checks.filter((x) => x.scope !== 'local')).toEqual([]);
    // The data directory falls back to the default when the file cannot be used.
    expect(check(report, 'data-dir.writable').evidence).toContain('/home/acme/.dcam/data');
  });

  it('FR-SETUP-02: a missing configuration file fails with the copy command', async () => {
    const { probes } = fakeProbes(workspace([]), {
      config: async () => ({ kind: 'missing', path: '/home/acme/dcam.config.yaml' }),
    });
    const c = check(await run(probes), 'config.valid');
    expect(c.status).toBe('fail');
    expect(c.fixHint).toContain('cp dcam.config.example.yaml dcam.config.yaml');
  });

  it('FR-AUTH-05: a configuration without environments warns', async () => {
    const { probes } = fakeProbes(workspace([]));
    expect(check(await run(probes), 'config.valid').status).toBe('warn');
  });

  it.each<[string, Partial<DataDirFacts>, string, string, RegExp]>([
    ['writable directory', {}, 'darwin', 'pass', /writable/],
    ['missing, parent writable', { state: 'missing' }, 'darwin', 'pass', /creates it/],
    ['not writable', { writable: false }, 'darwin', 'fail', /not writable/],
    ['a file, not a directory', { state: 'not-a-directory' }, 'darwin', 'fail', /not a directory/],
  ])('FR-AUTH-05: data directory %s → %s', async (_name, facts, platform, status, evidence) => {
    const { probes } = fakeProbes(workspace([]), { dataDir: facts, platform });
    const c = check(await run(probes), 'data-dir.writable');
    expect(c.status).toBe(status);
    expect(c.evidence).toMatch(evidence);
  });

  it.each<[string, Partial<DataDirFacts>, string, string]>([
    ['0700', { mode: 0o700 }, 'darwin', 'pass'],
    ['0750 (group can read)', { mode: 0o750 }, 'linux', 'warn'],
    ['0755 (anyone can read)', { mode: 0o755 }, 'darwin', 'warn'],
    ['Windows', { mode: null }, 'win32', 'skip'],
    ['missing', { state: 'missing', mode: null }, 'darwin', 'skip'],
  ])('FR-AUTH-05: data directory mode %s → %s', async (_name, facts, platform, status) => {
    const { probes } = fakeProbes(workspace([]), { dataDir: facts, platform });
    const c = check(await run(probes), 'data-dir.permissions');
    expect(c.status).toBe(status);
    if (status === 'warn') {
      expect(c.fixHint).toBe("chmod 700 '/home/acme/.dcam/data'");
      expect(c.evidence).toMatch(/0[57]5[05]/);
    }
  });

  it.each<[number | null, string]>([
    [50 * 2 ** 30, 'pass'],
    [3 * 2 ** 30, 'warn'],
    [0.5 * 2 ** 30, 'fail'],
    [null, 'skip'],
  ])('FR-AUTH-05: %s bytes free → %s', async (freeBytes, status) => {
    const { probes } = fakeProbes(workspace([]), { dataDir: { freeBytes } });
    const c = check(await run(probes), 'data-dir.free-space');
    expect(c.status).toBe(status);
    if (freeBytes !== null) expect(c.evidence).toMatch(/GiB free/);
  });

  it.each([
    ['darwin', /macOS/],
    ['win32', /Windows/],
    ['linux', /Linux/],
  ])(
    'FR-AUTH-02: without gcloud on %s, the doctor shows OS-specific install steps and skips ADC',
    async (platform, os) => {
      const { probes } = fakeProbes(workspace([composerEntry()]), { platform, gcloud: async () => null });
      const report = await run(probes);
      const g = check(report, 'gcloud.installed');
      expect(g.status).toBe('fail');
      expect(g.fixHint).toMatch(os);
      expect(g.docsUrl).toBe(DOCTOR_DOCS.gcloudInstall);
      expect(check(report, 'adc.token')).toMatchObject({ status: 'skip' });
      expect(check(report, 'adc.token').evidence).toContain('Google Cloud CLI installed');
      expect(check(report, 'composer.environment', 'acme-composer-prod').status).toBe('skip');
    },
  );

  it('FR-AUTH-02: gcloud is only a warning when no Composer environment is selected', async () => {
    const { probes } = fakeProbes(workspace([emulatorEntry]), { gcloud: async () => null });
    const report = await run(probes);
    expect(check(report, 'gcloud.installed').status).toBe('warn');
    expect(check(report, 'adc.token').status).toBe('skip');
    expect(check(report, 'airflow.health', 'acme-emulator').status).toBe('pass');
  });

  it('FR-AUTH-02: without valid ADC, the doctor shows the login command and skips the Google checks', async () => {
    const secret = `ya29.${'a'.repeat(40)}`;
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      token: async () => {
        throw new SourceError('unauthenticated', `Reauthentication failed for token ${secret}`);
      },
    });
    const report = await run(probes);
    const adc = check(report, 'adc.token');
    expect(adc.status).toBe('fail');
    expect(adc.fixHint).toBe('gcloud auth application-default login');
    expect(adc.docsUrl).toBe(DOCTOR_DOCS.adcLogin);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(statuses(report, 'acme-composer-prod')).toEqual([
      ['composer.environment', 'skip'],
      ['airflow.version', 'skip'],
      ['airflow.health', 'skip'],
      ['airflow.role', 'skip'],
      ['monitoring.read', 'skip'],
      ['clock.skew', 'pass'],
    ]);
    expect(check(report, 'monitoring.read', 'acme-composer-prod').evidence).toContain(
      'Application Default Credentials',
    );
  });

  it('NFR-SEC-04: with DCAM_NETWORK=loopback-only the ADC check and the Google checks skip with the reason', async () => {
    const reason = 'DCAM_NETWORK=loopback-only: no Google token is requested';
    const { probes, calls } = fakeProbes(workspace([composerEntry(), emulatorEntry]), {
      token: async () => {
        throw new SourceError('guard', reason);
      },
    });
    const report = await run(probes);
    expect(check(report, 'adc.token').status).toBe('skip');
    expect(check(report, 'adc.token').evidence).toContain(reason);
    expect(statuses(report, 'acme-composer-prod')).toEqual([
      ['composer.environment', 'skip'],
      ['airflow.version', 'skip'],
      ['airflow.health', 'skip'],
      ['airflow.role', 'skip'],
      ['monitoring.read', 'skip'],
      ['clock.skew', 'skip'],
    ]);
    for (const id of ['composer.environment', 'monitoring.read', 'clock.skew'] as const)
      expect(check(report, id, 'acme-composer-prod').evidence, id).toContain(reason);
    // Nothing was asked of Google; the loopback emulator is still checked.
    expect(calls.serverDateUrls).toEqual(['http://127.0.0.1:8080/api/v1/health']);
    expect(check(report, 'airflow.health', 'acme-emulator').status).toBe('pass');
    expect(report.ok).toBe(true);
  });

  it('FR-AUTH-01: the access token never appears in the report', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]), { token: async () => 'tok-SECRET-123' });
    const report = await run(probes);
    expect(check(report, 'adc.token').status).toBe('pass');
    expect(JSON.stringify(report)).not.toContain('tok-SECRET-123');
  });
});

describe('FR-AUTH-07 proxy and CA bundle', () => {
  it.each<[string, string, DoctorProxySettings, RegExp]>([
    ['no proxy variables', 'pass', NO_PROXIES, /direct/],
    [
      'HTTPS_PROXY and NO_PROXY',
      'pass',
      {
        ...NO_PROXIES,
        https: corpProxy('HTTPS_PROXY'),
        noProxy: { variable: 'NO_PROXY', value: '10.0.0.0/8' },
      },
      /^HTTPS_PROXY=http:\/\/proxy\.acme\.example:3128, NO_PROXY=10\.0\.0\.0\/8\.$/,
    ],
    [
      'a value without a scheme, which the transport reads as http://',
      'pass',
      { ...NO_PROXIES, https: corpProxy('HTTPS_PROXY', true) },
      /HTTPS_PROXY=http:\/\/proxy\.acme\.example:3128 \(no scheme given, so http:\/\/ is used\)/,
    ],
    [
      'a remote proxy that DCAM_NETWORK=loopback-only does not use',
      'pass',
      { ...NO_PROXIES, dropped: [corpProxy('HTTPS_PROXY')] },
      /HTTPS_PROXY=http:\/\/proxy\.acme\.example:3128 is not used: DCAM_NETWORK=loopback-only/,
    ],
    [
      'a lower-case variable that hides a different upper-case one',
      'warn',
      {
        ...NO_PROXIES,
        https: corpProxy('https_proxy'),
        shadowed: [{ used: 'https_proxy', ignored: 'HTTPS_PROXY' }],
      },
      /https_proxy and HTTPS_PROXY differ, and https_proxy is used/,
    ],
  ])('FR-AUTH-07: %s → %s', async (_name, status, settings, evidence) => {
    const { probes } = fakeProbes(workspace([composerEntry()]), { proxySettings: () => settings });
    const c = check(await run(probes), 'network.proxy');
    expect(c.status).toBe(status);
    expect(c.evidence).toMatch(evidence);
    if (status !== 'pass') expect(c.docsUrl).toBe(DOCTOR_DOCS.gcloudProxy);
  });

  it("FR-AUTH-07: proxy settings the transport refuses fail with the transport's own message", async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      proxySettings: () => {
        throw new Error('HTTPS_PROXY must be an http:// or https:// URL, not socks5://');
      },
    });
    const c = check(await run(probes), 'network.proxy');
    expect(c.status).toBe('fail');
    expect(c.evidence).toContain('HTTPS_PROXY must be an http:// or https:// URL, not socks5://');
    expect(c.fixHint).toMatch(/HTTPS_PROXY/);
    expect(c.docsUrl).toBe(DOCTOR_DOCS.gcloudProxy);
  });

  it('FR-AUTH-07: a remote proxy and a loopback Airflow without NO_PROXY pass: the emulator goes direct', async () => {
    const { probes } = fakeProbes(workspace([emulatorEntry]), {
      proxySettings: () => ({
        ...NO_PROXIES,
        https: corpProxy('https_proxy'),
        http: corpProxy('http_proxy'),
      }),
      proxyRoute: remoteProxyRoute,
    });
    const report = await run(probes);
    expect(check(report, 'network.proxy').status).toBe('pass');
    expect(check(report, 'airflow.health', 'acme-emulator')).toMatchObject({ status: 'pass' });
    expect(check(report, 'airflow.health', 'acme-emulator').evidence).not.toContain('through proxy');
  });

  it('FR-AUTH-07: proxy credentials are never printed, even if a probe returned them', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      proxySettings: () => ({
        ...NO_PROXIES,
        https: {
          variable: 'HTTPS_PROXY',
          url: 'http://alice:s3cret@proxy.acme.example:3128',
          schemeAdded: false,
        },
      }),
    });
    const report = await run(probes);
    expect(JSON.stringify(report)).not.toContain('s3cret');
    expect(JSON.stringify(report)).not.toContain('alice');
    expect(check(report, 'network.proxy').evidence).toContain('http://***@proxy.acme.example:3128');
  });

  it("FR-AUTH-07: the environment checks name the proxy of the transport's route", async () => {
    const { probes, calls } = fakeProbes(workspace([composerEntry()]), { proxyRoute: remoteProxyRoute });
    const report = await run(probes);
    for (const id of ['composer.environment', 'airflow.health', 'monitoring.read'] as const)
      expect(check(report, id, 'acme-composer-prod').evidence, id).toContain(
        'through proxy proxy.acme.example:3128',
      );
    expect(calls.routedUrls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^https:\/\/composer\.googleapis\.com\//),
        expect.stringMatching(/^https:\/\/monitoring\.googleapis\.com\//),
        runningEnv.airflowUri,
      ]),
    );
  });

  it('FR-AUTH-07: a route that cannot be computed leaves the evidence without a proxy name', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      proxyRoute: () => {
        throw new Error('HTTPS_PROXY must be an http:// or https:// URL, not socks5://');
      },
    });
    const c = check(await run(probes), 'composer.environment', 'acme-composer-prod');
    expect(c.status).toBe('pass');
    expect(c.evidence).not.toContain('through proxy');
  });

  it.each<[string, Record<string, string>, Record<string, string>, string | null, string, RegExp]>([
    ['no extra bundle', {}, {}, null, 'pass', /Node\.js's built-in/],
    [
      'NODE_EXTRA_CA_CERTS with two certificates',
      { NODE_EXTRA_CA_CERTS: '/etc/acme/ca.pem' },
      { '/etc/acme/ca.pem': PEM + PEM },
      null,
      'pass',
      /NODE_EXTRA_CA_CERTS: 2 certificates/,
    ],
    [
      'network.caBundlePath readable',
      {},
      { '/etc/acme/corp.pem': PEM },
      '/etc/acme/corp.pem',
      'pass',
      /network\.caBundlePath: 1 certificate/,
    ],
    [
      'NODE_EXTRA_CA_CERTS unreadable',
      { NODE_EXTRA_CA_CERTS: '/etc/acme/missing.pem' },
      {},
      null,
      'fail',
      /cannot be read/,
    ],
    [
      'a bundle without PEM certificates',
      {},
      { '/etc/acme/corp.der': 'binary' },
      '/etc/acme/corp.der',
      'fail',
      /no PEM certificate/,
    ],
  ])('FR-AUTH-07: %s → %s', async (_name, env, files, caBundlePath, status, evidence) => {
    const { probes } = fakeProbes(workspace([composerEntry()], { caBundlePath }), { env, files });
    const c = check(await run(probes), 'network.ca-bundle');
    expect(c.status).toBe(status);
    expect(c.evidence).toMatch(evidence);
    if (status === 'fail') expect(c.docsUrl).toBe(DOCTOR_DOCS.nodeExtraCaCerts);
  });
});

describe('FR-AUTH-05 Composer environment checks', () => {
  const failing = (error: Error) =>
    fakeProbes(workspace([composerEntry()]), {
      envs: {
        'acme-composer-prod': {
          composer: async () => {
            throw error;
          },
        },
      },
    }).probes;

  it.each<[string, SourceError, RegExp, string]>([
    [
      'unauthenticated',
      new SourceError('unauthenticated', 'Request had invalid authentication credentials.', { status: 401 }),
      /gcloud auth application-default login/,
      DOCTOR_DOCS.adcLogin,
    ],
    [
      'forbidden',
      new SourceError('forbidden', "Permission 'composer.environments.get' denied", { status: 403 }),
      /roles\/composer\.viewer on acme-prod-123/,
      DOCTOR_DOCS.composerIam,
    ],
    [
      'quota project',
      new SourceError('quota-project', 'Caller does not have required permission to use project', {
        status: 403,
      }),
      /^gcloud auth application-default set-quota-project acme-prod-123$/,
      DOCTOR_DOCS.setQuotaProject,
    ],
    [
      'API disabled',
      new SourceError('api-disabled', 'Cloud Composer API has not been used in project', { status: 403 }),
      /gcloud services enable composer\.googleapis\.com --project=acme-prod-123/,
      DOCTOR_DOCS.enableApi,
    ],
    [
      'not found',
      new SourceError('not-found', 'Environment not found', { status: 404 }),
      /projectId, location and environment/,
      DOCTOR_DOCS.composerIam,
    ],
    ['network', new SourceError('network', 'connect ECONNREFUSED'), /HTTPS_PROXY/, DOCTOR_DOCS.gcloudProxy],
  ])('FR-AUTH-04: Composer %s fails with a matching fix', async (_name, error, fix, docs) => {
    const report = await run(failing(error));
    const c = check(report, 'composer.environment', 'acme-composer-prod');
    expect(c.status).toBe('fail');
    expect(c.fixHint).toMatch(fix);
    expect(c.docsUrl).toBe(docs);
    expect(c.evidence).toContain(error.message);
  });

  it('FR-AUTH-06: a VPC Service Controls denial shows its unique identifier and the perimeter explanation', async () => {
    const report = await run(
      failing(
        new SourceError('vpc-sc', 'Request is prohibited by organization policy', {
          status: 403,
          vpcScId: 'acme-unique-id-42',
        }),
      ),
    );
    const c = check(report, 'composer.environment', 'acme-composer-prod');
    expect(c.status).toBe('fail');
    expect(c.evidence).toContain('VPC Service Controls');
    expect(c.evidence).toContain('acme-unique-id-42');
    expect(c.fixHint).toMatch(/access level/);
    expect(c.docsUrl).toBe(DOCTOR_DOCS.vpcSc);
  });

  it('FR-AUTH-04: the quota project named in the evidence is auth.quotaProjectId when set', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()], { quotaProjectId: 'acme-billing-9' }), {
      envs: {
        'acme-composer-prod': {
          composer: async () => {
            throw new SourceError('quota-project', 'quota project denied', { status: 403 });
          },
        },
      },
    });
    const report = await run(probes);
    const c = check(report, 'composer.environment', 'acme-composer-prod');
    expect(c.fixHint).toBe('gcloud auth application-default set-quota-project acme-billing-9');
    expect(c.details.join(' ')).toMatch(/auth\.quotaProjectId/);
    expect(
      check(
        await run(fakeProbes(workspace([composerEntry()])).probes),
        'composer.environment',
        'acme-composer-prod',
      ).evidence,
    ).toContain('quota project acme-prod-123');
  });

  it('FR-AUTH-05: a failed Composer check skips the Airflow checks with the reason; Monitoring still runs', async () => {
    const report = await run(failing(new SourceError('forbidden', 'denied', { status: 403 })));
    expect(statuses(report, 'acme-composer-prod')).toEqual([
      ['composer.environment', 'fail'],
      ['airflow.version', 'skip'],
      ['airflow.health', 'skip'],
      ['airflow.role', 'skip'],
      ['monitoring.read', 'pass'],
      ['clock.skew', 'pass'],
    ]);
    expect(check(report, 'airflow.health', 'acme-composer-prod').evidence).toContain(
      'Composer API: environment readable',
    );
  });

  it('FR-AUTH-05: an unreachable Composer API skips the clock check instead of failing twice', async () => {
    const report = await run(failing(new SourceError('network', 'getaddrinfo ENOTFOUND')));
    expect(check(report, 'clock.skew', 'acme-composer-prod').status).toBe('skip');
  });

  it('FR-AUTH-05: an environment that is not RUNNING warns and shows the state as reported', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      envs: { 'acme-composer-prod': { composer: async () => ({ ...runningEnv, state: 'UPDATING' }) } },
    });
    const c = check(await run(probes), 'composer.environment', 'acme-composer-prod');
    expect(c.status).toBe('warn');
    expect(c.evidence).toContain('UPDATING');
  });

  it.each<[string, string, RegExp]>([
    ['composer-3-airflow-2.11.1-build.22', 'pass', /Composer 3, Airflow 2\.11\.1/],
    ['composer-2.16.1-airflow-2.10.5', 'pass', /Composer 2, Airflow 2\.10\.5/],
    ['composer-2.9.7-airflow-2.9.3', 'warn', /2\.10 or later/],
    ['composer-1.20.12-airflow-2.4.3', 'warn', /Composer 1/],
    ['composer-3-airflow-3.1.7-build.3', 'fail', /Airflow 3/],
    ['acme-custom-image', 'warn', /could not read/],
  ])('FR-COLL-09: image %s → %s', async (imageVersion, status, evidence) => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      envs: { 'acme-composer-prod': { composer: async () => ({ ...runningEnv, imageVersion }) } },
    });
    const report = await run(probes);
    const c = check(report, 'airflow.version', 'acme-composer-prod');
    expect(c.status).toBe(status);
    expect(c.evidence).toMatch(evidence);
    if (status === 'fail') {
      expect(c.fixHint).toMatch(/M4/);
      expect(check(report, 'airflow.health', 'acme-composer-prod').status).toBe('skip');
      expect(check(report, 'airflow.role', 'acme-composer-prod').status).toBe('skip');
    }
  });

  it('FR-AUTH-05: no airflowUri skips the Airflow checks', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      envs: {
        'acme-composer-prod': {
          composer: async () => ({ ...runningEnv, state: 'CREATING', airflowUri: null }),
        },
      },
    });
    const report = await run(probes);
    expect(check(report, 'airflow.health', 'acme-composer-prod')).toMatchObject({ status: 'skip' });
    expect(check(report, 'airflow.health', 'acme-composer-prod').evidence).toContain('airflowUri');
  });
});

describe('FR-AUTH-05 Airflow web server and role', () => {
  const withAirflow = (fakes: EnvFakes, proxied = false) =>
    fakeProbes(workspace([composerEntry()]), {
      envs: { 'acme-composer-prod': fakes },
      ...(proxied ? { proxyRoute: remoteProxyRoute } : {}),
    });

  it('FR-AUTH-07: the web server is called at the airflowUri from Composer', async () => {
    const { probes, calls } = withAirflow({});
    await run(probes);
    expect(new Set(calls.airflowBaseUrls)).toEqual(new Set([runningEnv.airflowUri]));
  });

  it('FR-AUTH-07: an unreachable web server fails with the proxy and access-control hint', async () => {
    const { probes } = withAirflow(
      {
        health: async () => {
          throw new SourceError('network', 'self-signed certificate in certificate chain');
        },
      },
      true,
    );
    const report = await run(probes);
    const c = check(report, 'airflow.health', 'acme-composer-prod');
    expect(c.status).toBe('fail');
    expect(c.evidence).toContain('self-signed certificate');
    expect(c.evidence).toContain('through proxy proxy.acme.example:3128');
    expect(c.fixHint).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(check(report, 'airflow.role', 'acme-composer-prod').status).toBe('skip');
  });

  it('FR-COLL-08: a 404 from the web server names Airflow 3, which replaced the REST API v1', async () => {
    const { probes } = withAirflow({
      health: async () => {
        throw new SourceError('not-found', 'GET /api/v1/health returned 404', { status: 404 });
      },
    });
    const c = check(await run(probes), 'airflow.health', 'acme-composer-prod');
    expect(c.status).toBe('fail');
    expect(c.evidence).toMatch(/^No Airflow REST API v1 here/);
    expect(c.fixHint).toMatch(/Airflow 3 replaced the REST API v1 with \/api\/v2/);
    expect(c.fixHint).toMatch(/M4/);
  });

  it('FR-AUTH-05: an unhealthy scheduler is a warning, not a failure', async () => {
    const { probes } = withAirflow({
      health: async () => ({
        ...healthy,
        scheduler: { status: 'unhealthy', latestHeartbeat: NOW - 600_000 },
      }),
    });
    const c = check(await run(probes), 'airflow.health', 'acme-composer-prod');
    expect(c.status).toBe('warn');
    expect(c.evidence).toMatch(/scheduler unhealthy/);
  });

  it.each<[string, EnvFakes, string, RegExp]>([
    ['Viewer (providers refused)', { providers: async () => false }, 'pass', /2000 DAGs/],
    ['Op or higher (providers readable)', { providers: async () => true }, 'warn', /Op or higher/],
    [
      'no Airflow role',
      {
        dags: async () => {
          throw new SourceError('forbidden', 'Forbidden', { status: 403 });
        },
      },
      'fail',
      /no Airflow role/,
    ],
  ])('FR-AUTH-05: Airflow role %s → %s', async (_name, fakes, status, evidence) => {
    const { probes } = withAirflow(fakes);
    const c = check(await run(probes), 'airflow.role', 'acme-composer-prod');
    expect(c.status).toBe(status);
    expect(c.evidence).toMatch(evidence);
    if (status !== 'pass') {
      expect(c.fixHint).toMatch(/Viewer/);
      expect(c.docsUrl).toBe(DOCTOR_DOCS.airflowRbac);
    }
  });
});

describe('FR-AUTH-07 fix hints from the transport', () => {
  const TLS_HINT =
    'The TLS certificate presented for composer.googleapis.com is not trusted (SELF_SIGNED_CERT_IN_CHAIN). ' +
    'Start DCAM with NODE_EXTRA_CA_CERTS=<file> or set network.caBundlePath in dcam.config.yaml.';
  const PROXY_AUTH_HINT =
    'The proxy asked for authentication (407). Check HTTPS_PROXY and HTTP_PROXY: proxy credentials go in the URL.';
  const REDIRECT_HINT = 'DCAM never follows redirects. A proxy sign-in or block page often causes this.';
  const composerFailing = (error: SourceError) =>
    fakeProbes(workspace([composerEntry()]), {
      envs: {
        'acme-composer-prod': {
          composer: async () => {
            throw error;
          },
          series: async () => {
            throw error;
          },
        },
      },
    }).probes;

  it.each<[string, SourceError]>([
    [
      'TLS inspection',
      new SourceError('network', 'GET composer.googleapis.com/v1 failed (SELF_SIGNED_CERT_IN_CHAIN)', {
        fixHint: TLS_HINT,
      }),
    ],
    ['proxy authentication', new SourceError('network', 'proxy answered 407', { fixHint: PROXY_AUTH_HINT })],
    [
      'a timeout',
      new SourceError('timeout', 'timed out after 30000 ms', {
        fixHint: 'The server did not answer in time.',
      }),
    ],
  ])("FR-AUTH-07: the Google checks keep the transport's hint for %s", async (_name, error) => {
    const report = await run(composerFailing(error));
    for (const id of ['composer.environment', 'monitoring.read'] as const) {
      const c = check(report, id, 'acme-composer-prod');
      expect(c.status, id).toBe('fail');
      expect(c.fixHint, id).toBe(error.details.fixHint);
      expect(c.evidence, id).toMatch(/^No answer from /);
    }
  });

  it('FR-AUTH-07: a redirect says the service answered HTTP 3xx, with the redirect hint', async () => {
    const error = new SourceError(
      'network',
      'composer.googleapis.com answered 302; DCAM does not follow redirects',
      {
        status: 302,
        fixHint: REDIRECT_HINT,
      },
    );
    const c = check(await run(composerFailing(error)), 'composer.environment', 'acme-composer-prod');
    expect(c.status).toBe('fail');
    expect(c.evidence).toMatch(/^composer\.googleapis\.com answered HTTP 302: /);
    expect(c.evidence).not.toContain('No answer');
    expect(c.fixHint).toBe(REDIRECT_HINT);
  });

  it('FR-AUTH-07: without a hint from the transport the generic network hint stays, without NO_PROXY advice', async () => {
    const error = new SourceError('network', 'connect ECONNRESET');
    const c = check(await run(composerFailing(error)), 'composer.environment', 'acme-composer-prod');
    expect(c.fixHint).toMatch(/HTTPS_PROXY/);
    expect(c.fixHint).not.toMatch(/NO_PROXY/);
  });

  it.each<[string, SourceError, RegExp]>([
    [
      'TLS inspection',
      new SourceError('network', 'self-signed certificate', { fixHint: TLS_HINT }),
      /^No answer from /,
    ],
    [
      'a redirect',
      new SourceError('network', 'answered 302', { status: 302, fixHint: REDIRECT_HINT }),
      /^acme-prod-dot-europe-west1\.composer\.googleusercontent\.com answered HTTP 302: /,
    ],
  ])(
    "FR-AUTH-07: the Airflow web server check keeps the transport's hint for %s",
    async (_name, error, evidence) => {
      const { probes } = fakeProbes(workspace([composerEntry()]), {
        envs: {
          'acme-composer-prod': {
            health: async () => {
              throw error;
            },
          },
        },
      });
      const c = check(await run(probes), 'airflow.health', 'acme-composer-prod');
      expect(c.status).toBe('fail');
      expect(c.evidence).toMatch(evidence);
      expect(c.fixHint).toBe(error.details.fixHint);
    },
  );

  it('FR-EMU-02: unset emulator credentials say that nothing was sent, not that the server rejected them', async () => {
    const hint =
      'Set DCAM_EMULATOR_USER and DCAM_EMULATOR_PASSWORD in the shell that starts DCAM, then restart it.';
    const { probes } = fakeProbes(workspace([emulatorEntry]), {
      envs: {
        'acme-emulator': {
          health: async () => {
            throw new SourceError(
              'unauthenticated',
              'The Airflow user name or password of acme-emulator is not set.',
              {
                fixHint: hint,
              },
            );
          },
        },
      },
    });
    const c = check(await run(probes), 'airflow.health', 'acme-emulator');
    expect(c.status).toBe('fail');
    expect(c.evidence).not.toMatch(/rejected|answered/);
    expect(c.evidence).toContain('The Airflow user name or password of acme-emulator is not set.');
    expect(c.evidence).toContain('Nothing was sent to 127.0.0.1:8080.');
    expect(c.fixHint).toBe(hint);
  });

  it('FR-AUTH-05: a 401 from the web server still says it rejected the credentials', async () => {
    const { probes } = fakeProbes(workspace([emulatorEntry]), {
      envs: {
        'acme-emulator': {
          health: async () => {
            throw new SourceError('unauthenticated', 'Unauthorized', { status: 401 });
          },
        },
      },
    });
    const c = check(await run(probes), 'airflow.health', 'acme-emulator');
    expect(c.evidence).toMatch(
      /^The web server rejected the credentials\. 127\.0\.0\.1:8080 answered \(HTTP 401\)/,
    );
    expect(c.fixHint).toMatch(/usernameEnv and passwordEnv/);
  });
});

describe('FR-AUTH-05 Monitoring and clock', () => {
  it('FR-AUTH-05: the Monitoring probe is one small query on the environment resource', async () => {
    const { probes, calls } = fakeProbes(workspace([composerEntry()]));
    await run(probes);
    expect(calls.metricQueries).toHaveLength(1);
    const q = calls.metricQueries[0]!;
    expect(q).toMatchObject({
      projectId: 'acme-prod-123',
      metricType: 'composer.googleapis.com/environment/healthy',
      resourceType: 'cloud_composer_environment',
      resourceLabels: {
        project_id: 'acme-prod-123',
        location: 'europe-west1',
        environment_name: 'acme-composer-prod',
      },
      to: NOW,
    });
    expect(q.alignmentPeriodSeconds).toBeGreaterThanOrEqual(60);
    expect(q.to - q.from).toBeLessThanOrEqual(30 * 60_000);
  });

  it.each<[string, EnvFakes['series'], string, RegExp | null]>([
    ['no series', async () => [], 'warn', null],
    [
      'forbidden',
      async () => {
        throw new SourceError('forbidden', 'Permission monitoring.timeSeries.list denied', { status: 403 });
      },
      'fail',
      /roles\/monitoring\.viewer/,
    ],
    [
      'API disabled',
      async () => {
        throw new SourceError('api-disabled', 'Cloud Monitoring API has not been used', { status: 403 });
      },
      'fail',
      /monitoring\.googleapis\.com/,
    ],
  ])('FR-AUTH-05: Monitoring %s → %s', async (_name, series, status, fix) => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      envs: { 'acme-composer-prod': { series: series! } },
    });
    const c = check(await run(probes), 'monitoring.read', 'acme-composer-prod');
    expect(c.status).toBe(status);
    if (fix) expect(c.fixHint).toMatch(fix);
  });

  it.each<[string, number, string]>([
    ['in step', 0, 'pass'],
    ['2 s ahead', 2_000, 'pass'],
    ['90 s behind', -90_000, 'warn'],
    ['6 min ahead', 360_000, 'fail'],
  ])('FR-AUTH-05: clock %s → %s', async (_name, localAhead, status) => {
    const { probes, calls } = fakeProbes(workspace([composerEntry()]), {
      envs: { 'acme-composer-prod': { serverDate: async () => NOW - localAhead } },
    });
    const c = check(await run(probes), 'clock.skew', 'acme-composer-prod');
    expect(c.status).toBe(status);
    expect(calls.serverDateUrls).toEqual([
      'https://composer.googleapis.com/v1/projects/acme-prod-123/locations/europe-west1/environments/acme-composer-prod',
    ]);
    if (localAhead > 0) expect(c.evidence).toMatch(/ahead/);
    if (localAhead < 0) expect(c.evidence).toMatch(/behind/);
  });

  it('FR-AUTH-05: a server without a Date header leaves the clock unchecked', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      envs: { 'acme-composer-prod': { serverDate: async () => null } },
    });
    const c = check(await run(probes), 'clock.skew', 'acme-composer-prod');
    expect(c.status).toBe('warn');
    expect(c.evidence).toMatch(/no Date header/);
  });
});

describe('FR-EMU-02 self-managed Airflow (the emulator)', () => {
  it('FR-AUTH-05: checks the Airflow API at the configured URL; Composer and Monitoring do not apply', async () => {
    const { probes, calls } = fakeProbes(workspace([emulatorEntry]));
    const report = await run(probes);
    expect(statuses(report, 'acme-emulator')).toEqual([
      ['composer.environment', 'skip'],
      ['airflow.health', 'pass'],
      ['airflow.version', 'pass'],
      ['airflow.role', 'pass'],
      ['monitoring.read', 'skip'],
      ['clock.skew', 'pass'],
    ]);
    expect(new Set(calls.airflowBaseUrls)).toEqual(new Set(['http://127.0.0.1:8080']));
    expect(calls.serverDateUrls).toEqual(['http://127.0.0.1:8080/api/v1/health']);
    expect(check(report, 'airflow.version', 'acme-emulator').evidence).toContain('2.11.1');
  });

  it('FR-COLL-08: an Airflow 3 emulator is reported as unsupported', async () => {
    const { probes } = fakeProbes(workspace([emulatorEntry]), {
      envs: { 'acme-emulator': { version: async () => ({ version: '3.1.7' }) } },
    });
    const report = await run(probes);
    expect(check(report, 'airflow.version', 'acme-emulator').status).toBe('fail');
    expect(check(report, 'airflow.role', 'acme-emulator').status).toBe('skip');
  });
});

describe('FR-AUTH-05 environment selection', () => {
  it('FR-AUTH-05: --env checks only the named environments and fails for unknown ones', async () => {
    const { probes } = fakeProbes(
      workspace([composerEntry('acme-composer-prod'), composerEntry('acme-composer-dev')]),
    );
    const report = await run(probes, ['acme-composer-dev', 'acme-nope']);
    const scopes = [...new Set(report.checks.map((c) => c.scope))];
    expect(scopes).toEqual(['local', 'acme-nope', 'acme-composer-dev']);
    const unknown = check(report, 'env.configured', 'acme-nope');
    expect(unknown.status).toBe('fail');
    expect(unknown.evidence).toContain('acme-composer-prod, acme-composer-dev');
    expect(report.ok).toBe(false);
  });
});

describe('FR-AUTH-05 time limit', () => {
  it('FR-AUTH-05: an environment that does not answer fails after 30 s; the other environments finish', async () => {
    vi.useFakeTimers();
    let clock = NOW;
    const { probes } = fakeProbes(
      workspace([composerEntry('acme-composer-prod'), composerEntry('acme-composer-dev')]),
      {
        envs: {
          'acme-composer-prod': {
            health: () => new Promise<AirflowHealth>(() => undefined),
          },
        },
      },
    );
    const pending = runDoctor(probes, { now: () => clock });
    let done: DoctorReport | null = null;
    void pending.then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(done).toBeNull();
    clock += 30_000;
    await vi.advanceTimersByTimeAsync(1);
    const report = await pending;
    const hung = check(report, 'airflow.health', 'acme-composer-prod');
    expect(hung.status).toBe('fail');
    expect(hung.evidence).toMatch(/30 s/);
    expect(statuses(report, 'acme-composer-prod').slice(3)).toEqual([
      ['airflow.role', 'skip'],
      ['monitoring.read', 'skip'],
      ['clock.skew', 'skip'],
    ]);
    expect(statuses(report, 'acme-composer-dev').every(([, s]) => s === 'pass')).toBe(true);
  });

  it('FR-AUTH-05: the time limit is configurable', async () => {
    vi.useFakeTimers();
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      envs: { 'acme-composer-prod': { composer: () => new Promise<ComposerEnvironment>(() => undefined) } },
    });
    const pending = runDoctor(probes, { now: () => NOW, perEnvTimeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const c = check(await pending, 'composer.environment', 'acme-composer-prod');
    expect(c.status).toBe('fail');
    expect(c.evidence).toMatch(/5 s/);
  });
});

describe('FR-AUTH-05 robustness', () => {
  it('FR-AUTH-05: a probe that throws fails only its own check', async () => {
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      envs: {
        'acme-composer-prod': {
          serverDate: async () => {
            throw new TypeError('unexpected');
          },
        },
      },
    });
    const report = await run(probes);
    expect(check(report, 'clock.skew', 'acme-composer-prod')).toMatchObject({
      status: 'fail',
      evidence: 'unexpected',
    });
    expect(report.summary.fail).toBe(1);
  });

  it('FR-AUTH-01: adapter fix hints and evidence are redacted', async () => {
    const token = 'ya29.' + 'b'.repeat(30);
    const { probes } = fakeProbes(workspace([composerEntry()]), {
      envs: {
        'acme-composer-prod': {
          composer: async () => {
            throw new SourceError('invalid-response', 'Bearer ' + token + ' was echoed', {
              fixHint: 'curl -H "Authorization: Bearer ' + token + '"',
            });
          },
        },
      },
    });
    const report = await run(probes);
    const c = check(report, 'composer.environment', 'acme-composer-prod');
    expect(c.status).toBe('fail');
    expect(JSON.stringify(report)).not.toContain(token);
    expect(c.fixHint).toContain('Bearer ***');
  });
});
