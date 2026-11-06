/**
 * Checks of this machine: Node.js, DuckDB, the configuration, the data directory, proxy and CA
 * settings, the Google Cloud CLI and Application Default Credentials (FR-AUTH-05 subset of feature 002).
 *
 * @implements FR-AUTH-05, FR-AUTH-02, FR-AUTH-07, FR-SETUP-02
 */
import { SourceError, type EnvironmentEntry, type WorkspaceConfig } from '@dcam/ports';
import { DOCTOR_DOCS } from './docs';
import { fail, pass, skip, skipAfter, warn, type Outcome, type Outcomes, type Step } from './steps';
import { errorMessage, plural, shellQuote } from './text';
import type { DataDirFacts, DoctorProbes, DoctorProxySettings, DoctorProxyVariable } from './types';

const GIB = 2 ** 30;
/** Below this, DCAM cannot keep its default retention (§17.2 `retention.diskBudgetGb: 5`). */
const WARN_FREE_BYTES = 5 * GIB;
const FAIL_FREE_BYTES = 1 * GIB;

/** What the local checks learn that the environment checks need. */
export interface LocalContext {
  config: WorkspaceConfig | null;
  /** Environments to check, in configuration order. */
  selected: EnvironmentEntry[];
  /** `--env` ids that are not in the configuration. */
  unknownIds: string[];
  /**
   * Why no Google token may be requested (`DCAM_NETWORK=loopback-only`); the Google checks skip with
   * this reason. `null` when tokens may be requested.
   */
  googleRefused: string | null;
}

export const TITLES = {
  node: 'Node.js 22.12 or later',
  duckdb: 'DuckDB loads',
  config: 'Configuration is valid',
  dataWritable: 'Data directory is writable',
  dataPermissions: 'Data directory is owner-only',
  dataFree: 'Free disk space',
  proxy: 'Proxy settings',
  ca: 'Extra CA certificates',
  gcloud: 'Google Cloud CLI installed',
  adc: 'Application Default Credentials',
} as const;

export function newLocalContext(): LocalContext {
  return { config: null, selected: [], unknownIds: [], googleRefused: null };
}

const hasComposer = (ctx: LocalContext): boolean =>
  ctx.config === null || ctx.selected.some((e) => e.source.kind === 'composer');

export function localSteps(
  probes: DoctorProbes,
  envIds: readonly string[],
  ctx: LocalContext,
  outcomes: Outcomes,
): Step[] {
  let dataDir: DataDirFacts | null = null;
  const facts = async (): Promise<DataDirFacts> =>
    (dataDir ??= await probes.dataDir(ctx.config?.dataDir ?? probes.defaultDataDir));

  return [
    { id: 'node.version', title: TITLES.node, run: async () => nodeVersion(probes.nodeVersion) },
    {
      id: 'duckdb.load',
      title: TITLES.duckdb,
      run: async () => {
        try {
          await probes.loadDuckDb();
          return pass('The DuckDB native binary loads (in-memory database opened and closed).');
        } catch (error) {
          return fail(`DuckDB did not load: ${errorMessage(error)}`, {
            fixHint:
              'Run pnpm install again; DuckDB 2.0 needs a prebuilt binary for this operating system and CPU.',
            docsUrl: DOCTOR_DOCS.duckdbNode,
          });
        }
      },
    },
    { id: 'config.valid', title: TITLES.config, run: () => configCheck(probes, envIds, ctx) },
    { id: 'data-dir.writable', title: TITLES.dataWritable, run: async () => writable(await facts()) },
    {
      id: 'data-dir.permissions',
      title: TITLES.dataPermissions,
      run: async () => permissions(await facts(), probes.platform),
    },
    { id: 'data-dir.free-space', title: TITLES.dataFree, run: async () => freeSpace(await facts()) },
    { id: 'network.proxy', title: TITLES.proxy, run: async () => proxyCheck(probes) },
    { id: 'network.ca-bundle', title: TITLES.ca, run: () => caBundles(probes, ctx) },
    {
      id: 'gcloud.installed',
      title: TITLES.gcloud,
      run: async () => {
        const version = await probes.gcloudVersion();
        if (version) return pass(version);
        const needed = hasComposer(ctx);
        const text = needed
          ? 'gcloud was not found on PATH; DCAM gets Google credentials through it.'
          : 'gcloud was not found on PATH; only needed for Composer environments.';
        const extra = { fixHint: installHint(probes.platform), docsUrl: DOCTOR_DOCS.gcloudInstall };
        return needed ? fail(text, extra) : warn(text, extra);
      },
    },
    {
      id: 'adc.token',
      title: TITLES.adc,
      run: async () => {
        if (outcomes.status('gcloud.installed') !== 'pass') return skipAfter(TITLES.gcloud);
        if (!hasComposer(ctx)) return skip('No Composer environment is selected.');
        const override = probes.env['GOOGLE_APPLICATION_CREDENTIALS']
          ? ' (GOOGLE_APPLICATION_CREDENTIALS is set)'
          : '';
        try {
          const token = await probes.tokens.accessToken();
          if (!token) throw new Error('gcloud returned an empty token.');
          return pass(`gcloud issued an access token for Application Default Credentials${override}.`);
        } catch (error) {
          // DCAM_NETWORK=loopback-only: the token source refuses before starting gcloud (spec §21.4).
          if (error instanceof SourceError && error.kind === 'guard') {
            ctx.googleRefused = error.message;
            return skip(`Skipped: ${error.message}.`);
          }
          return fail(`No access token${override}: ${errorMessage(error)}`, {
            fixHint: 'gcloud auth application-default login',
            docsUrl: DOCTOR_DOCS.adcLogin,
          });
        }
      },
    },
  ];
}

