/**
 * `dcam` command line (spec §17.4).
 *
 * @implements FR-SETUP-01, FR-SETUP-02, FR-EMU-01
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollectionLogEntry } from '@dcam/application';
import { buildApp, createDemoWorkspace, openConfiguredWorkspace, type Workspace } from '@dcam/server';
import { DOCTOR_USAGE, parseDoctorArgs, type DoctorCliOptions } from './doctor/command';
import { createShutdown } from './shutdown';

export interface StartOptions {
  readonly command: 'start';
  readonly demo: boolean;
  readonly port: number;
  readonly open: boolean;
  /** `--config`; `null` lets the configuration adapter apply `DCAM_CONFIG` and the default path. */
  readonly config: string | null;
}

export type CliOptions = StartOptions | DoctorCliOptions | { command: 'help' };

export const VERSION = '0.0.0';
const HOST = '127.0.0.1';

export const USAGE = `Usage: dcam [start] [--config <path> | --demo] [--port <n>] [--no-open]
       ${DOCTOR_USAGE}

  start      Start DCAM on http://127.0.0.1:<port> (default 8787); it reads the configured
             environments, read-only
  --config   Configuration file (default: DCAM_CONFIG, else dcam.config.yaml)
  --demo     Use the synthetic demo workspace (no Google Cloud access)
  doctor     Check credentials, quota project, proxy, Composer and Airflow access
  --env      Check only this environment id (repeatable)
  --json     Print the results as JSON (schemaVersion 1); exit code 1 when a check fails`;

export function parseCli(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const first = args[0];
  let command = 'start';
  if (first && !first.startsWith('-')) command = args.shift() as string;
  if (command === 'help' || args.includes('--help') || args.includes('-h')) return { command: 'help' };
  if (command === 'doctor') return parseDoctorArgs(args, USAGE);
  if (command !== 'start') throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  let demo = false;
  let open = true;
  let port = 8787;
  let config: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--demo') demo = true;
    else if (a === '--no-open') open = false;
    else if (a === '--config') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`--config needs a value.\n\n${USAGE}`);
      config = value;
    } else if (a === '--port') {
      port = Number(args[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error('--port must be a number from 1 to 65535.');
    } else throw new Error(`Unknown option "${a}".\n\n${USAGE}`);
  }
  if (demo && config !== null)
    throw new Error('Use either --demo or --config: the demo workspace reads no configuration file.');
  return { command: 'start', demo, port, open, config };
}

/**
 * A relative `--config` as the user meant it: against the folder they ran the command in. `pnpm dcam`
 * runs the script in the repository root, and pnpm passes the folder it was started in as `INIT_CWD`
 * (checked with pnpm 11.28.0 on macOS: `INIT_CWD` is the invoking subfolder while the working directory
 * is the package root; npm documents the same variable for `npm run`,
 * https://docs.npmjs.com/cli/v11/using-npm/scripts#current-working-directory). ⚠️ VERIFY on Windows.
 * Without `INIT_CWD` (DCAM started directly) the working directory is used. Absolute and `~` paths and
 * `null` (no `--config`) are returned unchanged; the configuration adapter expands `~`.
 */
export function configFlagPath(
  flag: string | null,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string | null {
  if (flag === null || isAbsolute(flag) || flag === '~' || flag.startsWith('~/') || flag.startsWith('~\\'))
    return flag;
  return resolve(env['INIT_CWD']?.trim() || cwd, flag);
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

/** Collection messages on the terminal: warnings and errors, and everything with `DCAM_LOG=info`. */
function printLog(entry: CollectionLogEntry): void {
  if (entry.level === 'info' && process.env['DCAM_LOG'] !== 'info') return;
  const where = [entry.envId, entry.collectorId].filter(Boolean).join(' ');
  const line = `${new Date().toISOString()} ${entry.level}${where ? ` [${where}]` : ''} ${entry.message}`;
  if (entry.level === 'info') console.log(line);
  else console.error(line);
}

async function listen(workspace: Workspace, requested: number) {
  const port = await findFreePort(requested);
  if (port !== requested) console.log(`Port ${requested} is busy; using ${port} instead.`);
  const app = await buildApp({
    ...workspace,
    version: VERSION,
    allowedHosts: [`${HOST}:${port}`, `localhost:${port}`],
    staticDir: webDist,
  });
  await app.listen({ host: HOST, port });
  const host = `${HOST}:${port}`;
  // Warm the cached aggregated views so the first page load is fast; best effort, in the background.
  const warm = () =>
    void Promise.all(
      ['/api/v1/fleet', ...workspace.environments.map((e) => `/api/v1/environments/${e.env_id}/dags`)].map(
        (path) => app.inject({ method: 'GET', url: path, headers: { host } }),
      ),
    ).catch(() => undefined);
  return { app, url: `http://${host}`, warm };
}

export async function start(options: StartOptions): Promise<void> {
  if (options.demo) return startDemo(options);
  const { workspace, warnings } = await openConfiguredWorkspace({
    configPath: configFlagPath(options.config, process.env, process.cwd()) ?? undefined,
    env: process.env,
    cwd: process.cwd(),
    homeDir: homedir(),
    log: printLog,
  });
  for (const w of warnings) console.warn(`Warning: ${w.path ? `${w.path}: ` : ''}${w.message} ${w.fixHint}`);
  let server: Awaited<ReturnType<typeof listen>>;
  try {
    server = await listen(workspace, options.port);
  } catch (error) {
    await workspace.close();
    throw error;
  }
  const { app, url } = server;
  workspace.start();

  // Ctrl+C: stop collecting, let running cycles finish, close the database. A second Ctrl+C exits now.
  const stop = createShutdown({
    app,
    workspace,
    exit: (code) => process.exit(code),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (workspace.setup) {
    const { configPath, issues } = workspace.setup;
    console.log(
      `DCAM ${VERSION} is running in setup mode at ${url}\n` +
        `The configuration (${configPath ?? 'no file found'}) needs attention. ` +
        'Fix the issues below (the page shows them too), then restart DCAM.',
    );
    for (const issue of issues)
      console.log(`  - ${issue.path ? `${issue.path}: ` : ''}${issue.message} ${issue.fixHint}`);
    console.log('Press Ctrl+C to stop.');
  } else {
    server.warm();
    const n = workspace.environments.length;
    console.log(
      `DCAM ${VERSION} is reading ${n} environment${n === 1 ? '' : 's'}, read-only, at ${url}\n` +
        'If a page says collection is failing, run "pnpm dcam doctor" in another terminal.\n' +
        'Press Ctrl+C to stop.',
    );
  }
  if (options.open) openBrowser(url);
}

async function startDemo(options: StartOptions): Promise<void> {
  const fakeNow = process.env['DCAM_FAKE_NOW'] ? Date.parse(process.env['DCAM_FAKE_NOW']) : undefined;
  const workspace = await createDemoWorkspace(fakeNow === undefined ? {} : { now: () => fakeNow });
  const { url, warm } = await listen(workspace, options.port);
  warm();
  console.log(`DCAM ${VERSION} (demo data) is running at ${url}\nPress Ctrl+C to stop.`);
  if (options.open) openBrowser(url);
}
