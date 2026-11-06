import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configFlagPath, findFreePort, parseCli } from '../src/index';

describe('FR-SETUP-01 start command', () => {
  it('FR-SETUP-01: parses start options with defaults', () => {
    expect(parseCli(['--demo'])).toEqual({
      command: 'start',
      demo: true,
      port: 8787,
      open: true,
      config: null,
    });
    expect(parseCli(['start', '--demo', '--port', '9000', '--no-open'])).toEqual({
      command: 'start',
      demo: true,
      port: 9000,
      open: false,
      config: null,
    });
    expect(parseCli([])).toEqual({ command: 'start', demo: false, port: 8787, open: true, config: null });
    expect(parseCli(['doctor'])).toMatchObject({ command: 'doctor' });
  });

  it('FR-SETUP-02: start --config reads that configuration file', () => {
    expect(parseCli(['start', '--config', 'configs/acme.yaml'])).toEqual({
      command: 'start',
      demo: false,
      port: 8787,
      open: true,
      config: 'configs/acme.yaml',
    });
    expect(() => parseCli(['--config'])).toThrow(/--config needs a value/);
    expect(() => parseCli(['--config', '--no-open'])).toThrow(/--config needs a value/);
    expect(() => parseCli(['--demo', '--config', 'acme.yaml'])).toThrow(/either --demo or --config/);
  });

  it('FR-SETUP-01: rejects unknown commands and invalid ports', () => {
    expect(() => parseCli(['deploy'])).toThrow(/Unknown command/);
    expect(() => parseCli(['--port', '70000'])).toThrow(/port/);
  });

  it('FR-SETUP-01: selects the next free port when the requested one is busy', async () => {
    const blocker = createServer();
    const busy = await new Promise<number>((resolve) =>
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as { port: number }).port)),
    );
    try {
      const port = await findFreePort(busy);
      expect(port).toBeGreaterThan(busy);
    } finally {
      blocker.close();
    }
  });
});

describe('FR-SETUP-02 --config from a subfolder', () => {
  const root = resolve('/home/acme/dcam');
  const sub = join(root, 'configs');

  it('FR-SETUP-02: a relative --config is read from the folder pnpm was started in (INIT_CWD)', () => {
    expect(configFlagPath('acme.yaml', { INIT_CWD: sub }, root)).toBe(join(sub, 'acme.yaml'));
    expect(configFlagPath(join('..', 'acme.yaml'), { INIT_CWD: sub }, root)).toBe(join(root, 'acme.yaml'));
  });

  it('FR-SETUP-02: without INIT_CWD (DCAM started without pnpm) it is read from the working directory', () => {
    expect(configFlagPath('acme.yaml', {}, root)).toBe(join(root, 'acme.yaml'));
    expect(configFlagPath('acme.yaml', { INIT_CWD: '' }, root)).toBe(join(root, 'acme.yaml'));
  });

  it('FR-SETUP-02: absolute and home paths, and no --config, are left as they are', () => {
    const absolute = join(root, 'acme.yaml');
    expect(configFlagPath(absolute, { INIT_CWD: sub }, root)).toBe(absolute);
    expect(configFlagPath('~/acme.yaml', { INIT_CWD: sub }, root)).toBe('~/acme.yaml');
    expect(configFlagPath(null, { INIT_CWD: sub }, root)).toBeNull();
  });
});
