/**
 * The guarded client as the `ReadOnlyHttp` port that the Google and Airflow adapters receive. Failures
 * become {@link SourceError}s that collectors and the doctor act on: timeouts and network failures are
 * transient (retried with backoff), guard refusals are bugs and never retried.
 *
 * @implements FR-AUTH-07
 */
import { SourceError, type ReadOnlyHttp } from '@dcam/ports';
import { GuardError, type GuardedClient } from './guarded-client';
import { TransportError } from './transport-error';

export interface ReadOnlyHttpDefaults {
  /** Timeout for requests that set none (else the client's default, 30 s). */
  readonly timeoutMs?: number;
}

export function toReadOnlyHttp(client: GuardedClient, defaults: ReadOnlyHttpDefaults = {}): ReadOnlyHttp {
  return {
    async request(req) {
      const timeoutMs = req.timeoutMs ?? defaults.timeoutMs;
      try {
        return await client.request(timeoutMs === undefined ? req : { ...req, timeoutMs });
      } catch (error) {
        if (error instanceof TransportError) {
          throw new SourceError(
            error.kind,
            error.message,
            error.fixHint === undefined ? {} : { fixHint: error.fixHint },
          );
        }
        if (error instanceof GuardError && error.code === 'redirect') {
          // Not a DCAM bug: proxies send sign-in or block pages this way, and web servers send expired
          // sessions to a login page.
          throw new SourceError('network', error.message, {
            ...(error.status === undefined ? {} : { status: error.status }),
            fixHint:
              'DCAM never follows redirects. A proxy sign-in or block page often causes this: check ' +
              'HTTPS_PROXY and NO_PROXY. If it persists, sign in again: gcloud auth application-default login',
          });
        }
        if (error instanceof GuardError) {
          throw new SourceError('guard', `DCAM refused its own request (${error.code}): ${error.message}`);
        }
        // RangeError for an invalid timeout and other programming errors stay as they are.
        throw error;
      }
    },
  };
}
