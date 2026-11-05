/**
 * Claude Code hook corpus (spec §21.5, Appendix F.12): each hook runs as Claude Code runs it, with
 * JSON on stdin; exit code 2 means blocked.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const run = (hook: string, input: unknown, env: Record<string, string> = {}, projectDir = ROOT) =>
  spawnSync('node', [join(ROOT, '.claude/hooks', hook)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', CLAUDE_PROJECT_DIR: projectDir, ...env },
  });

const bash = (command: string, mode: 'default' | 'cloud-read' = 'default') =>
  run('guard-bash.mjs', { tool_name: 'Bash', tool_input: { command } }, mode === 'cloud-read' ? { DCAM_HARNESS_CLOUD_READ: '1' } : {}).status;

describe('guard-bash.mjs (spec Appendix F.12)', () => {
  const cases: Array<[string, 'default' | 'cloud-read', 'allowed' | 'blocked']> = [
    ['pnpm test --filter @dcam/domain', 'default', 'allowed'],
    ['gcloud composer environments list --locations=europe-west1', 'default', 'blocked'],
    ['gcloud composer environments list --locations=europe-west1', 'cloud-read', 'allowed'],
    ['gcloud composer environments describe acme-prod --location europe-west1', 'cloud-read', 'blocked'],
    ['gcloud composer environments run acme-prod --location europe-west1 dags list', 'cloud-read', 'blocked'],
    ['gcloud auth print-access-token', 'cloud-read', 'blocked'],
    ['sh -c "gcloud composer environments delete x"', 'cloud-read', 'blocked'],
    ['echo x | xargs -I {} gcloud composer environments delete {}', 'cloud-read', 'blocked'],
    ['find . -name "*.yaml" -exec kubectl apply -f {} \;', 'default', 'blocked'],
    ['curl -s http://127.0.0.1:8787/api/v1/health', 'default', 'allowed'],
    ['curl -sd @body.json http://localhost/x', 'default', 'blocked'],
    ['curl -H "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/', 'default', 'blocked'],
    ['git -C ../other push -f', 'default', 'blocked'],
    ['$TOOL delete everything', 'default', 'blocked'],
    [`echo '{"env":{"DCAM_HARNESS_CLOUD_READ":"1"}}' > .claude/settings.local.json`, 'default', 'blocked'],
    ["echo 'gcloud composer environments delete x'", 'default', 'allowed'],
    ['terraform apply -auto-approve', 'default', 'blocked'],
    ['terraform validate', 'default', 'allowed'],
    ['cat ~/.config/gcloud/application_default_credentials.json', 'default', 'blocked'],
    ['git status && pnpm lint', 'default', 'allowed'],
  ];
  it.each(cases)('%s [%s] -> %s', (command, mode, expected) => {
    expect(bash(command, mode)).toBe(expected === 'blocked' ? 2 : 0);
  });

  it('fails closed when the hook input cannot be read', () => {
    const res = spawnSync('node', [join(ROOT, '.claude/hooks/guard-bash.mjs')], { input: 'not json', encoding: 'utf8' });
    expect(res.status).toBe(2);
  });
});

describe('guard-paths.mjs', () => {
  const project = mkdtempSync(join(tmpdir(), 'dcam-guard-'));
  mkdirSync(join(project, 'docs/adr'), { recursive: true });
  const adr = join(project, 'docs/adr/0005-analytical-store.md');
  writeFileSync(adr, '---\nstatus: accepted\ndate: 2026-11-05\n---\n\n# Use DuckDB\n\nBody.\n');
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  const edit = (input: Record<string, unknown>, tool = 'Edit') => run('guard-paths.mjs', { tool_name: tool, tool_input: input }, {}, project).status;

  it('blocks body edits of accepted ADRs and allows status-only edits', () => {
    expect(edit({ file_path: adr, old_string: 'Body.', new_string: 'Changed.' })).toBe(2);
    expect(edit({ file_path: adr, old_string: 'status: accepted', new_string: 'status: superseded by ADR-0030' })).toBe(0);
  });

  it('blocks writes outside the repository and to protected files', () => {
    expect(edit({ file_path: join(homedir(), '.zshrc'), content: '' }, 'Write')).toBe(2);
    for (const file of ['pnpm-lock.yaml', '.env', '.dcam-denylist', 'dcam.config.yaml', '.claude/settings.json', '.claude/hooks/guard-bash.mjs', 'packages/contracts/generated/x.ts']) {
      expect(edit({ file_path: join(project, file), content: '' }, 'Write')).toBe(2);
    }
  });

  it('allows ordinary source edits, and harness edits only in maintenance mode', () => {
    expect(edit({ file_path: join(project, 'packages/domain/src/x.ts'), content: '' }, 'Write')).toBe(0);
    const maintenance = run('guard-paths.mjs', { tool_name: 'Write', tool_input: { file_path: join(project, '.claude/settings.json'), content: '' } }, { DCAM_HARNESS_MAINTENANCE: '1' }, project);
    expect(maintenance.status).toBe(0);
  });
});
