import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collector } from '@dcam/application';
import type { Collection, Meta } from '@dcam/contracts';
import { DB_FILE_NAME } from '@dcam/duckdb-store';
import type { Transport } from '@dcam/http-guard';
import { SourceError, type AccessTokenSource } from '@dcam/ports';
import { buildApp } from '../src/app';
import { openConfiguredWorkspace, type RunningWorkspace } from '../src/live/workspace';
import { conforms } from './contract';

/** Every program the code under test tries to start; none is started (gcloud must never run here). */
const started = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    execFile: (file: string, args: readonly string[], ...rest: unknown[]) => {
      started.push([file, ...args].join(' '));
      const callback = rest.find((r) => typeof r === 'function') as
        ((error: Error, stdout: string, stderr: string) => void) | undefined;
      queueMicrotask(() =>
        callback?.(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', ''),
      );
      return { pid: undefined, kill: () => true };
    },
  };
});

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOST = '127.0.0.1:8787';

const EMULATOR_CONFIG = (dataDir: string) => `version: 1
workspace:
  dataDir: ${dataDir}
environments:
  - id: acme-emulator
    displayName: Emulator
    tier: dev
    profile: live
    airflow:
      baseUrl: http://127.0.0.1:8080
      usernameEnv: DCAM_EMULATOR_USER
      passwordEnv: DCAM_EMULATOR_PASSWORD
      limits: { parallelism: 32, schedulers: 1, maxActiveTasksPerDag: 16, maxActiveRunsPerDag: 25, workerConcurrency: 16, workers: 1 }
`;

/** One collector that asks the Airflow API for its version: enough to prove the wiring end to end. */
const versionCollector: Collector = {
  manifest: {
    id: 'af.inventory',
    source: 'SRC-AF-API',
    api: 'airflow',
    cadence: 'airflowInventory',
    priority: 'background',
    maxRequestsPerCycle: 1,
    outputs: ['dags'],
    sourceKinds: ['airflow', 'composer'],
  },
  async collect(ctx) {
    const { version } = await ctx.airflow().version();
    ctx.shared.airflowVersion = version;
    return { dataAsOf: ctx.now() };
  },
};

const COMPOSER_CONFIG = (dataDir: string) => `version: 1
workspace:
  dataDir: ${dataDir}
environments:
  - id: acme-composer-prod
    tier: prod
    projectId: acme-prod-123
    location: europe-west1
    environment: acme-composer-prod
`;

/** Reads the Composer environment once and keeps the error it got. */
function composerProbe() {
  const errors: unknown[] = [];
  const collector: Collector = {
    manifest: {
      id: 'composer.config',
      source: 'SRC-COMPOSER',
      api: 'composer',
      cadence: 'composer',
      priority: 'standard',
      maxRequestsPerCycle: 1,
      outputs: ['config'],
      sourceKinds: ['composer'],
    },
    async collect(ctx) {
      try {
        await ctx.composer?.environment({
          projectId: 'acme-prod-123',
          location: 'europe-west1',
          environment: 'acme-composer-prod',
        });
      } catch (error) {
        errors.push(error);
        throw error;
      }
      return { dataAsOf: null };
    },
  };
  return { collector, errors };
}

const tokens: AccessTokenSource = {
  accessToken: async () => {
    throw new Error('the emulator needs no Google token');
  },
  invalidate: () => undefined,
};

let dir: string;
let workspace: RunningWorkspace | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dcam-live-'));
});
afterEach(async () => {
  started.length = 0;
  await workspace?.close();
  workspace = undefined;
  await rm(dir, { recursive: true, force: true });
});

