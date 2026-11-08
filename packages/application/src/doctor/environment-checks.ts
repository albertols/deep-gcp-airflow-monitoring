/**
 * Checks of one environment (FR-AUTH-05 subset of feature 002): Composer `environments.get` (which also
 * proves the quota project, FR-AUTH-04, and classifies VPC Service Controls denials, FR-AUTH-06), the
 * Composer generation and Airflow version (FR-COLL-08, FR-COLL-09), the Airflow web server through the
 * proxy (FR-AUTH-07), the Airflow role (§18.3), one small Monitoring read and the clock.
 *
 * @implements FR-AUTH-05, FR-AUTH-04, FR-AUTH-06, FR-AUTH-07, FR-COLL-08, FR-COLL-09
 */
import {
  SourceError,
  type AirflowApi,
  type ComposerEnvironment,
  type EnvironmentEntry,
  type MetricQuery,
  type WorkspaceConfig,
} from '@dcam/ports';
import { DOCTOR_DOCS } from './docs';
import { fail, pass, skip, skipAfter, warn, type Outcome, type Outcomes, type Step } from './steps';
import { errorMessage, plural } from './text';
import type { DoctorEnvironmentProbes, DoctorProbes } from './types';

export const ENV_TITLES = {
  configured: 'Environment is configured',
  composer: 'Composer API: environment readable',
  version: 'Composer and Airflow versions supported',
  health: 'Airflow web server reachable',
  role: 'Airflow role',
  monitoring: 'Cloud Monitoring readable',
  clock: 'Clock skew',
} as const;

const COMPOSER_API = 'https://composer.googleapis.com/v1';
/**
 * `environment/healthy` (GAUGE, BOOL) is sampled every 300 s and visible after up to 120 s (Appendix A.2).
 * `ALIGN_FRACTION_TRUE` "is valid for GAUGE metrics with Boolean values", and the alignment period "must
 * be at least 60 seconds" (Monitoring API v3 `Aggregation`,
 * https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies, read 2026-11-05).
 */
const MONITORING_WINDOW_MS = 20 * 60_000;
const CLOCK_WARN_MS = 60_000;
const CLOCK_FAIL_MS = 5 * 60_000;
const UNREACHABLE = new Set(['network', 'timeout']);

export interface EnvironmentContext {
  readonly probes: DoctorProbes;
  readonly config: WorkspaceConfig;
  /** The local ADC check passed: Google API calls can carry a token. */
  readonly adcOk: boolean;
  /** Why no Google token may be requested (`DCAM_NETWORK=loopback-only`), or `null`. */
  readonly googleRefused: string | null;
  readonly now: () => number;
}

type ComposerSource = Extract<EnvironmentEntry['source'], { kind: 'composer' }>;

const stripSlash = (url: string): string => url.replace(/\/+$/, '');
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
/**
 * ` (through proxy host:port)` when the transport sends `url` through a proxy, else an empty string.
 * Settings the transport cannot use are reported by the proxy check, so here they only drop the note.
 */
function viaProxy(probes: DoctorProbes, url: string): string {
  try {
    const route = probes.proxyRoute(url);
    return route.via === 'proxy' ? ` (through proxy ${route.proxy})` : '';
  } catch {
    return '';
  }
}

const composerUrl = (s: ComposerSource): string =>
  `${COMPOSER_API}/projects/${s.projectId}/locations/${s.location}/environments/${s.environment}`;

