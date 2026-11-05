import type { ConfigIssue } from '@dcam/ports';
import { describe, expect, it } from 'vitest';
import { loadWorkspaceConfig } from '../src/index';
import { HOME, MINIMAL, tempDir, writeFile } from './helpers';

/** Loads `text` as `<tmp>/dcam.config.yaml` and returns the issues, failing the test when it loads. */
async function issuesOf(text: string): Promise<readonly ConfigIssue[]> {
  const cwd = tempDir();
  const path = writeFile(cwd, 'dcam.config.yaml', text);
  const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
  if (result.ok) throw new Error('expected the configuration to be rejected');
  expect(result.configPath).toBe(path);
  return result.issues;
}

async function warningsOf(text: string): Promise<readonly ConfigIssue[]> {
  const cwd = tempDir();
  writeFile(cwd, 'dcam.config.yaml', text);
  const result = await loadWorkspaceConfig({ env: {}, cwd, homeDir: HOME });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.warnings;
}

const byPath = (issues: readonly ConfigIssue[], path: string) => issues.find((i) => i.path === path);

/** Every issue must say what is wrong and what to do: no empty text (spec §12.12). */
function expectActionable(issues: readonly ConfigIssue[]) {
  expect(issues.length).toBeGreaterThan(0);
  for (const issue of issues) {
    expect(issue.message.length).toBeGreaterThan(0);
    expect(issue.fixHint.length).toBeGreaterThan(0);
  }
}

describe('FR-SETUP-02 YAML syntax errors', () => {
  it('FR-SETUP-02: a YAML syntax error reports its line and column', async () => {
    const issues = await issuesOf(
      'version: 1\nenvironments:\n  - id: acme-prod\n   projectId: acme-data-prod\n',
    );
    expectActionable(issues);
    expect(issues[0]?.path).toBe('');
    expect(issues[0]?.message).toMatch(/line 4, column \d+/);
  });

  it('FR-SETUP-02: a key repeated in one mapping is a syntax error with its line', async () => {
    const issues = await issuesOf(`${MINIMAL}version: 1\n`);
    expect(issues[0]?.message).toMatch(/line 8, column 1/);
    expect(issues[0]?.message).toMatch(/twice|unique/i);
  });

  it('FR-SETUP-02: YAML errors never echo the text of the offending line', async () => {
    const secret = 'acme-s3cr3t-value';
    const issues = await issuesOf(`version: 1\nauth: { quotaProjectId: "${secret}\n`);
    expectActionable(issues);
    for (const issue of issues) expect(JSON.stringify(issue)).not.toContain(secret);
  });

  it('FR-SETUP-02: an empty file or a file that is not a mapping is explained', async () => {
    const empty = await issuesOf('# nothing here yet\n');
    expect(empty).toHaveLength(1);
    expect(empty[0]?.message).toMatch(/empty/i);
    const list = await issuesOf('- version: 1\n');
    expect(list).toHaveLength(1);
    expect(list[0]?.message).toMatch(/mapping/i);
  });

  it('FR-SETUP-02: an alias without an anchor is explained instead of thrown', async () => {
    const issues = await issuesOf(`${MINIMAL}auth:\n  quotaProjectId: *acme\n`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/alias/);
  });

  it('FR-SETUP-02: YAML tags are refused (DCAM reads plain values only)', async () => {
    const issues = await issuesOf(`${MINIMAL}auth:\n  quotaProjectId: !vault acme-data-ops\n`);
    expect(issues[0]?.message).toMatch(/line 9, column 19/);
  });
});

