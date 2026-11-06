import { describe, expect, it } from 'vitest';
import { createShutdown, exitWhenFlushed, type FlushableStream } from '../src/index';

/** Records the order of every close, exit and printed line. */
function harness(options: { workspaceFails?: boolean; appFails?: boolean } = {}) {
  const events: string[] = [];
  let finishWorkspace: () => void = () => undefined;
  const deps = {
    app: {
      close: async () => {
        events.push('app.close');
        if (options.appFails) throw new Error('acme app close failed');
      },
    },
    workspace: {
      close: () =>
        new Promise<void>((resolve, reject) => {
          events.push('workspace.close');
          finishWorkspace = () =>
            options.workspaceFails ? reject(new Error('acme store close failed')) : resolve();
        }),
    },
    exit: (code: number) => void events.push(`exit(${code})`),
    log: (line: string) => void events.push(`log: ${line.trim()}`),
    error: (line: string) => void events.push(`error: ${line}`),
  };
  return { events, deps, finishWorkspace: () => finishWorkspace() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('FR-COLL-11 stopping dcam start', () => {
  it('FR-COLL-11: the first signal closes the server, then the workspace, then exits 0', async () => {
    const { events, deps, finishWorkspace } = harness();
    const stop = createShutdown(deps);
    stop('SIGINT');
    await settle();
    expect(events).toEqual([
      'log: SIGINT: stopping DCAM (press Ctrl+C again to exit at once)...',
      'app.close',
      'workspace.close',
    ]);
    finishWorkspace();
    await settle();
    expect(events.at(-1)).toBe('exit(0)');
  });

  it('FR-COLL-11: a second signal while closing exits 130 at once', async () => {
    const { events, deps } = harness();
    const stop = createShutdown(deps);
    stop('SIGINT');
    await settle();
    stop('SIGINT');
    expect(events.at(-1)).toBe('exit(130)');
    expect(events.filter((e) => e.startsWith('exit'))).toEqual(['exit(130)']);
  });

  it('FR-COLL-11: a failing workspace close prints why and exits 1', async () => {
    const { events, deps, finishWorkspace } = harness({ workspaceFails: true });
    createShutdown(deps)('SIGTERM');
    await settle();
    finishWorkspace();
    await settle();
    expect(events.slice(-2)).toEqual(['error: acme store close failed', 'exit(1)']);
  });

  it('FR-COLL-11: a failing server close still closes the workspace', async () => {
    const { events, deps, finishWorkspace } = harness({ appFails: true });
    createShutdown(deps)('SIGTERM');
    await settle();
    finishWorkspace();
    await settle();
    expect(events).toContain('workspace.close');
    expect(events.at(-1)).toBe('exit(0)');
  });
});

describe('FR-AUTH-05 the doctor exits once its report is written', () => {
  /** A stream whose writes complete only when `flush()` is called, like a slow pipe. */
  function slowStream() {
    const pending: Array<() => void> = [];
    const stream: FlushableStream = {
      write: (_chunk, callback) => {
        pending.push(() => callback());
        return false;
      },
    };
    return { stream, flush: () => pending.splice(0).forEach((done) => done()) };
  }

  it('FR-AUTH-05: exits with the code only after stdout and stderr are flushed', async () => {
    const out = slowStream();
    const err = slowStream();
    const exits: number[] = [];
    const done = exitWhenFlushed([out.stream, err.stream], 1, (code) => void exits.push(code));
    await settle();
    expect(exits).toEqual([]);
    out.flush();
    await settle();
    expect(exits).toEqual([]);
    err.flush();
    await done;
    expect(exits).toEqual([1]);
  });

  it('FR-AUTH-05: exits even when a stream never reports the flush', async () => {
    const stuck: FlushableStream = { write: () => false };
    const exits: number[] = [];
    await exitWhenFlushed([stuck], 0, (code) => void exits.push(code), 10);
    expect(exits).toEqual([0]);
  });
});
