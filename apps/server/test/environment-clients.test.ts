import { describe, expect, it } from 'vitest';
import type { Transport } from '@dcam/http-guard';
import {
  SourceError,
  type AccessTokenSource,
  type EnvironmentEntry,
  type StaticLimits,
  type WorkspaceConfig,
} from '@dcam/ports';
import { createEnvironmentClients } from '../src/live/environment-clients';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const LIMITS: StaticLimits = {
  parallelism: 32,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 16,
  workers: 1,
};
const COMPOSER: EnvironmentEntry = {
  id: 'acme-prod',
  displayName: 'acme-prod',
  tier: 'prod',
  profile: 'standard',
  source: {
    kind: 'composer',
    projectId: 'acme-prod-project',
    location: 'europe-west1',
    environment: 'acme-prod',
  },
};
const EMULATOR: EnvironmentEntry = {
  id: 'acme-emulator',
  displayName: 'Emulator',
  tier: 'dev',
  profile: 'live',
  source: {
    kind: 'airflow',
    baseUrl: 'http://127.0.0.1:8080/',
    usernameEnv: 'DCAM_EMULATOR_USER',
    passwordEnv: 'DCAM_EMULATOR_PASSWORD',
    limits: LIMITS,
  },
};
const config = (overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig => ({
  path: '/home/acme/dcam.config.yaml',
  dataDir: '/home/acme/.dcam/data',
  quotaProjectId: null,
  caBundlePath: null,
  profiles: {
    live: { airflowLive: 30, airflowFacts: 60, airflowInventory: 3600, monitoring: 60, composer: 600 },
    standard: { airflowLive: 60, airflowFacts: 120, airflowInventory: 3600, monitoring: 120, composer: 900 },
    eco: { airflowLive: 300, airflowFacts: 600, airflowInventory: 21600, monitoring: 600, composer: 3600 },
  },
  budgets: {
    airflowApi: { live: 60, standard: 12, eco: 4, background: 2, maxConcurrent: 2 },
    monitoringPerProjectPerMinute: 30,
    composerApiPerMinute: 6,
  },
  environments: [COMPOSER, EMULATOR],
  ...overrides,
});

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A transport that answers every request with `body` and records what was sent. */
function fakeTransport(body: unknown, status = 200) {
  const sent: Sent[] = [];
  const transport: Transport = async (url, init) => {
    sent.push({ url, method: init.method, headers: init.headers });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', date: new Date(NOW - 2_000).toUTCString() },
    });
  };
  return { sent, transport };
}

const tokens: AccessTokenSource = { accessToken: async () => 'ya29.test-token', invalidate: () => undefined };
const header = (s: Sent | undefined, name: string) =>
  s ? Object.entries(s.headers).find(([k]) => k.toLowerCase() === name)?.[1] : undefined;

