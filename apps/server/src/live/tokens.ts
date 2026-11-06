/**
 * The Application Default Credentials token source that `dcam start` and `dcam doctor` share (ADR-0016):
 * `gcloud auth application-default print-access-token`, located through the given environment.
 *
 * `DCAM_NETWORK=loopback-only` keeps Claude Code sessions and tests off the network (spec §21.4). gcloud
 * talks to Google itself, outside the guarded client, so in that mode no token is requested at all and
 * no process is started: every call fails with a `guard` error that says why. A mistyped `DCAM_NETWORK`
 * is treated the same way, because a mistyped safety switch must not open the network.
 *
 * @implements FR-AUTH-01, NFR-SEC-04
 */
import { createGcloudTokenSource, type GcloudTokenSourceOptions } from '@dcam/gcp';
import { networkModeFromEnv } from '@dcam/http-guard';
import { SourceError, type AccessTokenSource } from '@dcam/ports';

type Env = Readonly<Record<string, string | undefined>>;

export const LOOPBACK_ONLY_NO_TOKEN = 'DCAM_NETWORK=loopback-only: no Google token is requested';

/** A token source whose every call fails with `SourceError('guard', reason)`; it starts nothing. */
export function refusingTokenSource(reason: string): AccessTokenSource {
  return {
    accessToken: async () => {
      throw new SourceError('guard', reason);
    },
    invalidate: () => undefined,
  };
}

export interface AdcTokenSourceOptions extends Omit<GcloudTokenSourceOptions, 'env'> {
  /** The process environment: `DCAM_NETWORK`, and `PATH`, `ComSpec` and `SystemRoot` for gcloud. */
  readonly env: Env;
}

export function createAdcTokenSource(options: AdcTokenSourceOptions): AccessTokenSource {
  let loopbackOnly: boolean;
  try {
    loopbackOnly = networkModeFromEnv(options.env) === 'loopback-only';
  } catch (error) {
    return refusingTokenSource(error instanceof Error ? error.message : String(error));
  }
  if (loopbackOnly) return refusingTokenSource(LOOPBACK_ONLY_NO_TOKEN);
  return createGcloudTokenSource(options);
}
