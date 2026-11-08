/**
 * Ending the `dcam` process: Ctrl+C for `dcam start`, and the doctor's exit once its report is out.
 *
 * @implements FR-COLL-11, FR-AUTH-05
 */

export interface ShutdownDeps {
  readonly app: { close(): Promise<unknown> };
  readonly workspace: { close(): Promise<void> };
  readonly exit: (code: number) => void;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/**
 * The signal handler of `dcam start`: stop serving, let running cycles finish and close the database,
 * then exit 0 (1 when closing failed). A second signal exits 130 at once.
 */
export function createShutdown(deps: ShutdownDeps): (signal: NodeJS.Signals) => void {
  let stopping = false;
  return (signal) => {
    if (stopping) {
      deps.exit(130);
      return;
    }
    stopping = true;
    deps.log(`\n${signal}: stopping DCAM (press Ctrl+C again to exit at once)...`);
    void (async () => {
      await deps.app.close().catch(() => undefined);
      await deps.workspace.close();
      deps.exit(0);
    })().catch((error: unknown) => {
      deps.error(error instanceof Error ? error.message : String(error));
      deps.exit(1);
    });
  };
}

/** The part of `process.stdout` and `process.stderr` that {@link exitWhenFlushed} uses. */
export interface FlushableStream {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

/** How long to wait for a stream that never reports its flush. */
const FLUSH_TIMEOUT_MS = 2_000;

/**
 * Exits with `code` once everything written to `streams` has been handed to the operating system. The
 * doctor calls this after printing its report: a graceful close of its HTTP connections waits for
 * requests still in flight (up to 30 s), and a gcloud still running would keep the process open too.
 */
export async function exitWhenFlushed(
  streams: readonly FlushableStream[],
  code: number,
  exit: (code: number) => void,
  timeoutMs = FLUSH_TIMEOUT_MS,
): Promise<void> {
  // Writes complete in order, so an empty write's callback means the earlier output is flushed.
  const flushed = Promise.all(
    streams.map((s) => new Promise<void>((resolve) => s.write('', () => resolve()))),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([flushed, late]);
  clearTimeout(timer);
  exit(code);
}