describe('FR-SETUP-02 schema issues name the path and a fix', () => {
  it('FR-SETUP-02: a missing version says to add version: 1', async () => {
    const issues = await issuesOf(MINIMAL.replace('version: 1\n', ''));
    expect(issues).toEqual([
      expect.objectContaining({ path: 'version', fixHint: expect.stringContaining('version: 1') }),
    ]);
  });

  it('FR-SETUP-02: an unknown key is an error whose hint names the closest known key', async () => {
    const issues = await issuesOf(`${MINIMAL}workspace:\n  dataDirectory: ./state\n`);
    expectActionable(issues);
    const issue = byPath(issues, 'workspace.dataDirectory');
    expect(issue?.message).toContain('dataDirectory');
    expect(issue?.fixHint).toContain('dataDir');

    const nested = await issuesOf(MINIMAL.replace('tier: prod', 'tier: prod\n    projectID: acme-data-prod'));
    expect(byPath(nested, 'environments.0.projectID')?.fixHint).toContain('projectId');

    const top = await issuesOf(`${MINIMAL}budget:\n  composerApi: { perMinute: 3 }\n`);
    expect(byPath(top, 'budget')?.fixHint).toContain('budgets');

    const part = await issuesOf(`${MINIMAL}workspace:\n  timezone: browser\n`);
    expect(byPath(part, 'workspace.timezone')?.fixHint).toContain('Did you mean `displayTimezone`?');
  });

  it('FR-SETUP-02: keys documented in §17.2 but not used yet are warnings, and the file still loads', async () => {
    const warnings = await warningsOf(
      `${MINIMAL}    color: "#F28B82"\n    team: data-platform\nserver:\n  port: 8787\nretention:\n  rawTaskInstancesDays: 90\nworkspace:\n  name: acme-data-platform\n  displayTimezone: browser\nprofiles:\n  live: { bucket: 300 }\n`,
    );
    expect(warnings.map((w) => w.path).sort()).toEqual([
      'environments.0.color',
      'environments.0.team',
      'profiles.live.bucket',
      'retention',
      'server',
      'workspace.displayTimezone',
      'workspace.name',
    ]);
    expectActionable(warnings);
    for (const w of warnings) expect(w.message).toMatch(/not used/i);
  });

  it('FR-SETUP-02: the minimal file loads without warnings', async () => {
    expect(await warningsOf(MINIMAL)).toEqual([]);
  });

  it('FR-SETUP-02: a Composer environment needs projectId, location and environment', async () => {
    const issues = await issuesOf(
      'version: 1\nenvironments:\n  - id: acme-prod\n    projectId: acme-data-prod\n',
    );
    expect(issues.map((i) => i.path).sort()).toEqual([
      'environments.0.environment',
      'environments.0.location',
    ]);
    expectActionable(issues);
  });

  it('FR-SETUP-02: an environment has exactly one source', async () => {
    const issues = await issuesOf(
      `${MINIMAL}    airflow:\n      baseUrl: http://127.0.0.1:8080\n      usernameEnv: U\n      passwordEnv: P\n      limits: { parallelism: 32, schedulers: 1, maxActiveTasksPerDag: 16, maxActiveRunsPerDag: 25, workerConcurrency: 16, workers: 1 }\n`,
    );
    expect(byPath(issues, 'environments.0.airflow')?.message).toMatch(/one source/);
  });

  it('FR-SETUP-02: duplicate environment ids are an issue', async () => {
    const second = MINIMAL.split('\n').slice(2).join('\n');
    const issues = await issuesOf(`${MINIMAL}${second}`);
    expect(issues).toEqual([expect.objectContaining({ path: 'environments.1.id' })]);
    expect(issues[0]?.fixHint).toMatch(/unique|different/i);
  });

  it('FR-SETUP-02: an invalid id, tier or profile lists what is allowed', async () => {
    const issues = await issuesOf(
      MINIMAL.replace('id: acme-prod', 'id: Acme_Prod').replace(
        'tier: prod',
        'tier: production\n    profile: fast',
      ),
    );
    expect(byPath(issues, 'environments.0.id')?.fixHint).toMatch(/lowercase/);
    expect(byPath(issues, 'environments.0.tier')?.fixHint).toContain('dev, test, uat, prod, other');
    expect(byPath(issues, 'environments.0.profile')?.fixHint).toContain('live, standard, eco, off');
  });

  it('FR-SETUP-02: an empty environments list asks for at least one environment', async () => {
    const issues = await issuesOf('version: 1\nenvironments: []\n');
    expect(issues).toEqual([expect.objectContaining({ path: 'environments' })]);
    expect(issues[0]?.fixHint).toMatch(/at least one/);
  });

  it('FR-SETUP-02: a wrong type names the expected type without echoing the value', async () => {
    const issues = await issuesOf(`${MINIMAL}profiles:\n  live: { airflowLive: acme-not-a-number }\n`);
    const issue = byPath(issues, 'profiles.live.airflowLive');
    expect(issue?.message).toMatch(/number/);
    expect(JSON.stringify(issues)).not.toContain('acme-not-a-number');
  });

  it('FR-SETUP-02: an airflow source must name environment variables, not hold credentials', async () => {
    const issues = await issuesOf(`version: 1
environments:
  - id: acme-emulator
    airflow:
      baseUrl: http://10.0.0.7:8080
      usernameEnv: admin
      passwordEnv: "acme p4ss!"
      limits: { parallelism: 32, schedulers: 1, maxActiveTasksPerDag: 16, maxActiveRunsPerDag: 25, workerConcurrency: 16, workers: 1 }
`);
    expect(byPath(issues, 'environments.0.airflow.baseUrl')?.message).toMatch(/127\.0\.0\.1/);
    expect(byPath(issues, 'environments.0.airflow.passwordEnv')?.fixHint).toMatch(/environment variable/);
    expect(byPath(issues, 'environments.0.airflow.usernameEnv')).toBeUndefined();
    const text = JSON.stringify(issues);
    expect(text).not.toContain('acme p4ss!');
    expect(text).not.toContain('10.0.0.7');
  });

  it('FR-SETUP-02: every problem in the file is reported in one pass', async () => {
    const issues = await issuesOf(
      'version: 2\nworkspace:\n  dataDirr: x\nenvironments:\n  - id: acme-prod\n    tier: production\n',
    );
    expect(issues.map((i) => i.path).sort()).toEqual([
      'environments.0.environment',
      'environments.0.location',
      'environments.0.projectId',
      'environments.0.tier',
      'version',
      'workspace.dataDirr',
    ]);
  });
});

