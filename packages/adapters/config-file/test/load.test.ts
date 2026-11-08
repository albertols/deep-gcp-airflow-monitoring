import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configFileLocation, loadWorkspaceConfig } from '../src/index';
import { HOME, MINIMAL, tempDir, writeFile } from './helpers';

describe('FR-SETUP-02 configuration file location and precedence (§17.1)', () => {
  it('FR-SETUP-02: reads dcam.config.yaml from the working directory by default', async () => {
    const cwd = tempDir();
    const path = writeFile(cwd, 'dcam.config.yaml', MINIMAL);
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    expect(result).toMatchObject({ ok: true, config: { path } });
  });

  it('FR-SETUP-02: configFileLocation names the file that would be read, in the same order', () => {
    const cwd = tempDir();
    expect(configFileLocation({ env: {}, cwd, homeDir: HOME })).toBe(join(cwd, 'dcam.config.yaml'));
    expect(configFileLocation({ env: { DCAM_CONFIG: 'env.yaml' }, cwd, homeDir: HOME })).toBe(
      join(cwd, 'env.yaml'),
    );
    expect(
      configFileLocation({ flagPath: '~/flag.yaml', env: { DCAM_CONFIG: 'env.yaml' }, cwd, homeDir: HOME }),
    ).toBe(join(HOME, 'flag.yaml'));
  });

  it('FR-SETUP-02: DCAM_CONFIG overrides the default file, and --config overrides DCAM_CONFIG', async () => {
    const cwd = tempDir();
    writeFile(cwd, 'dcam.config.yaml', MINIMAL.replace('tier: prod', 'tier: dev'));
    const fromEnv = writeFile(cwd, 'env/dcam.yaml', MINIMAL.replace('tier: prod', 'tier: test'));
    const fromFlag = writeFile(cwd, 'flag/dcam.yaml', MINIMAL.replace('tier: prod', 'tier: uat'));

    const env = await loadWorkspaceConfig({ env: { DCAM_CONFIG: fromEnv }, cwd, homeDir: HOME });
    expect(env).toMatchObject({ ok: true, config: { path: fromEnv, environments: [{ tier: 'test' }] } });

    const flag = await loadWorkspaceConfig({
      flagPath: fromFlag,
      env: { DCAM_CONFIG: fromEnv },
      cwd,
      homeDir: HOME,
    });
    expect(flag).toMatchObject({ ok: true, config: { path: fromFlag, environments: [{ tier: 'uat' }] } });
  });

  it('FR-SETUP-02: resolves a relative --config or DCAM_CONFIG against the working directory', async () => {
    const cwd = tempDir();
    const path = writeFile(cwd, 'conf/dcam.yaml', MINIMAL);
    expect(
      await loadWorkspaceConfig({ flagPath: 'conf/dcam.yaml', env: {}, cwd, homeDir: HOME }),
    ).toMatchObject({
      ok: true,
      config: { path },
    });
    expect(
      await loadWorkspaceConfig({ env: { DCAM_CONFIG: 'conf/dcam.yaml' }, cwd, homeDir: HOME }),
    ).toMatchObject({
      ok: true,
      config: { path },
    });
  });

  it('FR-SETUP-02: a missing file names the path tried and says how to create one or run the demo', async () => {
    const cwd = tempDir();
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.configPath).toBeNull();
    expect(result.issues).toHaveLength(1);
    const [issue] = result.issues;
    expect(issue?.path).toBe('');
    expect(issue?.message).toContain(join(cwd, 'dcam.config.yaml'));
    expect(issue?.fixHint).toContain('cp dcam.config.example.yaml dcam.config.yaml');
    expect(issue?.fixHint).toContain('projectId, location and environment');
    expect(issue?.fixHint).toContain('pnpm dcam --demo');
  });

  it('FR-SETUP-02: a missing --config or DCAM_CONFIG file is reported with the path given', async () => {
    const cwd = tempDir();
    const flag = await loadWorkspaceConfig({ flagPath: 'nowhere.yaml', env: {}, cwd, homeDir: HOME });
    expect(flag).toMatchObject({ ok: false, configPath: null });
    if (flag.ok) return;
    expect(flag.issues[0]?.message).toContain(join(cwd, 'nowhere.yaml'));
    expect(flag.issues[0]?.fixHint).toContain('--config');

    const env = await loadWorkspaceConfig({ env: { DCAM_CONFIG: '~/gone.yaml' }, cwd, homeDir: HOME });
    expect(env).toMatchObject({ ok: false, configPath: null });
    if (env.ok) return;
    expect(env.issues[0]?.message).toContain(join(HOME, 'gone.yaml'));
    expect(env.issues[0]?.fixHint).toContain('DCAM_CONFIG');
  });

  it('FR-SETUP-02: an empty DCAM_CONFIG is ignored', async () => {
    const cwd = tempDir();
    const path = writeFile(cwd, 'dcam.config.yaml', MINIMAL);
    const result = await loadWorkspaceConfig({ env: { DCAM_CONFIG: '' }, cwd, homeDir: HOME });
    expect(result).toMatchObject({ ok: true, config: { path } });
  });
});