export function nodeVersion(version: string): Outcome {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  if (major > 22 || (major === 22 && minor >= 12)) return pass(`Node.js ${version}`);
  return fail(`Node.js ${version} is older than 22.12.`, {
    fixHint: 'Install Node.js 22.12 or later (the version in .nvmrc), then run pnpm install again.',
    docsUrl: DOCTOR_DOCS.nodeDownload,
  });
}

async function configCheck(
  probes: DoctorProbes,
  envIds: readonly string[],
  ctx: LocalContext,
): Promise<Outcome> {
  const result = await probes.loadConfig();
  if (result.kind === 'missing') {
    return fail(`No configuration file at ${result.path}.`, {
      fixHint: 'cp dcam.config.example.yaml dcam.config.yaml, then set projectId, location and environment.',
    });
  }
  if (result.kind === 'invalid') {
    return fail(`${plural(result.issues.length, 'problem')} in ${result.path}.`, {
      details: result.issues.map((i) => `${i.path || '(file)'}: ${i.message}. Fix: ${i.fixHint}`),
      fixHint: `Correct the listed fields in ${result.path}, then run the doctor again.`,
    });
  }
  const config = result.config;
  ctx.config = config;
  const ids = new Set(envIds);
  ctx.selected = ids.size === 0 ? [...config.environments] : config.environments.filter((e) => ids.has(e.id));
  ctx.unknownIds = [...ids].filter((id) => !config.environments.some((e) => e.id === id));
  if (config.environments.length === 0) {
    return warn(`${config.path} lists no environments.`, {
      fixHint: `Add an environment under environments: in ${config.path} (see dcam.config.example.yaml).`,
    });
  }
  const names = config.environments.map((e) => e.id).join(', ');
  return pass(`${config.path}: ${plural(config.environments.length, 'environment')} (${names}).`);
}

function writable(f: DataDirFacts): Outcome {
  if (f.state === 'not-a-directory') {
    return fail(`${f.path} exists but is not a directory.`, {
      fixHint: 'Set DCAM_DATA_DIR or workspace.dataDir to a directory.',
    });
  }
  if (!f.writable) {
    return fail(`${f.path} is not writable by this user.`, {
      fixHint: 'Fix the owner of the directory, or set DCAM_DATA_DIR to a directory you own.',
    });
  }
  return f.state === 'missing'
    ? pass(`${f.path} does not exist yet; DCAM creates it owner-only on first start.`)
    : pass(`${f.path} is writable.`);
}

function permissions(f: DataDirFacts, platform: string): Outcome {
  if (platform === 'win32') return skip('Windows controls access with ACLs; not checked.');
  if (f.state !== 'directory')
    return skip('The directory does not exist yet; DCAM creates it with mode 0700.');
  if (f.mode === null) return skip('The permission bits could not be read.');
  const mode = (f.mode & 0o777).toString(8).padStart(4, '0');
  if ((f.mode & 0o077) === 0) return pass(`Mode ${mode}: only you can read it.`);
  return warn(`Mode ${mode}: other users on this machine can read DCAM's data.`, {
    fixHint: `chmod 700 ${shellQuote(f.path)}`,
  });
}

function freeSpace(f: DataDirFacts): Outcome {
  if (f.freeBytes === null) return skip('Free space could not be read.');
  const gib = (f.freeBytes / GIB).toFixed(1);
  const text = `${gib} GiB free on the volume of ${f.path} (DCAM's default disk budget is 5 GB).`;
  const extra = {
    fixHint: 'Free disk space, or set DCAM_DATA_DIR to a volume with at least 5 GiB free.',
  };
  if (f.freeBytes < FAIL_FREE_BYTES) return fail(text, extra);
  if (f.freeBytes < WARN_FREE_BYTES) return warn(text, extra);
  return pass(text);
}