describe('environment clients on the guarded client (FR-AUTH-01, FR-AUTH-04, FR-EMU-02, HM-030)', () => {
  it('FR-AUTH-01: a Composer environment reads environments.get with the ADC bearer token', async () => {
    const { sent, transport } = fakeTransport({
      state: 'RUNNING',
      config: { airflowUri: 'https://example-dot-europe-west1.composer.googleusercontent.com' },
    });
    const clients = createEnvironmentClients({
      entry: COMPOSER,
      config: config(),
      env: {},
      tokens,
      transport,
    });
    expect(clients.composer).toBeDefined();
    expect(clients.monitoring).toBeDefined();
    await clients.composer?.environment({
      projectId: 'acme-prod-project',
      location: 'europe-west1',
      environment: 'acme-prod',
    });
    expect(sent[0]?.url).toBe(
      'https://composer.googleapis.com/v1/projects/acme-prod-project/locations/europe-west1/environments/acme-prod',
    );
    expect(sent[0]?.method).toBe('GET');
    expect(header(sent[0], 'authorization')).toBe('Bearer ya29.test-token');
  });

  it('FR-AUTH-04: the configured quota project goes in x-goog-user-project', async () => {
    const { sent, transport } = fakeTransport({ state: 'RUNNING' });
    const clients = createEnvironmentClients({
      entry: COMPOSER,
      config: config({ quotaProjectId: 'acme-quota' }),
      env: {},
      tokens,
      transport,
    });
    await clients.composer?.environment({
      projectId: 'acme-prod-project',
      location: 'europe-west1',
      environment: 'acme-prod',
    });
    expect(header(sent[0], 'x-goog-user-project')).toBe('acme-quota');
  });

  it("FR-AUTH-01: a Composer environment's Airflow API gets the same bearer token", async () => {
    const { sent, transport } = fakeTransport({ version: '2.11.1' });
    const clients = createEnvironmentClients({
      entry: COMPOSER,
      config: config(),
      env: {},
      tokens,
      transport,
    });
    const airflow = clients.airflow('https://example-dot-europe-west1.composer.googleusercontent.com');
    await expect(airflow.version()).resolves.toMatchObject({ version: '2.11.1' });
    expect(sent[0]?.url).toBe(
      'https://example-dot-europe-west1.composer.googleusercontent.com/api/v1/version',
    );
    expect(header(sent[0], 'authorization')).toBe('Bearer ya29.test-token');
  });

  it('HM-030: every request that reached the network is reported with its API', async () => {
    const { transport } = fakeTransport({ version: '2.11.1' });
    const seen: Array<{ api: string; status: number | null }> = [];
    const clients = createEnvironmentClients({
      entry: COMPOSER,
      config: config(),
      env: {},
      tokens,
      transport,
      now: () => NOW,
      onRequest: (api, request) => seen.push({ api, status: request.status }),
    });
    await clients.airflow('https://example-dot-europe-west1.composer.googleusercontent.com').version();
    await clients.composer
      ?.environment({ projectId: 'acme-prod-project', location: 'europe-west1', environment: 'acme-prod' })
      .catch(() => undefined);
    expect(seen).toEqual([
      { api: 'airflow', status: 200 },
      { api: 'composer', status: 200 },
    ]);
  });

  it('FR-EMU-02: a self-managed Airflow on loopback uses basic auth from the named variables', async () => {
    const { sent, transport } = fakeTransport({ version: '2.11.1' });
    const clients = createEnvironmentClients({
      entry: EMULATOR,
      config: config(),
      env: { DCAM_EMULATOR_USER: 'acme', DCAM_EMULATOR_PASSWORD: 'acme-secret' },
      tokens,
      transport,
    });
    expect(clients.composer).toBeUndefined();
    expect(clients.monitoring).toBeUndefined();
    await clients.airflow('http://127.0.0.1:8080/').version();
    expect(sent[0]?.url).toBe('http://127.0.0.1:8080/api/v1/version');
    expect(header(sent[0], 'authorization')).toBe(`Basic ${btoa('acme:acme-secret')}`);
  });

  it('NFR-SEC-03: missing credential variables fail with a hint that names them', async () => {
    const { sent, transport } = fakeTransport({ version: '2.11.1' });
    const clients = createEnvironmentClients({
      entry: EMULATOR,
      config: config(),
      env: {},
      tokens,
      transport,
    });
    const error = await clients
      .airflow('http://127.0.0.1:8080/')
      .version()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).kind).toBe('unauthenticated');
    expect((error as SourceError).details.fixHint).toMatch(/DCAM_EMULATOR_USER/);
    expect((error as SourceError).details.fixHint).toMatch(/DCAM_EMULATOR_PASSWORD/);
    expect(sent).toHaveLength(0);
  });

  it('NFR-SEC-04: DCAM_NETWORK=loopback-only refuses Google hosts before sending', async () => {
    const { sent, transport } = fakeTransport({ state: 'RUNNING' });
    const clients = createEnvironmentClients({
      entry: COMPOSER,
      config: config(),
      env: { DCAM_NETWORK: 'loopback-only' },
      tokens,
      transport,
    });
    const error = await clients.composer
      ?.environment({ projectId: 'acme-prod-project', location: 'europe-west1', environment: 'acme-prod' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).kind).toBe('guard');
    expect(sent).toHaveLength(0);
  });

  it("FR-AUTH-05: serverDate returns the server's Date header for the doctor's clock check", async () => {
    const { sent, transport } = fakeTransport({}, 401);
    const clients = createEnvironmentClients({
      entry: COMPOSER,
      config: config(),
      env: {},
      tokens,
      transport,
    });
    const url =
      'https://composer.googleapis.com/v1/projects/acme-prod-project/locations/europe-west1/environments/acme-prod';
    await expect(clients.serverDate(url)).resolves.toBe(NOW - 2_000);
    expect(header(sent[0], 'authorization')).toBeUndefined();
  });

  it.each<[string, string, Record<string, string>]>([
    ['https://acme-dot-europe-west1.composer.googleusercontent.com', 'acme-prod', {}],
    ['http://127.0.0.1:8080', 'acme-prod', {}],
    [
      'http://127.0.0.1:9090',
      'acme-emulator',
      { DCAM_EMULATOR_USER: 'acme', DCAM_EMULATOR_PASSWORD: 'acme-secret' },
    ],
  ])('NFR-SEC-04: the allowlist of each environment: %s from %s', async (baseUrl, id, env) => {
    const { sent, transport } = fakeTransport({ version: '2.11.1' });
    const entry = id === COMPOSER.id ? COMPOSER : EMULATOR;
    const clients = createEnvironmentClients({ entry, config: config(), env, tokens, transport });
    const result = await clients
      .airflow(baseUrl)
      .version()
      .then(
        () => 'sent',
        (e: unknown) => e,
      );
    if (baseUrl.startsWith('https://')) {
      expect(result).toBe('sent');
      return;
    }
    // A Composer environment never reaches a loopback Airflow, and the emulator only its own port.
    expect(result).toBeInstanceOf(SourceError);
    expect(result).toMatchObject({ kind: 'guard' });
    expect((result as SourceError).message).toContain(`${new URL(baseUrl).host} is not a monitored service`);
    expect(sent).toEqual([]);
  });
});

describe('environment clients on the real transport (FR-AUTH-07)', () => {
  it('FR-AUTH-07: a network.caBundlePath that cannot be read throws when the clients are built', () => {
    expect(() =>
      createEnvironmentClients({
        entry: COMPOSER,
        config: config({ caBundlePath: '/home/acme/acme-missing-root.pem' }),
        env: {},
        tokens,
      }),
    ).toThrow(/network\.caBundlePath: cannot read \/home\/acme\/acme-missing-root\.pem/);
  });

  it('FR-AUTH-07: a SOCKS proxy throws when the clients are built', () => {
    expect(() =>
      createEnvironmentClients({
        entry: COMPOSER,
        config: config(),
        env: { HTTPS_PROXY: 'socks5://proxy.acme.example:1080' },
        tokens,
      }),
    ).toThrow(/HTTPS_PROXY must be an http:\/\/ or https:\/\/ URL, not socks5:/);
  });

  it('FR-AUTH-07: valid settings build clients that close cleanly', async () => {
    const clients = createEnvironmentClients({
      entry: COMPOSER,
      config: config(),
      env: { HTTPS_PROXY: 'proxy.acme.example:3128', NO_PROXY: '10.0.0.0/8' },
      tokens,
    });
    await expect(clients.close()).resolves.not.toThrow();
  });
});
