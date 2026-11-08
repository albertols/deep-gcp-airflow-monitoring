import { describe, expect, it } from 'vitest';
import type { EnvironmentConfig } from '../src/index';
import { gcloudPoolSet } from '../src/advisor-text';

const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 96,
  schedulers: 2,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 12,
  minWorkers: 2,
  maxWorkers: 6,
  pools: [],
};
const commandLine = (code: string) => code.split('\n').find((l) => l.startsWith('  pools set')) ?? '';

describe('copy-only shell snippets (FR-ADV-03, spec §13.5)', () => {
  it('keeps a plain pool name readable', () => {
    const s = gcloudPoolSet(config, 'Raise pool external_api', 'external_api', 8);
    expect(commandLine(s.code)).toBe('  pools set -- external_api 8 "DESCRIPTION"');
  });

  it('single-quotes a pool name with spaces or shell syntax, so pasting it runs nothing else', () => {
    const s = gcloudPoolSet(config, 'Raise the pool', "etl pool $(touch x); it's", 8);
    expect(commandLine(s.code)).toBe(`  pools set -- 'etl pool $(touch x); it'\\''s' 8 "DESCRIPTION"`);
  });

  it('keeps a comment on its own line when the text it names contains a line break', () => {
    const s = gcloudPoolSet(config, 'Raise pool a\nrm -rf ~ of acme-prod', 'a', 8);
    const lines = s.code.split('\n');
    expect(lines[0]).toBe('# Raise pool a rm -rf ~ of acme-prod');
    expect(
      lines.filter((l) => !l.startsWith('#') && !l.startsWith('  ') && !l.startsWith('gcloud ')),
    ).toEqual([]);
  });
});
