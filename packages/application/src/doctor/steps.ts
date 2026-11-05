/**
 * Runs the checks of one scope (this machine, or one environment) in order, within a time limit: when
 * the limit passes, the check in progress fails with that evidence and the remaining ones are skipped
 * (FR-AUTH-05: "within 30 seconds per environment"). A probe that throws fails its own check only.
 *
 * @implements FR-AUTH-05
 */
import type { DoctorCheck, DoctorCheckId, DoctorStatus } from './types';
import { errorMessage, evidence, redactSecrets } from './text';

export interface Outcome {
  readonly status: DoctorStatus;
  readonly evidence: string;
  readonly details?: readonly string[];
  readonly fixHint?: string | null;
  readonly docsUrl?: string | null;
}

export interface Step {
  readonly id: DoctorCheckId;
  readonly title: string;
  run(): Promise<Outcome>;
}

export const pass = (text: string, extra: Omit<Outcome, 'status' | 'evidence'> = {}): Outcome => ({
  status: 'pass',
  evidence: text,
  ...extra,
});
export const warn = (text: string, extra: Omit<Outcome, 'status' | 'evidence'> = {}): Outcome => ({
  status: 'warn',
  evidence: text,
  ...extra,
});
export const fail = (text: string, extra: Omit<Outcome, 'status' | 'evidence'> = {}): Outcome => ({
  status: 'fail',
  evidence: text,
  ...extra,
});
export const skip = (text: string): Outcome => ({ status: 'skip', evidence: text });

/** Skip because an earlier check of the same run did not pass. */
export const skipAfter = (title: string): Outcome => skip(`Skipped because "${title}" did not pass.`);

const TIMED_OUT = Symbol('timed out');

/** Records outcomes by check id so later steps can test their prerequisites. */
export class Outcomes {
  readonly #byId = new Map<DoctorCheckId, Outcome>();
  set(id: DoctorCheckId, outcome: Outcome): void {
    this.#byId.set(id, outcome);
  }
  status(id: DoctorCheckId): DoctorStatus | null {
    return this.#byId.get(id)?.status ?? null;
  }
  /** Passed, or passed with a warning. */
  ok(id: DoctorCheckId): boolean {
    const s = this.status(id);
    return s === 'pass' || s === 'warn';
  }
}

export async function runSteps(
  scope: string,
  steps: readonly Step[],
  outcomes: Outcomes,
  opts: { readonly now: () => number; readonly timeoutMs: number; readonly onTimeout: string },
): Promise<DoctorCheck[]> {
  const seconds = Math.round(opts.timeoutMs / 1000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(TIMED_OUT);
    }, opts.timeoutMs);
  });
  const checks: DoctorCheck[] = [];
  try {
    for (const step of steps) {
      const started = opts.now();
      let outcome: Outcome;
      if (expired) {
        outcome = skip(`Skipped: the ${seconds} s time limit had passed.`);
      } else {
        const result = await Promise.race([guarded(step), deadline]);
        outcome =
          result === TIMED_OUT
            ? fail(`No answer within ${seconds} s, the doctor's time limit; later checks were skipped.`, {
                fixHint: opts.onTimeout,
              })
            : result;
      }
      outcomes.set(step.id, outcome);
      checks.push({
        id: step.id,
        title: step.title,
        scope,
        status: outcome.status,
        evidence: evidence(outcome.evidence),
        details: (outcome.details ?? []).map(evidence),
        // Adapters may supply their own hint; it is shown to the user, so it is redacted as well.
        fixHint: outcome.fixHint ? redactSecrets(outcome.fixHint) : null,
        docsUrl: outcome.docsUrl ?? null,
        durationMs: Math.max(0, opts.now() - started),
      });
    }
  } finally {
    clearTimeout(timer);
  }
  return checks;
}

/** A probe that throws something unexpected fails its own check; it never rejects. */
async function guarded(step: Step): Promise<Outcome> {
  try {
    return await step.run();
  } catch (error) {
    return fail(errorMessage(error));
  }
}