export function environmentSteps(
  entry: EnvironmentEntry,
  ctx: EnvironmentContext,
  outcomes: Outcomes,
): Step[] {
  let sources: DoctorEnvironmentProbes | null = null;
  const probes = (): DoctorEnvironmentProbes => (sources ??= ctx.probes.environment(entry, ctx.config));
  const state = {
    composer: null as ComposerEnvironment | null,
    /** Airflow 3 or older than 2: the Airflow REST API v1 checks do not apply. */
    unsupported: false,
    /** The host the clock check reads failed before an HTTP answer. */
    unreachable: false,
  };
  const airflowBase = (): string | null =>
    entry.source.kind === 'airflow' ? entry.source.baseUrl : (state.composer?.airflowUri ?? null);
  const airflow = (): AirflowApi => {
    const base = airflowBase();
    if (base === null) throw new Error('The Airflow web server URL is unknown.');
    return probes().airflow(base);
  };
  const quota = (s: ComposerSource) =>
    ctx.config.quotaProjectId === null
      ? { project: s.projectId, source: "the environment's project" }
      : { project: ctx.config.quotaProjectId, source: 'auth.quotaProjectId' };

  const composerStep: Step = {
    id: 'composer.environment',
    title: ENV_TITLES.composer,
    run: async () => {
      const s = entry.source;
      if (s.kind !== 'composer') return skip('Self-managed Airflow: no Composer API.');
      if (ctx.googleRefused !== null) return skip(`Skipped: ${ctx.googleRefused}.`);
      if (!ctx.adcOk) return skipAfter('Application Default Credentials');
      const api = probes().composer;
      if (!api) return fail('No Composer API client is configured for this environment.');
      const q = quota(s);
      const via = viaProxy(ctx.probes, composerUrl(s));
      try {
        const env = await api.environment(s);
        state.composer = env;
        const text = `State ${env.state}, image ${env.imageVersion ?? 'unknown'}, quota project ${q.project}${via}.`;
        if (env.state === 'RUNNING') return pass(text);
        return warn(`${text} Collection may be incomplete until it is RUNNING.`, {
          fixHint: 'Wait until the environment is RUNNING, then run the doctor again.',
        });
      } catch (error) {
        if (error instanceof SourceError && UNREACHABLE.has(error.kind)) state.unreachable = true;
        return googleFailure(error, {
          service: 'composer.googleapis.com',
          projectId: s.projectId,
          quotaProject: q.project,
          quotaSource: q.source,
          via,
          forbiddenRole: 'roles/composer.viewer',
          forbiddenDocs: DOCTOR_DOCS.composerIam,
          notFound: `Check projectId, location and environment of ${entry.id} in ${ctx.config.path}.`,
        });
      }
    },
  };

  const composerVersionStep: Step = {
    id: 'airflow.version',
    title: ENV_TITLES.version,
    run: async () => {
      if (!state.composer) return skipAfter(ENV_TITLES.composer);
      const outcome = imageVersion(state.composer.imageVersion);
      if (outcome.status === 'fail') state.unsupported = true;
      return outcome;
    },
  };

  const airflowVersionStep: Step = {
    id: 'airflow.version',
    title: ENV_TITLES.version,
    run: async () => {
      if (!outcomes.ok('airflow.health')) return skipAfter(ENV_TITLES.health);
      const { version } = await airflow().version();
      const outcome = airflowVersion(version, `Airflow ${version} (GET /api/v1/version).`);
      if (outcome.status === 'fail') state.unsupported = true;
      return outcome;
    },
  };

  const healthStep: Step = {
    id: 'airflow.health',
    title: ENV_TITLES.health,
    run: async () => {
      if (entry.source.kind === 'composer') {
        if (!state.composer) return skipAfter(ENV_TITLES.composer);
        if (state.unsupported) return skip('Skipped: DCAM reads only Airflow 2 in this release.');
        if (!state.composer.airflowUri)
          return skip(`Skipped: Composer reported no airflowUri (state ${state.composer.state}).`);
      }
      const base = stripSlash(airflowBase() ?? '');
      const via = viaProxy(ctx.probes, base);
      try {
        const h = await airflow().health();
        const parts = [
          `metadatabase ${h.metadatabase ?? 'unknown'}`,
          `scheduler ${h.scheduler.status ?? 'unknown'}`,
        ];
        if (h.scheduler.latestHeartbeat !== null) {
          const ago = Math.max(0, Math.round((ctx.now() - h.scheduler.latestHeartbeat) / 1000));
          parts.push(`last scheduler heartbeat ${ago} s ago`);
        }
        const text = `${hostOf(base)} answered${via}: ${parts.join(', ')}.`;
        if (h.metadatabase === 'unhealthy' || h.scheduler.status === 'unhealthy') {
          return warn(text, {
            fixHint: "The web server answers, but Airflow reports a problem: check the environment's health.",
            docsUrl: DOCTOR_DOCS.airflowApi,
          });
        }
        return pass(text);
      } catch (error) {
        if (error instanceof SourceError && UNREACHABLE.has(error.kind) && entry.source.kind === 'airflow')
          state.unreachable = true;
        return airflowFailure(error, entry, `${hostOf(base)}${via}`);
      }
    },
  };

  const roleStep: Step = {
    id: 'airflow.role',
    title: ENV_TITLES.role,
    run: async () => {
      if (state.unsupported) return skipAfter(ENV_TITLES.version);
      if (!outcomes.ok('airflow.health')) return skipAfter(ENV_TITLES.health);
      const api = airflow();
      let total: number;
      try {
        total = (await api.dags({ limit: 1, offset: 0 })).total;
      } catch (error) {
        if (error instanceof SourceError && error.kind === 'forbidden') {
          return fail('The identity has no Airflow role that can read DAGs (403 on GET /dags).', {
            fixHint: 'Ask an environment administrator to assign you the Airflow Viewer role.',
            docsUrl: DOCTOR_DOCS.airflowRbac,
          });
        }
        return airflowFailure(error, entry, hostOf(airflowBase() ?? ''));
      }
      const dags = `Reads DAGs (${total} DAGs in total)`;
      // §18.3: `GET /providers` needs a permission Viewer lacks; success means Op or higher.
      if (await api.canReadProviders()) {
        return warn(
          `${dags}; GET /providers is allowed, so the role is Op or higher. DCAM needs only Viewer.`,
          {
            fixHint:
              entry.source.kind === 'composer'
                ? 'Ask an environment administrator to change your Airflow role to Viewer (Composer 3 registers first-time API users as Op).'
                : 'Use an Airflow user with the Viewer role for DCAM.',
            docsUrl: DOCTOR_DOCS.airflowRbac,
          },
        );
      }
      return pass(`${dags}; GET /providers is refused, so the role is below Op (Viewer is enough).`);
    },
  };

  const monitoringStep: Step = {
    id: 'monitoring.read',
    title: ENV_TITLES.monitoring,
    run: async () => {
      const s = entry.source;
      if (s.kind !== 'composer') return skip('Self-managed Airflow: no Cloud Monitoring metrics.');
      if (ctx.googleRefused !== null) return skip(`Skipped: ${ctx.googleRefused}.`);
      if (!ctx.adcOk) return skipAfter('Application Default Credentials');
      const api = probes().monitoring;
      if (!api) return fail('No Cloud Monitoring client is configured for this environment.');
      const to = ctx.now();
      const query: MetricQuery = {
        projectId: s.projectId,
        metricType: 'composer.googleapis.com/environment/healthy',
        resourceType: 'cloud_composer_environment',
        resourceLabels: { project_id: s.projectId, location: s.location, environment_name: s.environment },
        from: to - MONITORING_WINDOW_MS,
        to,
        alignmentPeriodSeconds: 300,
        aligner: 'ALIGN_FRACTION_TRUE',
      };
      const q = quota(s);
      const via = viaProxy(
        ctx.probes,
        `https://monitoring.googleapis.com/v3/projects/${s.projectId}/timeSeries`,
      );
      try {
        const series = await api.series(query);
        const text = `${plural(series.length, 'time series', 'time series')} of environment/healthy in the last 20 min${via}.`;
        if (series.length > 0) return pass(text);
        return warn(`${text} An environment that runs reports this metric every 5 min.`, {
          fixHint: `Check location and environment of ${entry.id} in ${ctx.config.path}.`,
        });
      } catch (error) {
        return googleFailure(error, {
          service: 'monitoring.googleapis.com',
          projectId: s.projectId,
          quotaProject: q.project,
          quotaSource: q.source,
          via,
          forbiddenRole: 'roles/monitoring.viewer',
          forbiddenDocs: DOCTOR_DOCS.monitoringIam,
          notFound: `Check projectId of ${entry.id} in ${ctx.config.path}.`,
        });
      }
    },
  };

  const clockStep: Step = {
    id: 'clock.skew',
    title: ENV_TITLES.clock,
    run: async () => {
      const s = entry.source;
      const url = s.kind === 'composer' ? composerUrl(s) : `${stripSlash(s.baseUrl)}/api/v1/health`;
      const host = hostOf(url);
      if (s.kind === 'composer' && ctx.googleRefused !== null) return skip(`Skipped: ${ctx.googleRefused}.`);
      if (state.unreachable) return skip(`Skipped: ${host} was not reachable.`);
      const before = ctx.now();
      const date = await probes().serverDate(url);
      const after = ctx.now();
      if (date === null) return warn(`${host} sent no Date header; the clock was not compared.`);
      // The Date header has 1 s resolution; compare with the middle of the request.
      const aheadMs = (before + after) / 2 - date;
      const abs = Math.abs(aheadMs);
      const rel = aheadMs > 0 ? 'ahead of' : 'behind';
      const text =
        abs < 1_000 + (after - before) / 2
          ? `The local clock matches ${host} within 1 s (HTTP Date header).`
          : `The local clock is ${formatSeconds(abs)} ${rel} ${host} (HTTP Date header, 1 s resolution).`;
      const extra = {
        fixHint: "Turn on automatic time synchronisation in your operating system's date and time settings.",
      };
      if (abs > CLOCK_FAIL_MS) return fail(text, extra);
      if (abs > CLOCK_WARN_MS) return warn(text, extra);
      return pass(text);
    },
  };

  return entry.source.kind === 'composer'
    ? [composerStep, composerVersionStep, healthStep, roleStep, monitoringStep, clockStep]
    : [composerStep, healthStep, airflowVersionStep, roleStep, monitoringStep, clockStep];
}

function formatSeconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * Composer image versions (https://docs.cloud.google.com/composer/docs/composer-versioning-overview,
 * "Version schemas"): `composer-3-airflow-x.y.z-build.t` for Composer 3 and `composer-2.b.c-airflow-x.y.z`
 * for Composer 2. `environments.get` returns the resolved version ("the resolved image version is stored
 * in the same field", REST reference `SoftwareConfig.imageVersion`); aliases such as `composer-3-airflow-2`
 * are accepted anyway. The documented regex has no `-build.t` part, so it is optional here.
 */
const IMAGE = /^composer-(\d+)(?:\.\d+\.\d+(?:-preview\.\d+)?)?-airflow-(\d+(?:\.\d+){0,2})(?:-build\.\d+)?$/;

export function imageVersion(image: string | null): Outcome {
  const m = image ? IMAGE.exec(image) : null;
  if (!image || !m) {
    return warn(`DCAM could not read the Composer image version "${image ?? 'unknown'}".`, {
      fixHint:
        'Check the image version in the Google Cloud console; DCAM supports Composer 2 and 3 with Airflow 2.',
      docsUrl: DOCTOR_DOCS.composerVersions,
    });
  }
  const generation = Number(m[1]);
  const airflow = m[2] ?? '';
  const text = `Composer ${generation}, Airflow ${airflow} (${image}).`;
  const byAirflow = airflowVersion(airflow, text);
  if (byAirflow.status !== 'pass') return byAirflow;
  if (generation === 2 || generation === 3) return byAirflow;
  return warn(`${text} DCAM is built for Composer 2 and 3; Composer ${generation} is untested.`, {
    fixHint: 'Results may be incomplete; DCAM targets Composer 2 and 3.',
    docsUrl: DOCTOR_DOCS.composerVersions,
  });
}

/** "Airflow 2" means 2.10 or later 2.x; Airflow 3 waits for the API v2 adapter in M4 (spec §1, FR-COLL-08). */
export function airflowVersion(version: string, text: string): Outcome {
  const [major = 0, minor] = version.split('.').map((n) => Number.parseInt(n, 10));
  if (major >= 3 || major < 2) {
    return fail(`${text} DCAM reads only Airflow 2 in this release.`, {
      fixHint: 'Airflow 3 support arrives with the Airflow REST API v2 adapter in milestone M4.',
      docsUrl: DOCTOR_DOCS.composerVersions,
    });
  }
  // An alias such as `composer-3-airflow-2` names no minor version: nothing to warn about.
  if (minor !== undefined && minor < 10) {
    return warn(`${text} DCAM targets Airflow 2.10 or later 2.x; some fields may be missing.`, {
      fixHint: 'Results may be incomplete; upgrading to Airflow 2.10 or later is recommended.',
      docsUrl: DOCTOR_DOCS.composerVersions,
    });
  }
  return pass(text);
}

interface GoogleContext {
  readonly service: string;
  readonly projectId: string;
  readonly quotaProject: string;
  readonly quotaSource: string;
  readonly via: string;
  readonly forbiddenRole: string;
  readonly forbiddenDocs: string;
  readonly notFound: string;
}

/**
 * Used only when the transport gave no specific hint. Loopback addresses always bypass a remote proxy,
 * so no NO_PROXY advice here.
 */
const NETWORK_HINT =
  'Behind a corporate proxy, set HTTPS_PROXY in the shell that starts DCAM; if the proxy inspects TLS, set NODE_EXTRA_CA_CERTS (or network.caBundlePath) to your corporate root CA.';

/**
 * A failure before a usable HTTP answer: the transport's own hint first (TLS inspection, proxy
 * authentication, a refused redirect), else `fallback`. A redirect did answer, with its 3xx status.
 */
function unreachable(error: SourceError, where: string, fallback: string, docsUrl: string): Outcome {
  const status = error.details.status;
  const text =
    status === undefined
      ? `No answer from ${where}: ${error.message}`
      : `${where} answered HTTP ${status}: ${error.message}`;
  return fail(text, { fixHint: error.details.fixHint ?? fallback, docsUrl });
}

/** Explains a failed Google API call from its `SourceError` kind (FR-AUTH-04, FR-AUTH-06). */
function googleFailure(error: unknown, g: GoogleContext): Outcome {
  if (!(error instanceof SourceError)) return fail(`${g.service}${g.via}: ${errorMessage(error)}`);
  const status = error.details.status === undefined ? '' : ` (HTTP ${error.details.status})`;
  const said = `${g.service}${g.via} answered${status}: ${error.message}`;
  switch (error.kind) {
    case 'unauthenticated':
      // Without an HTTP status no request was sent: the token itself could not be fetched.
      if (error.details.status === undefined)
        return fail(`No access token, so nothing was sent to ${g.service}: ${error.message}`, {
          fixHint: error.details.fixHint ?? 'gcloud auth application-default login',
          docsUrl: DOCTOR_DOCS.adcLogin,
        });
      return fail(`The access token was rejected. ${said}`, {
        fixHint: 'gcloud auth application-default login',
        docsUrl: DOCTOR_DOCS.adcLogin,
      });
    case 'forbidden':
      return fail(`Permission denied. ${said}`, {
        fixHint: `Ask a project administrator to grant you ${g.forbiddenRole} on ${g.projectId}.`,
        docsUrl: g.forbiddenDocs,
      });
    case 'quota-project':
      return fail(`The quota project ${g.quotaProject} cannot be used. ${said}`, {
        details: [
          `DCAM sends x-goog-user-project: ${g.quotaProject} (from ${g.quotaSource}).`,
          `The identity needs serviceusage.services.use on ${g.quotaProject} (roles/serviceusage.serviceUsageConsumer), or set auth.quotaProjectId to a project where it has it.`,
        ],
        fixHint: `gcloud auth application-default set-quota-project ${g.quotaProject}`,
        docsUrl: DOCTOR_DOCS.setQuotaProject,
      });
    case 'vpc-sc':
      return fail(
        `VPC Service Controls denied the request (unique identifier: ${error.details.vpcScId ?? 'not reported'}). ${said}`,
        {
          fixHint:
            "Send the unique identifier to your security team: your network or device must meet the perimeter's access level, or run DCAM inside the perimeter. DCAM does not retry until you run the doctor again.",
          docsUrl: DOCTOR_DOCS.vpcSc,
        },
      );
    case 'api-disabled':
      return fail(`The API is not enabled in ${g.quotaProject}. ${said}`, {
        fixHint: `gcloud services enable ${g.service} --project=${g.quotaProject}`,
        docsUrl: DOCTOR_DOCS.enableApi,
      });
    case 'not-found':
      return fail(`Not found. ${said}`, { fixHint: g.notFound, docsUrl: DOCTOR_DOCS.composerIam });
    case 'network':
    case 'timeout':
      return unreachable(error, `${g.service}${g.via}`, NETWORK_HINT, DOCTOR_DOCS.gcloudProxy);
    case 'rate-limited':
    case 'unavailable':
      return fail(`Temporarily unavailable. ${said}`, {
        fixHint: 'Wait a minute, then run the doctor again.',
      });
    default:
      return fail(said, { fixHint: error.details.fixHint ?? null });
  }
}

/** Explains a failed Airflow web server call (§18.3, §18.9). */
function airflowFailure(error: unknown, entry: EnvironmentEntry, where: string): Outcome {
  if (!(error instanceof SourceError)) return fail(`${where}: ${errorMessage(error)}`);
  const composer = entry.source.kind === 'composer';
  const status = error.details.status === undefined ? '' : ` (HTTP ${error.details.status})`;
  const said = `${where} answered${status}: ${error.message}`;
  const docsUrl = DOCTOR_DOCS.airflowApi;
  switch (error.kind) {
    case 'network':
    case 'timeout':
      return unreachable(
        error,
        where,
        composer
          ? `${NETWORK_HINT} The web server's access control must allow your egress IP or the proxy's.`
          : 'Start the emulator (tools/emulator), or check the baseUrl in the configuration.',
        docsUrl,
      );
    case 'unauthenticated':
      // Without an HTTP status nothing was sent: unset emulator credentials, or no Google token.
      if (error.details.status === undefined)
        return fail(`${error.message} Nothing was sent to ${where}.`, {
          fixHint:
            error.details.fixHint ??
            (composer
              ? 'gcloud auth application-default login'
              : 'Set the variables named by usernameEnv and passwordEnv in the shell that starts DCAM.'),
          docsUrl,
        });
      return fail(`The web server rejected the credentials. ${said}`, {
        fixHint: composer
          ? 'gcloud auth application-default login'
          : 'Check the variables named by usernameEnv and passwordEnv in the configuration.',
        docsUrl,
      });
    case 'forbidden':
      // Composer documents "usually 403" when network access control blocks the Airflow UI
      // (composer-3/troubleshooting-web-server); for the REST API a 403 cannot be told apart from an
      // Airflow role denial. ⚠️ VERIFY the REST API signature during the spike (§18.9, §22.5).
      return fail(`The web server refused the request. ${said}`, {
        fixHint:
          "Ask an administrator to check the web server's network access control (it must allow your egress IP or the proxy's) and that you have an Airflow role.",
        docsUrl,
      });
    case 'not-found':
      // Airflow 3: "REST API (``/api/v1``) replaced: Use the modern FastAPI-based stable ``/api/v2`` instead"
      // (airflow-core/docs/installation/upgrading_to_airflow3.rst at tag 3.1.0, checked 2026-11-07).
      return fail(`No Airflow REST API v1 here. ${said}`, {
        fixHint:
          'Airflow 3 replaced the REST API v1 with /api/v2, which DCAM reads from M4 (spec §22.2). If the environment runs Airflow 2, check that the URL is its Airflow web server.',
        docsUrl,
      });
    case 'rate-limited':
    case 'unavailable':
      return fail(`Temporarily unavailable. ${said}`, {
        fixHint: 'Wait a minute, then run the doctor again.',
      });
    default:
      return fail(said, { fixHint: error.details.fixHint ?? null, docsUrl });
  }
}
