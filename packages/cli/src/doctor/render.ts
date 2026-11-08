/**
 * `dcam doctor` output: an aligned plain-text table grouped by scope, or one JSON document (`--json`).
 *
 * @implements FR-AUTH-05
 */
import type { DoctorCheck, DoctorReport, DoctorStatus } from '@dcam/application';

/**
 * The `dcam doctor --json` document. The shape is stable: fields are only ever added, and a breaking
 * change raises `schemaVersion`.
 *
 * - `schemaVersion`: `1`.
 * - `dcamVersion`: the DCAM version that ran the checks.
 * - `startedAt`: ISO 8601 UTC; `durationMs`: wall time in milliseconds.
 * - `ok`: `true` when no check failed (the exit code is then 0, else 1).
 * - `summary`: number of checks per status (`pass`, `warn`, `fail`, `skip`).
 * - `checks`: in run order, local checks first, then each environment. Each has `id` (stable, for
 *   example `airflow.role`), `title`, `scope` (`local` or an environment id), `status`, `evidence` (one
 *   line, no secrets), `details` (extra lines), `fixHint` (a command or next step, or `null`), `docsUrl`
 *   (or `null`) and `durationMs`.
 */
export interface DoctorJson {
  readonly schemaVersion: 1;
  readonly dcamVersion: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly summary: Readonly<Record<DoctorStatus, number>>;
  readonly checks: readonly DoctorCheck[];
}

export function doctorJson(report: DoctorReport, dcamVersion: string): DoctorJson {
  return {
    schemaVersion: 1,
    dcamVersion,
    startedAt: new Date(report.startedAt).toISOString(),
    durationMs: report.durationMs,
    ok: report.ok,
    summary: {
      pass: report.summary.pass,
      warn: report.summary.warn,
      fail: report.summary.fail,
      skip: report.summary.skip,
    },
    checks: report.checks.map((c) => ({
      id: c.id,
      title: c.title,
      scope: c.scope,
      status: c.status,
      evidence: c.evidence,
      details: [...c.details],
      fixHint: c.fixHint,
      docsUrl: c.docsUrl,
      durationMs: c.durationMs,
    })),
  };
}

const LABEL: Record<DoctorStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };
const COLOUR: Record<DoctorStatus, string> = { pass: '32', warn: '33', fail: '31', skip: '2' };
const INDENT = ' '.repeat(8);

const paint = (on: boolean, code: string, text: string): string =>
  on ? `\u001b[${code}m${text}\u001b[0m` : text;

function stamp(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function closing(report: DoctorReport): string {
  if (report.summary.fail > 0) return 'Fix the failed checks, then run the doctor again.';
  if (report.summary.warn > 0) return 'No check failed. Review the warnings above.';
  return 'Everything DCAM needs is in place. Start it with pnpm dcam.';
}

export function renderDoctorText(
  report: DoctorReport,
  opts: { readonly color: boolean; readonly version: string },
): string {
  const { color } = opts;
  const width = Math.max(...report.checks.map((c) => c.title.length), 0);
  const scopes: string[] = [];
  for (const c of report.checks) if (!scopes.includes(c.scope)) scopes.push(c.scope);

  const out: string[] = [`DCAM doctor ${opts.version} · ${stamp(report.startedAt)}`];
  for (const scope of scopes) {
    out.push('', paint(color, '1', scope === 'local' ? 'This machine' : `Environment ${scope}`));
    for (const c of report.checks.filter((x) => x.scope === scope)) {
      out.push(
        `  ${paint(color, COLOUR[c.status], LABEL[c.status])}  ${c.title.padEnd(width)}  ${c.evidence}`,
      );
      for (const line of c.details) out.push(`${INDENT}- ${line}`);
      if (c.status === 'warn' || c.status === 'fail') {
        if (c.fixHint) out.push(`${INDENT}Fix:  ${c.fixHint}`);
        if (c.docsUrl) out.push(`${INDENT}Docs: ${c.docsUrl}`);
      }
    }
  }
  const s = report.summary;
  out.push(
    '',
    `${s.pass} passed, ${s.warn} ${s.warn === 1 ? 'warning' : 'warnings'}, ${s.fail} failed, ${s.skip} skipped.`,
    closing(report),
  );
  return `${out.join('\n')}\n`;
}
