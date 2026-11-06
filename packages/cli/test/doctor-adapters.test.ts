import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Transport } from '@dcam/http-guard';
import type { AccessTokenSource } from '@dcam/ports';
import { liveDoctorAdapters } from '../src/doctor/adapters';

const COMPOSER_CONFIG = `version: 1
environments:
  - id: acme-prod
    tier: prod
    projectId: acme-prod-project
    location: europe-west1
    environment: acme-prod
`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dcam-doctor-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const adapters = (
  overrides: { tokens?: AccessTokenSource; transport?: Transport } = {},
  configPath?: string,
) => liveDoctorAdapters({ configPath: configPath ?? null, env: {}, cwd, homeDir: cwd, ...overrides });

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
    expect(result).toMatchObject({ kind: 'valid', config: { environments: [{ id: 'acme-prod' }] } });
  });

  it('FR-AUTH-01: the environment probes use the token source the ADC check asked', async () => {
    await writeFile(join(cwd, 'dcam.config.yaml'), COMPOSER_CONFIG);
    let asked = 0;
    const tokens: AccessTokenSource = {
      accessToken: async () => `ya29.token-${++asked}`,
      invalidate: () => undefined,
    };
    const sent: Array<string | undefined> = [];
    const transport: Transport = async (_url, init) => {
      sent.push(init.headers['authorization'] ?? init.headers['Authorization']);
      return new Response(JSON.stringify({ state: 'RUNNING' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const wired = adapters({ tokens, transport });
    expect(wired.tokens).toBe(tokens);
    const result = await wired.loadConfig();
    if (result.kind !== 'valid') throw new Error('expected a valid configuration');
    const [entry] = result.config.environments;
    if (!entry) throw new Error('expected one environment');
    const probes = wired.environment(entry, result.config);
    await probes.composer?.environment({
      projectId: 'acme-prod-project',
      location: 'europe-west1',
      environment: 'acme-prod',
    });
    expect(sent).toEqual(['Bearer ya29.token-1']);
  });
});