function fakeAirflow() {
  const sent: string[] = [];
  const transport: Transport = async (url) => {
    sent.push(url);
    return new Response(JSON.stringify({ version: '2.11.1', git_version: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { sent, transport };
}

async function open(env: Record<string, string> = {}, transport?: Transport) {
  const opened = await openConfiguredWorkspace({
    env: { DCAM_EMULATOR_USER: 'acme', DCAM_EMULATOR_PASSWORD: 'acme-secret', ...env },
    cwd: dir,
    homeDir: dir,
    now: () => NOW,
    tokens,
    collectors: [versionCollector],
    ...(transport === undefined ? {} : { transport }),
  });
  workspace = opened.workspace;
  return opened;
}

async function get<T>(ws: RunningWorkspace, url: string): Promise<T> {
  const app = await buildApp({ ...ws, version: '0.0.0-test', allowedHosts: [HOST] });
  const res = await app.inject({ method: 'GET', url, headers: { host: HOST } });
  expect(res.statusCode).toBe(200);
  return res.json<T>();
}

describe('live workspace (FR-SETUP-02, FR-COLL-11, HM-030, FR-STORE-01)', () => {
  it('FR-SETUP-02: without a configuration file DCAM starts in setup mode and collects nothing', async () => {
    const { workspace: ws } = await open();
    expect(ws.mode).toBe('live');
    expect(ws.environments).toEqual([]);
    expect(ws.setup?.configPath).toBeNull();
    expect(ws.setup?.issues[0]?.message).toMatch(/No configuration file was found/);
    ws.start();
    const meta = await get<Meta>(ws, '/api/v1/meta');
    expect(meta.setup?.config_path).toBeNull();
  });

  it('FR-SETUP-02: a missing --config file is named in setup mode, so the next steps can repeat it', async () => {
    const flagged = await openConfiguredWorkspace({
      configPath: join('configs', 'acme.yaml'),
      env: {},
      cwd: dir,
      homeDir: dir,
      now: () => NOW,
      tokens,
    });
    try {
      const meta = await get<Meta>(flagged.workspace, '/api/v1/meta');
      expect(meta.setup).toMatchObject({
        config_path: null,
        config_flag: join(dir, 'configs', 'acme.yaml'),
      });
    } finally {
      await flagged.workspace.close();
    }
    const { workspace: plain } = await open();
    expect((await get<Meta>(plain, '/api/v1/meta')).setup?.config_flag).toBeNull();
  });

  it('FR-SETUP-02: an invalid configuration starts setup mode with each issue and its fix', async () => {
    await writeFile(join(dir, 'dcam.config.yaml'), 'version: 1\nenvironments:\n  - id: Acme_Prod\n');
    const { workspace: ws } = await open();
    expect(ws.setup?.configPath).toBe(join(dir, 'dcam.config.yaml'));
    expect(ws.setup?.issues.length).toBeGreaterThan(0);
    for (const issue of ws.setup?.issues ?? []) expect(issue.fixHint).not.toBe('');
  });

  it('FR-COLL-11: a valid configuration starts live mode with every configured environment', async () => {
    const dataDir = join(dir, 'data');
    await writeFile(join(dir, 'dcam.config.yaml'), EMULATOR_CONFIG(dataDir));
    const { transport } = fakeAirflow();
    const { workspace: ws } = await open({}, transport);
    expect(ws.setup).toBeUndefined();
    const meta = await get<Meta>(ws, '/api/v1/meta');
    expect(meta.mode).toBe('live');
    // A self-managed Airflow: its UI is at the configured address, and it has no Cloud console pages.
    expect(meta.environments).toEqual([
      {
        env_id: 'acme-emulator',
        display_name: 'Emulator',
        tier: 'dev',
        airflow_uri: 'http://127.0.0.1:8080',
      },
    ]);
    const collection = await get<Collection>(ws, '/api/v1/collection');
    expect(collection.mode).toBe('live');
    expect(collection.environments.map((e) => e.env_id)).toEqual(['acme-emulator']);
  });

  it('FR-UI-04: meta says where a Composer environment lives: the file, then the airflowUri Composer reports', async () => {
    await writeFile(join(dir, 'dcam.config.yaml'), COMPOSER_CONFIG(join(dir, 'data')));
    // Stands in for composer.config: it learns the web server URL without calling anything.
    const learns: Collector = {
      manifest: {
        id: 'composer.config',
        source: 'SRC-COMPOSER',
        api: 'composer',
        cadence: 'composer',
        priority: 'standard',
        maxRequestsPerCycle: 1,
        outputs: ['config'],
        sourceKinds: ['composer'],
      },
      async collect(ctx) {
        ctx.shared.airflowBaseUrl = 'https://acme-composer-prod.airflow.example';
        return { dataAsOf: null };
      },
    };
    const opened = await openConfiguredWorkspace({
      env: {},
      cwd: dir,
      homeDir: dir,
      now: () => NOW,
      tokens,
      collectors: [learns],
    });
    const ws = (workspace = opened.workspace);
    const before = await get<Meta>(ws, '/api/v1/meta');
    expect(conforms('Meta', before)).toBe(true);
    expect(before.environments).toEqual([
      expect.objectContaining({
        env_id: 'acme-composer-prod',
        composer: {
          project_id: 'acme-prod-123',
          location: 'europe-west1',
          environment: 'acme-composer-prod',
        },
        airflow_uri: null,
      }),
    ]);
    ws.start();
    await expect
      .poll(async () => (await get<Meta>(ws, '/api/v1/meta')).environments[0]?.airflow_uri, {
        timeout: 5_000,
      })
      .toBe('https://acme-composer-prod.airflow.example');
  });

  it('FR-STORE-01: the DuckDB file lives in the configured data directory', async () => {
    const dataDir = join(dir, 'data');
    await writeFile(join(dir, 'dcam.config.yaml'), EMULATOR_CONFIG(dataDir));
    await open({}, fakeAirflow().transport);
    expect(existsSync(join(dataDir, DB_FILE_NAME))).toBe(true);
  });

  it('HM-030: collector requests go through the guarded client and show in the footprint', async () => {
    const dataDir = join(dir, 'data');
    await writeFile(join(dir, 'dcam.config.yaml'), EMULATOR_CONFIG(dataDir));
    const { sent, transport } = fakeAirflow();
    const { workspace: ws } = await open({}, transport);
    ws.start();
    await expect.poll(() => sent.length, { timeout: 5_000 }).toBe(1);
    expect(sent[0]).toBe('http://127.0.0.1:8080/api/v1/version');
    const status = ws.collection?.();
    const footprint = status?.environments[0]?.footprint.find((f) => f.api === 'airflow');
    expect(footprint).toMatchObject({ requests_1h: 1, requests_24h: 1, errors_24h: 0 });
  });

  it('FR-COLL-11: close stops the collectors and releases the data directory', async () => {
    const dataDir = join(dir, 'data');
    await writeFile(join(dir, 'dcam.config.yaml'), EMULATOR_CONFIG(dataDir));
    const first = await open({}, fakeAirflow().transport);
    first.workspace.start();
    await first.workspace.close();
    workspace = undefined;
    // A second DCAM on the same data directory can open the database once the first one closed.
    const second = await open({}, fakeAirflow().transport);
    expect(second.workspace.setup).toBeUndefined();
  });

  it('FR-STORE-07: maintenance runs on start, the collection status reports the store against its budget, and close stops it', async () => {
    const dataDir = join(dir, 'data');
    const config = EMULATOR_CONFIG(dataDir).replace(
      '    tier: dev\n',
      '    tier: dev\n    retention: { rawTaskInstancesDays: 30 }\n',
    );
    await writeFile(join(dir, 'dcam.config.yaml'), `${config}retention:\n  diskBudgetGb: 2\n`);
    const { workspace: ws } = await open({}, fakeAirflow().transport);
    expect(ws.collection?.().storage?.state).toBe('unknown');
    ws.start();
    await expect
      .poll(() => ws.collection?.().storage?.last_run?.finished_at, { timeout: 10_000 })
      .toBeTruthy();
    const collection = await get<Collection>(ws, '/api/v1/collection');
    expect(conforms('Collection', collection)).toBe(true);
    expect(collection.storage).toMatchObject({
      state: 'ok',
      budget_bytes: 2e9,
      warn_share: 0.9,
      last_run: { kind: 'retention', error: null, started_at: new Date(NOW).toISOString() },
      next_run_at: new Date(NOW + 3_600_000).toISOString(),
      budget_action: null,
    });
    expect(collection.storage?.file_bytes).toBeGreaterThan(0);
    expect(collection.environments[0]?.retention).toEqual({
      raw_task_instances_days: 30,
      raw_metric_points_days: 14,
    });
    await ws.close();
    workspace = undefined;
    // The store closed after maintenance stopped: the data directory opens again.
    expect((await open({}, fakeAirflow().transport)).workspace.setup).toBeUndefined();
  });

  it('NFR-SEC-04: with DCAM_NETWORK=loopback-only a Composer environment starts no gcloud and sends nothing', async () => {
    await writeFile(join(dir, 'dcam.config.yaml'), COMPOSER_CONFIG(join(dir, 'data')));
    const sent: string[] = [];
    const transport: Transport = async (url) => {
      sent.push(url);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const probe = composerProbe();
    const opened = await openConfiguredWorkspace({
      env: { DCAM_NETWORK: 'loopback-only' },
      cwd: dir,
      homeDir: dir,
      now: () => NOW,
      collectors: [probe.collector],
      transport,
    });
    workspace = opened.workspace;
    opened.workspace.start();
    await expect.poll(() => probe.errors.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(probe.errors[0]).toBeInstanceOf(SourceError);
    expect(probe.errors[0]).toMatchObject({
      kind: 'guard',
      message: 'DCAM_NETWORK=loopback-only: no Google token is requested',
    });
    expect(started).toEqual([]);
    expect(sent).toEqual([]);
  });

  it.each<[string, string, Record<string, string>, RegExp]>([
    [
      'a missing network.caBundlePath',
      'network:\n  caBundlePath: ./acme-missing-root.pem\n',
      {},
      /network\.caBundlePath: cannot read .*acme-missing-root\.pem/,
    ],
    ['a SOCKS proxy', '', { HTTPS_PROXY: 'socks5://proxy.acme.example:1080' }, /HTTPS_PROXY must be an http/],
    [
      'a mistyped DCAM_NETWORK',
      '',
      { DCAM_NETWORK: 'loopback' },
      /DCAM_NETWORK must be "loopback-only" or "any"/,
    ],
  ])(
    'FR-AUTH-07: %s stops start-up with its error, before the database is opened',
    async (_name, extra, env, message) => {
      const dataDir = join(dir, 'data');
      await writeFile(join(dir, 'dcam.config.yaml'), `${EMULATOR_CONFIG(dataDir)}${extra}`);
      // No injected transport: the real proxy- and CA-aware transport is built (and sends nothing).
      await expect(open(env)).rejects.toThrow(message);
      expect(existsSync(join(dataDir, DB_FILE_NAME))).toBe(false);
      expect(started).toEqual([]);
    },
  );
});