describe('FR-SETUP-05 budgets cannot exceed the hard maxima of §7.11', () => {
  it('FR-SETUP-05: a budget above its hard maximum is an error that names the maximum', async () => {
    const issues = await issuesOf(
      `${MINIMAL}budgets:\n  airflowApi: { live: 500, maxConcurrent: 8 }\n  monitoring: { perProjectPerMinute: 121 }\n  composerApi: { perMinute: 31 }\n`,
    );
    expect(issues.map((i) => i.path).sort()).toEqual([
      'budgets.airflowApi.live',
      'budgets.airflowApi.maxConcurrent',
      'budgets.composerApi.perMinute',
      'budgets.monitoring.perProjectPerMinute',
    ]);
    expect(byPath(issues, 'budgets.airflowApi.live')?.fixHint).toContain('120');
    expect(byPath(issues, 'budgets.airflowApi.maxConcurrent')?.fixHint).toContain('4');
    expect(byPath(issues, 'budgets.monitoring.perProjectPerMinute')?.fixHint).toContain('120');
    expect(byPath(issues, 'budgets.composerApi.perMinute')?.fixHint).toContain('30');
    for (const issue of issues) expect(issue.message).toMatch(/hard maximum/);
  });

  it('FR-SETUP-05: budgets at the hard maxima are accepted', async () => {
    const warnings = await warningsOf(
      `${MINIMAL}budgets:\n  airflowApi: { live: 120, maxConcurrent: 4 }\n  monitoring: { perProjectPerMinute: 120 }\n  composerApi: { perMinute: 30 }\n`,
    );
    expect(warnings).toEqual([]);
  });

  it('FR-SETUP-05: a cadence or budget must be greater than zero', async () => {
    const issues = await issuesOf(
      `${MINIMAL}profiles:\n  eco: { monitoring: 0 }\nbudgets:\n  airflowApi: { eco: -1 }\n`,
    );
    expect(issues.map((i) => i.path).sort()).toEqual(['budgets.airflowApi.eco', 'profiles.eco.monitoring']);
    for (const issue of issues) expect(issue.message).toMatch(/greater than 0/);
  });
});
