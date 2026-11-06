import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Collector } from '@dcam/application';
import type { Collection, Meta } from '@dcam/contracts';
import { DB_FILE_NAME } from '@dcam/duckdb-store';
import type { Transport } from '@dcam/http-guard';
import type { AccessTokenSource } from '@dcam/ports';
import { buildApp } from '../src/app';
import { openConfiguredWorkspace, type RunningWorkspace } from '../src/live/workspace';

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
    expect(meta.environments).toEqual([{ env_id: 'acme-emulator', display_name: 'Emulator', tier: 'dev' }]);
    const collection = await get<Collection>(ws, '/api/v1/collection');
    expect(collection.mode).toBe('live');
    expect(collection.environments.map((e) => e.env_id)).toEqual(['acme-emulator']);
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
});
