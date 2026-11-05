/**
 * `runDoctor`: the preflight checks behind `dcam doctor` and, later, the doctor page (FR-AUTH-05).
 * Local checks run first; then every selected environment runs its checks concurrently, each within its
 * own time limit (30 s by default). A check whose prerequisite did not pass is skipped with the reason.
 * The doctor only reads: it creates no files, and every remote call is a GET through the adapters.
 *
 * @implements FR-AUTH-05, FR-AUTH-02, FR-AUTH-04, FR-AUTH-06, FR-AUTH-07
 */
import { environmentSteps, ENV_TITLES } from './environment-checks';
import { localSteps, newLocalContext } from './local-checks';
import { Outcomes, runSteps } from './steps';
import {
  LOCAL_SCOPE,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorProbes,
  type DoctorReport,
} from './types';

export const DEFAULT_DOCTOR_TIMEOUT_MS = 30_000;

export async function runDoctor(probes: DoctorProbes, opts: DoctorOptions): Promise<DoctorReport> {
  const timeoutMs = opts.perEnvTimeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS;
  const now = opts.now;
  const startedAt = now();
  const envIds = opts.envIds ?? [];

  const local = newLocalContext(probes);
  const localOutcomes = new Outcomes();
  const localChecks = await runSteps(
    LOCAL_SCOPE,
    localSteps(probes, envIds, local, localOutcomes),
    localOutcomes,
    {
      now,
      timeoutMs,
      onTimeout:
        'Run the doctor again; if it hangs here every time, run the same step by hand (for example gcloud --version).',
    },
  );

  const config = local.config;
  const unknown: DoctorCheck[] = local.unknownIds.map((id) => ({
    id: 'env.configured',
    title: ENV_TITLES.configured,
    scope: id,
    status: 'fail',
    evidence: `No environment "${id}" in ${config?.path ?? 'the configuration'}; configured: ${
      config?.environments.map((e) => e.id).join(', ') || 'none'
    }.`,
    details: [],
    fixHint: `Use dcam doctor --env with one of the configured ids, or add "${id}" to the configuration.`,
    docsUrl: null,
    durationMs: 0,
  }));

  const envChecks = config
    ? await Promise.all(
        local.selected.map((entry) => {
          const outcomes = new Outcomes();
          const ctx = {
            probes,
            config,
            proxy: local.proxy,
            adcOk: localOutcomes.status('adc.token') === 'pass',
            now,
          };
          return runSteps(entry.id, environmentSteps(entry, ctx, outcomes), outcomes, {
            now,
            timeoutMs,
            onTimeout: `Check the network path (proxy, VPN, firewall) to ${entry.id}, then run dcam doctor --env ${entry.id} again.`,
          });
        }),
      )
    : [];

  const checks = [...localChecks, ...unknown, ...envChecks.flat()];
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  return { startedAt, durationMs: Math.max(0, now() - startedAt), checks, summary, ok: summary.fail === 0 };
}
