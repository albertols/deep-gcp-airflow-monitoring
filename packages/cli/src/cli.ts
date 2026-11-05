/**
 * `dcam` command line (spec §17.4).
 *
 * @implements FR-SETUP-01, FR-EMU-01
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, createDemoWorkspace } from '@dcam/server';

export type CliOptions =
  | { command: 'start'; demo: boolean; port: number; open: boolean }
  | { command: 'doctor' }
  | { command: 'help' };

export const VERSION = '0.0.0';
const HOST = '127.0.0.1';

export const USAGE = `Usage: dcam [start] [--demo] [--port <n>] [--no-open]
       dcam doctor

  start      Start DCAM on http://127.0.0.1:<port> (default 8787)
  --demo     Use the synthetic demo workspace (no Google Cloud access)
  doctor     Check prerequisites (Google Cloud checks arrive in M1)`;

export function parseCli(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const first = args[0];
  let command = 'start';
  if (first && !first.startsWith('-')) command = args.shift() as string;
  if (command === 'help' || args.includes('--help') || args.includes('-h')) return { command: 'help' };
  if (command === 'doctor') return { command: 'doctor' };
  if (command !== 'start') throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  let demo = false;
  let open = true;
  let port = 8787;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--demo') demo = true;
    else if (a === '--no-open') open = false;
    else if (a === '--port') {
      port = Number(args[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error('--port must be a number from 1 to 65535.');
    } else throw new Error(`Unknown option "${a}".\n\n${USAGE}`);
  }
  return { command: 'start', demo, port, open };
}

function isFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, HOST, () => probe.close(() => done(true)));
  });
}

/** FR-SETUP-01: the requested port, or the next free one. */
export async function findFreePort(start: number, attempts = 20): Promise<number> {
  for (let port = start; port < start + attempts && port <= 65_535; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port between ${start} and ${start + attempts - 1}. Start DCAM with --port <n>.`);
}

/** Opens the URL in the default browser with fixed arguments and no shell. */
function openBrowser(url: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => undefined);
  child.unref();
}

const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/web/dist');

export async function start(options: Extract<CliOptions, { command: 'start' }>): Promise<void> {
  if (!options.demo) {
    throw new Error(
      'Live mode (your own environments) arrives in milestone M1. For now, run "pnpm dcam --demo" to explore the demo workspace.',
    );
  }
  const port = await findFreePort(options.port);
  if (port !== options.port) console.log(`Port ${options.port} is busy; using ${port} instead.`);
  const fakeNow = process.env['DCAM_FAKE_NOW'] ? Date.parse(process.env['DCAM_FAKE_NOW']) : undefined;
  const workspace = await createDemoWorkspace(fakeNow === undefined ? {} : { now: () => fakeNow });
  const app = await buildApp({
    ...workspace,
    version: VERSION,
    allowedHosts: [`${HOST}:${port}`, `localhost:${port}`],
    staticDir: webDist,
  });
  await app.listen({ host: HOST, port });
  const url = `http://${HOST}:${port}`;
  console.log(`DCAM ${VERSION} (demo data) is running at ${url}\nPress Ctrl+C to stop.`);
  if (options.open) openBrowser(url);
}

export async function doctor(): Promise<boolean> {
  const checks: Array<[string, boolean, string]> = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  checks.push([
    'Node.js 22.12 or later',
    major > 22 || (major === 22 && minor >= 12),
    `found ${process.versions.node}; install Node.js 22.12 or later`,
  ]);
  try {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(':memory:');
    instance.closeSync();
    checks.push(['DuckDB native binary loads', true, '']);
  } catch (error) {
    checks.push([
      'DuckDB native binary loads',
      false,
      `${(error as Error).message}; see ADR-0005 for supported platforms`,
    ]);
  }
  for (const [name, ok, fix] of checks)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (${fix})`}`);
  console.log('INFO  Google Cloud checks (credentials, IAM, Airflow access, proxy) arrive in milestone M1.');
  return checks.every(([, ok]) => ok);
}
