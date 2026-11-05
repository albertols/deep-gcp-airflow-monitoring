/**
 * `dcam doctor [--config <path>] [--env <id>]… [--json]` (spec §17.4): runs the preflight checks and
 * exits with 0 when nothing failed, 1 otherwise.
 *
 * @implements FR-AUTH-05
 */
import { runDoctor, type DoctorProbes } from '@dcam/application';
import { doctorJson, renderDoctorText } from './render';

export interface DoctorCliOptions {
  readonly command: 'doctor';
  /** `--config`; `null` lets the configuration adapter apply `DCAM_CONFIG` and the default path. */
  readonly config: string | null;
  /** `--env`, repeatable; empty checks every configured environment. */
  readonly envIds: string[];
  readonly json: boolean;
}

export const DOCTOR_USAGE = `dcam doctor [--config <path>] [--env <id>]... [--json]`;

/** Parses the arguments after `doctor`. */
export function parseDoctorArgs(args: readonly string[], usage: string): DoctorCliOptions {
  let config: string | null = null;
  const envIds: string[] = [];
  let json = false;
  const value = (i: number, flag: string): string => {
    const v = args[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.\n\n${usage}`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--config') config = value(++i, '--config');
    else if (a === '--env') envIds.push(value(++i, '--env'));
    else throw new Error(`Unknown option "${a}".\n\n${usage}`);
  }
  return { command: 'doctor', config, envIds, json };
}

export interface DoctorCommandDeps {
  /** Builds the probes for the `--config` path (`createDoctorProbes` with the wired adapters). */
  readonly probes: (configPath: string | null) => DoctorProbes;
  readonly stdout: { write(text: string): unknown; readonly isTTY?: boolean };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  readonly now?: () => number;
  readonly perEnvTimeoutMs?: number;
}

/**
 * Colour only on a terminal, and never when `NO_COLOR` is set to a non-empty value
 * (https://no-color.org: "when present and not an empty string").
 */
export function useColour(
  stdout: { readonly isTTY?: boolean },
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return stdout.isTTY === true && !env['NO_COLOR'];
}

export async function runDoctorCommand(options: DoctorCliOptions, deps: DoctorCommandDeps): Promise<number> {
  const report = await runDoctor(deps.probes(options.config), {
    envIds: options.envIds,
    perEnvTimeoutMs: deps.perEnvTimeoutMs,
    now: deps.now ?? Date.now,
  });
  deps.stdout.write(
    options.json
      ? `${JSON.stringify(doctorJson(report, deps.version), null, 2)}\n`
      : renderDoctorText(report, { color: useColour(deps.stdout, deps.env), version: deps.version }),
  );
  return report.ok ? 0 : 1;
}
