import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkspaceConfig } from '../src/index';
import { HOME, tempDir } from './helpers';

const example = fileURLToPath(new URL('../../../../dcam.config.example.yaml', import.meta.url));

describe('FR-SETUP-02 dcam.config.example.yaml (§17.6)', () => {
  it('FR-SETUP-02: the example at the repository root loads with no issues and no warnings', async () => {
    const result = await loadWorkspaceConfig({ flagPath: example, env: {}, cwd: tempDir(), homeDir: HOME });
    if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
    expect(result.warnings).toEqual([]);
    expect(result.config.environments).toHaveLength(1);
    expect(result.config.environments[0]).toMatchObject({ tier: 'prod', source: { kind: 'composer' } });
    // Fictitious names only (spec §18.12).
    expect(result.config.environments[0]?.source).toEqual({
      kind: 'composer',
      projectId: expect.stringMatching(/^acme-/),
      location: 'europe-west1',
      environment: expect.stringMatching(/^acme-/),
    });
  });
});

const emulator = fileURLToPath(
  new URL('../../../../tools/emulator/dcam.config.emulator.yaml', import.meta.url),
);

describe('FR-EMU-02 tools/emulator/dcam.config.emulator.yaml (§20)', () => {
  it('FR-EMU-02: the emulator configuration loads with no issues and no warnings', async () => {
    const result = await loadWorkspaceConfig({ flagPath: emulator, env: {}, cwd: tempDir(), homeDir: HOME });
    if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
    expect(result.warnings).toEqual([]);
    expect(result.config.environments.map((e) => [e.id, e.source.kind])).toEqual([
      ['acme-emulator', 'airflow'],
    ]);
  });
});
