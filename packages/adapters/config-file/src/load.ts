/**
 * Loads the workspace configuration (spec §17.1): finds the file (`--config` > `DCAM_CONFIG` >
 * `<cwd>/dcam.config.yaml`), reads its YAML, validates it against the schema and maps it to the
 * {@link WorkspaceConfig} port with precedence built-in defaults < file < environment variables < flags.
 *
 * It never throws for a bad file: every problem comes back as a {@link ConfigIssue} with its path and a fix hint,
 * so the server can stay up in setup mode (FR-SETUP-02). It reads one file and nothing else; credentials are
 * referenced by environment variable name and never read here (FR-SETUP-07).
 *
 * @implements FR-SETUP-02, FR-SETUP-05, FR-AUTH-07
 */
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConfigIssue, EnvironmentEntry, EnvironmentSource, Profile, WorkspaceConfig } from '@dcam/ports';
import { schemaIssues, unusedKeyWarnings } from './issues';
import { resolvePath } from './paths';
import { configFileSchema, type ConfigFile } from './schema';
import { readYaml } from './yaml';

/** The file looked for in the working directory when neither `--config` nor `DCAM_CONFIG` is set. */
export const CONFIG_FILE_NAME = 'dcam.config.yaml';

export interface LoadWorkspaceConfigInput {
  /** `--config <file>`; relative to `cwd`, `~` expanded. */
  readonly flagPath?: string | undefined;
  /** The process environment (`DCAM_CONFIG`, `DCAM_DATA_DIR`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly homeDir: string;
}

export type LoadWorkspaceConfigResult =
  | { readonly ok: true; readonly config: WorkspaceConfig; readonly warnings: readonly ConfigIssue[] }
  | {
      readonly ok: false;
      /** The file that was read; `null` when none was found (contract `Meta.setup.config_path`). */
      readonly configPath: string | null;
      readonly issues: readonly ConfigIssue[];
    };

type Origin = 'flag' | 'env' | 'default';

/** The tier's default profile (FR-SETUP-05): production `standard`, every other tier `eco`. */
export const defaultProfile = (tier: EnvironmentEntry['tier']): Profile =>
  tier === 'prod' ? 'standard' : 'eco';

const nonEmpty = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';

function locate(input: LoadWorkspaceConfigInput): { readonly path: string; readonly origin: Origin } {
  const { flagPath, env, cwd, homeDir } = input;
  if (nonEmpty(flagPath)) return { path: resolvePath(flagPath, cwd, homeDir), origin: 'flag' };
  const fromEnv = env['DCAM_CONFIG'];
  if (nonEmpty(fromEnv)) return { path: resolvePath(fromEnv, cwd, homeDir), origin: 'env' };
  return { path: resolvePath(CONFIG_FILE_NAME, cwd, homeDir), origin: 'default' };
}

const CREATE_HINT =
  'run `cp dcam.config.example.yaml dcam.config.yaml` in the DCAM folder, then set projectId, location and environment. To try DCAM without Google Cloud, run `pnpm dcam --demo`.';

function notFound(path: string, origin: Origin): ConfigIssue {
  const fixHint = {
    default: `To create it, ${CREATE_HINT}`,
    flag: `Check the path given with --config, or leave --config out to use ${CONFIG_FILE_NAME} in the working directory. To create one, ${CREATE_HINT}`,
    env: `Check the DCAM_CONFIG environment variable, or unset it to use ${CONFIG_FILE_NAME} in the working directory. To create one, ${CREATE_HINT}`,
  }[origin];
  return { path: '', message: `No configuration file was found at ${path}.`, fixHint };
}

function unreadable(path: string, code: string | undefined): ConfigIssue {
  const why =
    code === 'EACCES' || code === 'EPERM' ? 'permission denied' : code === 'EISDIR' ? 'it is a folder' : code;
  return {
    path: '',
    message: `The configuration file ${path} could not be read${why === undefined ? '' : ` (${why})`}.`,
    fixHint: 'Check that the path names a file and that your user can read it.',
  };
}

const errorCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined;

function source(entry: ConfigFile['environments'][number]): EnvironmentSource {
  if (entry.airflow !== undefined) {
    const { baseUrl, usernameEnv, passwordEnv, limits } = entry.airflow;
    return {
      kind: 'airflow',
      baseUrl: baseUrl.replace(/\/+$/, ''),
      usernameEnv,
      passwordEnv,
      limits: { ...limits },
    };
  }
  const { projectId, location, environment } = entry;
  // The schema's refinement guarantees all three when there is no airflow block.
  if (projectId === undefined || location === undefined || environment === undefined)
    throw new Error(`environment ${entry.id} has no source after validation`);
  return { kind: 'composer', projectId, location, environment };
}

const cadences = ({
  airflowLive,
  airflowFacts,
  airflowInventory,
  monitoring,
  composer,
}: ConfigFile['profiles']['live']) => ({
  airflowLive,
  airflowFacts,
  airflowInventory,
  monitoring,
  composer,
});

function toWorkspaceConfig(file: ConfigFile, path: string, input: LoadWorkspaceConfigInput): WorkspaceConfig {
  const fileDir = dirname(path);
  const dataDirEnv = input.env['DCAM_DATA_DIR'];
  const { airflowApi, monitoring, composerApi } = file.budgets;
  return {
    path,
    dataDir: nonEmpty(dataDirEnv)
      ? resolvePath(dataDirEnv, input.cwd, input.homeDir)
      : resolvePath(file.workspace.dataDir, fileDir, input.homeDir),
    quotaProjectId: file.auth.quotaProjectId,
    caBundlePath:
      file.network.caBundlePath === null
        ? null
        : resolvePath(file.network.caBundlePath, fileDir, input.homeDir),
    profiles: {
      live: cadences(file.profiles.live),
      standard: cadences(file.profiles.standard),
      eco: cadences(file.profiles.eco),
    },
    budgets: {
      airflowApi: {
        live: airflowApi.live,
        standard: airflowApi.standard,
        eco: airflowApi.eco,
        background: airflowApi.background,
        maxConcurrent: airflowApi.maxConcurrent,
      },
      monitoringPerProjectPerMinute: monitoring.perProjectPerMinute,
      composerApiPerMinute: composerApi.perMinute,
    },
    environments: file.environments.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName ?? entry.id,
      tier: entry.tier,
      profile: entry.profile ?? defaultProfile(entry.tier),
      source: source(entry),
    })),
  };
}

/** Finds, reads and validates the workspace configuration. Never throws for a missing or invalid file. */
export async function loadWorkspaceConfig(
  input: LoadWorkspaceConfigInput,
): Promise<LoadWorkspaceConfigResult> {
  const { path, origin } = locate(input);

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const code = errorCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return { ok: false, configPath: null, issues: [notFound(path, origin)] };
    return { ok: false, configPath: path, issues: [unreadable(path, code)] };
  }

  const yaml = readYaml(text);
  if (!yaml.ok) return { ok: false, configPath: path, issues: yaml.issues };

  const value = withoutEmptyValues(yaml.value);
  const parsed = configFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, configPath: path, issues: schemaIssues(parsed.error, value) };

  return {
    ok: true,
    config: toWorkspaceConfig(parsed.data, path, input),
    warnings: unusedKeyWarnings(value),
  };
}

/**
 * Drops keys with an empty value (`auth:` whose children are all commented out, `caBundlePath:`), so they count
 * as absent and keep their defaults. Items of a list are kept: an empty item is reported where it is.
 */
function withoutEmptyValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmptyValues);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, withoutEmptyValues(v)]),
  );
}