describe('FR-SETUP-02 data directory (§17.3, §17.5)', () => {
  it('FR-SETUP-02: defaults to ~/.dcam/data, expanded with the home directory', async () => {
    const cwd = tempDir();
    writeFile(cwd, 'dcam.config.yaml', MINIMAL);
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    expect(result).toMatchObject({ ok: true, config: { dataDir: join(HOME, '.dcam', 'data') } });
  });

  it('FR-SETUP-02: resolves a relative workspace.dataDir against the folder of the configuration file', async () => {
    const cwd = tempDir();
    const path = writeFile(cwd, 'team/dcam.yaml', `${MINIMAL}workspace:\n  dataDir: ./state\n`);
    const result = await loadWorkspaceConfig({ flagPath: path, env: {}, cwd, homeDir: HOME });
    expect(result).toMatchObject({ ok: true, config: { dataDir: join(cwd, 'team', 'state') } });
  });

  it('FR-SETUP-02: DCAM_DATA_DIR overrides workspace.dataDir (environment variables beat the file)', async () => {
    const cwd = tempDir();
    writeFile(cwd, 'dcam.config.yaml', `${MINIMAL}workspace:\n  dataDir: /var/acme/dcam\n`);
    const absolute = await loadWorkspaceConfig({ env: { DCAM_DATA_DIR: '~/elsewhere' }, cwd, homeDir: HOME });
    expect(absolute).toMatchObject({ ok: true, config: { dataDir: join(HOME, 'elsewhere') } });
    const relative = await loadWorkspaceConfig({ env: { DCAM_DATA_DIR: 'data' }, cwd, homeDir: HOME });
    expect(relative).toMatchObject({ ok: true, config: { dataDir: join(cwd, 'data') } });
    const empty = await loadWorkspaceConfig({ env: { DCAM_DATA_DIR: '' }, cwd, homeDir: HOME });
    expect(empty).toMatchObject({ ok: true, config: { dataDir: '/var/acme/dcam' } });
  });

  it('FR-AUTH-07: expands ~ in network.caBundlePath and keeps the quota project', async () => {
    const cwd = tempDir();
    writeFile(
      cwd,
      'dcam.config.yaml',
      `${MINIMAL}auth:\n  quotaProjectId: acme-data-ops\nnetwork:\n  proxy: from-env\n  caBundlePath: ~/certs/acme-root.pem\n`,
    );
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    expect(result).toMatchObject({
      ok: true,
      config: { quotaProjectId: 'acme-data-ops', caBundlePath: join(HOME, 'certs', 'acme-root.pem') },
    });
  });
});