const shownProxy = (v: DoctorProxyVariable): string =>
  `${v.variable}=${v.url}${v.schemeAdded ? ' (no scheme given, so http:// is used)' : ''}`;

/**
 * The proxy variables as the transport itself reads them (http-guard, through the probe), so the evidence
 * never disagrees with what DCAM sends. Loopback targets such as the emulator always bypass a remote
 * proxy, so they need no NO_PROXY entry.
 */
function proxyCheck(probes: DoctorProbes): Outcome {
  const docsUrl = DOCTOR_DOCS.gcloudProxy;
  let settings: DoctorProxySettings;
  try {
    settings = probes.proxySettings();
  } catch (error) {
    return fail(`DCAM cannot use the proxy settings: ${errorMessage(error)}`, {
      fixHint:
        'Correct the variable named above (HTTPS_PROXY, HTTP_PROXY or DCAM_NETWORK) in the shell that starts DCAM, then run the doctor again. A proxy is http://host:port; credentials go in the URL, URL-encoded.',
      docsUrl,
    });
  }
  const { https, http, noProxy, dropped, shadowed } = settings;
  const used = [https, http].filter((v) => v !== null);
  const parts = [
    ...used.map(shownProxy),
    ...(noProxy && used.length > 0 ? [`${noProxy.variable}=${noProxy.value}`] : []),
  ];
  const notUsed = dropped.map(
    (v) => `${shownProxy(v)} is not used: DCAM_NETWORK=loopback-only keeps every connection on this machine`,
  );
  if (parts.length === 0 && notUsed.length === 0)
    return pass('No proxy variables are set: connections are direct.');
  const shown = [parts.join(', '), ...notUsed].filter((t) => t !== '').join('. ');
  if (shadowed.length > 0) {
    const conflicts = shadowed.map((s) => `${s.used} and ${s.ignored} differ, and ${s.used} is used`);
    return warn(`${shown}. ${conflicts.join('; ')}.`, {
      fixHint: 'Set the lower- and upper-case variables to the same value, or unset one of them.',
      docsUrl,
    });
  }
  return pass(`${shown}.`);
}

async function caBundles(probes: DoctorProbes, ctx: LocalContext): Promise<Outcome> {
  const sources: Array<[string, string]> = [];
  const extra = probes.env['NODE_EXTRA_CA_CERTS'];
  if (extra) sources.push(['NODE_EXTRA_CA_CERTS', extra]);
  if (ctx.config?.caBundlePath) sources.push(['network.caBundlePath', ctx.config.caBundlePath]);
  if (sources.length === 0) {
    return pass(
      "No extra CA bundle: Node.js's built-in root certificates apply. Behind a TLS-inspecting proxy, set NODE_EXTRA_CA_CERTS.",
    );
  }
  const found: string[] = [];
  for (const [name, path] of sources) {
    const docs = { docsUrl: DOCTOR_DOCS.nodeExtraCaCerts };
    // Node.js reads NODE_EXTRA_CA_CERTS only at start-up and ignores a missing or malformed file after
    // one warning (Node.js CLI docs), so a bad path would otherwise go unnoticed until TLS fails.
    let text: string;
    try {
      text = await probes.readTextFile(path);
    } catch (error) {
      return fail(`${name} ${path} cannot be read: ${errorMessage(error)}`, {
        fixHint: `Point ${name} to a readable PEM file with your corporate root CA, then start DCAM again.`,
        ...docs,
      });
    }
    const count = text.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
    if (count === 0) {
      return fail(`${name} ${path} has no PEM certificate.`, {
        fixHint: `Export the corporate root CA as PEM (-----BEGIN CERTIFICATE-----) and point ${name} to it.`,
        ...docs,
      });
    }
    found.push(`${name}: ${plural(count, 'certificate')} in ${path}`);
  }
  return pass(`${found.join('; ')}.`);
}

/** FR-AUTH-02: installation steps for the user's operating system. */
function installHint(platform: string): string {
  const url = DOCTOR_DOCS.gcloudInstall;
  if (platform === 'darwin')
    return `Install the Google Cloud CLI for macOS (${url}), then open a new terminal and run the doctor again.`;
  if (platform === 'win32')
    return `Install the Google Cloud CLI for Windows with its installer (${url}), then open a new terminal and run the doctor again.`;
  return `Install the Google Cloud CLI for Linux (${url}), then open a new terminal and run the doctor again.`;
}
