import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort, parseCli } from '../src/index';

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
