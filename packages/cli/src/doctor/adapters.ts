/**
 * The doctor's adapter-backed probes, wired the way `dcam start` wires live collection: the
 * configuration file, the gcloud ADC token source, and each environment's clients on its own guarded
 * client (proxy, CA bundle, allowlist, `DCAM_NETWORK`).
 *
 * @implements FR-AUTH-05, FR-AUTH-01, FR-AUTH-07
 */
import { configFileLocation, loadWorkspaceConfig } from '@dcam/config-file';
import { createGcloudTokenSource } from '@dcam/gcp';
import type { Transport } from '@dcam/http-guard';
import type { AccessTokenSource } from '@dcam/ports';
import { createEnvironmentClients } from '@dcam/server';
import type { DoctorAdapters } from './probes';

export interface LiveDoctorAdaptersOptions {
  /** `--config`; `null` applies `DCAM_CONFIG`, else `dcam.config.yaml` in `cwd`. */
  readonly configPath: string | null;
  /** The process environment: `DCAM_CONFIG`, `DCAM_DATA_DIR`, proxy and CA variables, `DCAM_NETWORK`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly homeDir: string;
  /** Tests replace the token source and the transport; the doctor uses gcloud and the network. */
  readonly tokens?: AccessTokenSource;
  readonly transport?: Transport;
}

export interface LiveDoctorAdapters extends DoctorAdapters {
  /** Closes the connections the environment checks opened, so the process can exit at once. */
  close(): Promise<void>;
}

export function liveDoctorAdapters(options: LiveDoctorAdaptersOptions): LiveDoctorAdapters {
  const { env, cwd, homeDir } = options;
  const input = { flagPath: options.configPath ?? undefined, env, cwd, homeDir };
  // One token source: the ADC check fetches the token, and the environment checks reuse it.
  const tokens = options.tokens ?? createGcloudTokenSource();
  const opened: Array<{ close(): Promise<void> }> = [];
  return {
    async loadConfig() {
      const loaded = await loadWorkspaceConfig(input);
      if (loaded.ok) return { kind: 'valid', config: loaded.config };
      if (loaded.configPath === null) return { kind: 'missing', path: configFileLocation(input) };
      return { kind: 'invalid', path: loaded.configPath, issues: loaded.issues };
    },
    tokens,
    environment: (entry, config) => {
      const clients = createEnvironmentClients({
        entry,
        config,
        env,
        tokens,
        ...(options.transport === undefined ? {} : { transport: options.transport }),
      });
      opened.push(clients);
      return clients;
    },
    close: async () => {
      await Promise.allSettled(opened.splice(0).map((c) => c.close()));
    },
  };
}