describe('FR-SETUP-05 profiles and budgets (§17.2, §7.11)', () => {
  it('FR-SETUP-05: applies the §17.2 cadences and §7.11 budgets when the file sets none', async () => {
    const cwd = tempDir();
    const path = writeFile(cwd, 'dcam.config.yaml', MINIMAL);
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    expect(result).toEqual({
      ok: true,
      warnings: [],
      config: {
        path,
        dataDir: join(HOME, '.dcam', 'data'),
        quotaProjectId: null,
        caBundlePath: null,
        profiles: {
          live: { airflowLive: 10, airflowFacts: 30, airflowInventory: 300, monitoring: 60, composer: 300 },
          standard: {
            airflowLive: 30,
            airflowFacts: 60,
            airflowInventory: 600,
            monitoring: 60,
            composer: 600,
          },
          eco: {
            airflowLive: 120,
            airflowFacts: 300,
            airflowInventory: 3000,
            monitoring: 300,
            composer: 1800,
          },
        },
        budgets: {
          airflowApi: { live: 60, standard: 12, eco: 4, background: 2, maxConcurrent: 2 },
          monitoringPerProjectPerMinute: 30,
          composerApiPerMinute: 6,
        },
        retention: {
          rawTaskInstancesDays: 90,
          rawMetricPointsDays: 14,
          rollup5mDays: 90,
          rollup1hDays: 400,
          logSignaturesDays: 30,
          findingsDays: 400,
          diskBudgetGb: 5,
        },
        environments: [
          {
            id: 'acme-prod',
            displayName: 'acme-prod',
            tier: 'prod',
            profile: 'standard',
            source: {
              kind: 'composer',
              projectId: 'acme-data-prod',
              location: 'europe-west1',
              environment: 'acme-prod',
            },
            backfill: { taskInstancesDays: 7, metricsDays: 14 },
          },
        ],
      },
    });
  });

  it('FR-SETUP-05: a partial profile or budget override keeps the other defaults', async () => {
    const cwd = tempDir();
    writeFile(
      cwd,
      'dcam.config.yaml',
      `${MINIMAL}profiles:\n  live: { airflowLive: 15 }\nbudgets:\n  airflowApi: { standard: 20 }\n  composerApi: { perMinute: 3 }\n`,
    );
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.config.profiles.live).toEqual({
      airflowLive: 15,
      airflowFacts: 30,
      airflowInventory: 300,
      monitoring: 60,
      composer: 300,
    });
    expect(result.config.budgets).toEqual({
      airflowApi: { live: 60, standard: 20, eco: 4, background: 2, maxConcurrent: 2 },
      monitoringPerProjectPerMinute: 30,
      composerApiPerMinute: 3,
    });
  });

  it('FR-STORE-02: retention per class and per environment overrides the workspace value', async () => {
    const cwd = tempDir();
    writeFile(
      cwd,
      'dcam.config.yaml',
      `${MINIMAL}    retention: { rawTaskInstancesDays: 30 }\nretention:\n  rawMetricPointsDays: 7\n  diskBudgetGb: 2.5\n`,
    );
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.warnings).toEqual([]);
    expect(result.config.retention).toMatchObject({
      rawTaskInstancesDays: 90,
      rawMetricPointsDays: 7,
      diskBudgetGb: 2.5,
    });
    expect(result.config.environments[0]?.retention).toEqual({ rawTaskInstancesDays: 30 });
  });

  it('FR-SETUP-05: the profile defaults by tier (prod standard, every other tier eco); an explicit profile wins', async () => {
    const cwd = tempDir();
    const entry = (id: string, extra: string) =>
      `  - id: ${id}\n    projectId: acme-data\n    location: europe-west1\n    environment: ${id}\n${extra}`;
    writeFile(
      cwd,
      'dcam.config.yaml',
      [
        'version: 1',
        'environments:',
        entry('acme-prod', '    tier: prod\n'),
        entry('acme-uat', '    tier: uat\n'),
        entry('acme-dev', '    tier: dev\n'),
        entry('acme-misc', ''),
        entry('acme-live', '    tier: prod\n    profile: live\n    displayName: Production (live)\n'),
        entry('acme-off', '    tier: dev\n    profile: "off"\n'),
      ].join('\n'),
    );
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.config.environments.map((e) => [e.id, e.tier, e.profile, e.displayName])).toEqual([
      ['acme-prod', 'prod', 'standard', 'acme-prod'],
      ['acme-uat', 'uat', 'eco', 'acme-uat'],
      ['acme-dev', 'dev', 'eco', 'acme-dev'],
      ['acme-misc', 'other', 'eco', 'acme-misc'],
      ['acme-live', 'prod', 'live', 'Production (live)'],
      ['acme-off', 'dev', 'off', 'acme-off'],
    ]);
  });

  it('FR-EMU-02: maps a self-managed Airflow on loopback to an airflow source with static limits', async () => {
    const cwd = tempDir();
    writeFile(
      cwd,
      'dcam.config.yaml',
      `version: 1
environments:
  - id: acme-emulator
    displayName: Emulator
    tier: dev
    profile: live
    airflow:
      baseUrl: http://127.0.0.1:8080/
      usernameEnv: DCAM_AIRFLOW_USERNAME
      passwordEnv: DCAM_AIRFLOW_PASSWORD
      limits: { parallelism: 32, schedulers: 1, maxActiveTasksPerDag: 16, maxActiveRunsPerDag: 25, workerConcurrency: 16, workers: 1 }
`,
    );
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.config.environments).toEqual([
      {
        id: 'acme-emulator',
        displayName: 'Emulator',
        tier: 'dev',
        profile: 'live',
        source: {
          kind: 'airflow',
          baseUrl: 'http://127.0.0.1:8080',
          usernameEnv: 'DCAM_AIRFLOW_USERNAME',
          passwordEnv: 'DCAM_AIRFLOW_PASSWORD',
          limits: {
            parallelism: 32,
            schedulers: 1,
            maxActiveTasksPerDag: 16,
            maxActiveRunsPerDag: 25,
            workerConcurrency: 16,
            workers: 1,
          },
        },
        backfill: { taskInstancesDays: 7, metricsDays: 14 },
      },
    ]);
  });

  it('FR-COLL-04: backfills 7 days of task instances and 14 days of metrics by default; each can be changed or turned off', async () => {
    const cwd = tempDir();
    const entry = (id: string, extra: string) =>
      `  - id: ${id}\n    projectId: acme-data\n    location: europe-west1\n    environment: ${id}\n${extra}`;
    writeFile(
      cwd,
      'dcam.config.yaml',
      [
        'version: 1',
        'environments:',
        entry('acme-prod', ''),
        entry('acme-test', '    backfill: { taskInstancesDays: 3 }\n'),
        entry('acme-dev', '    backfill: { taskInstancesDays: 0, metricsDays: 0 }\n'),
      ].join('\n'),
    );
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.warnings).toEqual([]);
    expect(result.config.environments.map((e) => [e.id, e.backfill])).toEqual([
      ['acme-prod', { taskInstancesDays: 7, metricsDays: 14 }],
      ['acme-test', { taskInstancesDays: 3, metricsDays: 14 }],
      ['acme-dev', { taskInstancesDays: 0, metricsDays: 0 }],
    ]);
  });

  it('FR-COLL-04, FR-STORE-02: a backfill never reads further back than its environment keeps data, and says so when it was set', async () => {
    const cwd = tempDir();
    const entry = (id: string, extra: string) =>
      `  - id: ${id}\n    projectId: acme-data\n    location: europe-west1\n    environment: ${id}\n${extra}`;
    writeFile(
      cwd,
      'dcam.config.yaml',
      [
        'version: 1',
        'environments:',
        // Set explicitly beyond its own retention: capped, with a warning per key.
        entry(
          'acme-prod',
          '    backfill: { taskInstancesDays: 30, metricsDays: 10 }\n    retention: { rawTaskInstancesDays: 10 }\n',
        ),
        // The default backfill (14 days of metrics) beyond the workspace's 3 days: capped without a warning.
        entry('acme-test', ''),
        'retention:',
        '  rawMetricPointsDays: 3',
        '',
      ].join('\n'),
    );
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.config.environments.map((e) => [e.id, e.backfill])).toEqual([
      ['acme-prod', { taskInstancesDays: 10, metricsDays: 3 }],
      ['acme-test', { taskInstancesDays: 7, metricsDays: 3 }],
    ]);
    expect(result.warnings.map((w) => w.path).sort()).toEqual([
      'environments.0.backfill.metricsDays',
      'environments.0.backfill.taskInstancesDays',
    ]);
    expect(result.warnings[0]?.message).toMatch(/kept/);
    expect(result.warnings[0]?.fixHint).toMatch(/retention/);
  });

  it('FR-COLL-04: refuses backfills longer than the raw task instance retention (90 days) or Monitoring retention (42 days)', async () => {
    const cwd = tempDir();
    writeFile(
      cwd,
      'dcam.config.yaml',
      `${MINIMAL}    backfill: { taskInstancesDays: 91, metricsDays: 43 }\n`,
    );
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path).sort()).toEqual([
      'environments.0.backfill.metricsDays',
      'environments.0.backfill.taskInstancesDays',
    ]);
  });

  it('FR-SETUP-02: empty sections (every child commented out) count as absent', async () => {
    const cwd = tempDir();
    writeFile(cwd, 'dcam.config.yaml', `${MINIMAL}auth:\n  # quotaProjectId: acme-data-ops\nbudgets:\n`);
    const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
    expect(result).toMatchObject({ ok: true, config: { quotaProjectId: null } });
  });
});
