/**
 * The clients of one configured environment, each on that environment's own guarded client, so every
 * request it makes is checked against the allowlist and lands in its footprint. Composer environments
 * read the Composer API, Cloud Monitoring and the Airflow API with the shared ADC token source; a
 * self-managed Airflow on loopback (the emulator) reads the Airflow API with basic authentication from
 * the environment variables the configuration names.
 *
 * @implements FR-AUTH-01, FR-AUTH-04, FR-AUTH-07, FR-EMU-02, HM-030, NFR-SEC-03
 */
import type { ApiId, EnvironmentSources, RequestRecord } from '@dcam/application';
import { createAirflowV1Api } from '@dcam/airflow-v1';
import { createComposerApi, createMonitoringApi } from '@dcam/gcp';
import {
  createGuardedClient,
  networkModeFromEnv,
  toReadOnlyHttp,
  type Service,
  type Transport,
} from '@dcam/http-guard';
import {
  SourceError,
  type AccessTokenSource,
  type AirflowApi,
  type EnvironmentEntry,
  type WorkspaceConfig,
} from '@dcam/ports';

type Env = Readonly<Record<string, string | undefined>>;

export interface EnvironmentClientsOptions {
  readonly entry: EnvironmentEntry;
  readonly config: WorkspaceConfig;
  /**
   * The process environment: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`,
   * `DCAM_NETWORK`, and the credential variables a self-managed Airflow source names.
   */
  readonly env: Env;
  /** Shared by every environment, so one `gcloud` call serves them all. */
  readonly tokens: AccessTokenSource;
  /** Every request that reached the network, for the footprint (HM-030). */
  readonly onRequest?: (api: ApiId, request: RequestRecord) => void;
  readonly now?: () => number;
  /** Replaces the proxy- and CA-aware transport (tests). */
  readonly transport?: Transport;
}

export interface EnvironmentClients extends EnvironmentSources {
  /**
   * Sends one GET to `url` without credentials (any HTTP status counts) and returns its `Date`
   * response header as epoch milliseconds, or `null` when there is none: the doctor's clock check.
   */
  serverDate(url: string): Promise<number | null>;
  /** Closes the connections of this environment's guarded client. */
  close(): Promise<void>;
}

const API_OF: Partial<Record<Service, ApiId>> = {
  airflow: 'airflow',
  composer: 'composer',
  monitoring: 'monitoring',
};

/** An Airflow API whose every call fails with `error`, sending nothing. */
function failingAirflow(error: SourceError): AirflowApi {
  const fail = async (): Promise<never> => {
    throw error;
  };
  return {
    version: fail,
    health: fail,
    dags: fail,
    pools: fail,
    importErrorCount: fail,
    taskInstances: fail,
    canReadProviders: fail,
  };
}

export function createEnvironmentClients(options: EnvironmentClientsOptions): EnvironmentClients {
  const { entry, config, env, tokens } = options;
  const source = entry.source;
  const client = createGuardedClient({
    network: networkModeFromEnv(env),
    proxyEnv: env,
    ...(config.caBundlePath === null ? {} : { caBundlePath: config.caBundlePath }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.now === undefined ? {} : { now: options.now }),
    // A self-managed Airflow is reached at the configured loopback address; Composer's Airflow web
    // servers are on *.composer.googleusercontent.com, which the guard allows already.
    ...(source.kind === 'airflow' ? { hosts: { airflow: [new URL(source.baseUrl).host] } } : {}),
    onResponse: (event) => {
      const api = API_OF[event.service];
      if (!api) return;
      options.onRequest?.(api, {
        at: event.at,
        status: event.status,
        latencyMs: event.latencyMs,
        bytes: event.bytes,
      });
    },
  });
  const http = toReadOnlyHttp(client);
  const now = options.now === undefined ? {} : { now: options.now };

  const serverDate = async (url: string): Promise<number | null> => {
    const response = await http.request({ method: 'GET', url });
    const date = response.headers.get('date');
    const at = date === null ? Number.NaN : Date.parse(date);
    return Number.isFinite(at) ? at : null;
  };
  const close = () => client.close();

  if (source.kind === 'composer') {
    const google = { http, tokens, quotaProjectId: config.quotaProjectId, ...now };
    return {
      composer: createComposerApi(google),
      monitoring: createMonitoringApi(google),
      airflow: (baseUrl) => createAirflowV1Api({ http, baseUrl, auth: { kind: 'bearer', tokens }, ...now }),
      serverDate,
      close,
    };
  }

  return {
    airflow: (baseUrl) => {
      const username = env[source.usernameEnv];
      const password = env[source.passwordEnv];
      if (!username || !password) {
        return failingAirflow(
          new SourceError('unauthenticated', `The Airflow user name or password of ${entry.id} is not set.`, {
            fixHint: `Set ${source.usernameEnv} and ${source.passwordEnv} in the shell that starts DCAM, then restart it.`,
          }),
        );
      }
      return createAirflowV1Api({ http, baseUrl, auth: { kind: 'basic', username, password }, ...now });
    },
    serverDate,
    close,
  };
}
