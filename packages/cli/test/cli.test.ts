import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort, parseCli } from '../src/index';

describe('FR-SETUP-01 start command', () => {
  it('FR-SETUP-01: parses start options with defaults', () => {
    expect(parseCli(['--demo'])).toEqual({ command: 'start', demo: true, port: 8787, open: true });
    expect(parseCli(['start', '--demo', '--port', '9000', '--no-open'])).toEqual({
      command: 'start',
      demo: true,
      port: 9000,
      open: false,
    });
    expect(parseCli(['doctor'])).toMatchObject({ command: 'doctor' });
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
