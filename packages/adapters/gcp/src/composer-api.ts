/**
 * Composer API v1 `environments.get`: the environment's state, Airflow web server URI, image version,
 * Airflow configuration overrides and worker and scheduler sizing.
 *
 * Resource reference: https://docs.cloud.google.com/composer/docs/reference/rest/v1/projects.locations.environments
 * (`state` enum in v1: STATE_UNSPECIFIED, CREATING, RUNNING, UPDATING, DELETING, ERROR; unknown values are
 * kept as reported). proto3 JSON omits fields at their default value, so every field is optional here;
 * `count`, `minCount` and `maxCount` are int32 (JSON numbers) but numeric strings are accepted too.
 *
 * @implements FR-AUTH-04, FR-COLL-01
 */
import { z } from 'zod';
import {
  SourceError,
  type ComposerApi,
  type ComposerEnvironment,
  type ComposerEnvironmentRef,
} from '@dcam/ports';
import { googleGetJson, segment, type GoogleApiDeps } from './google-request';

export const COMPOSER_API = 'https://composer.googleapis.com/v1';

const Int = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^-?\d+$/)
    .transform(Number),
]);

const Environment = z.object({
  state: z.string().optional(),
  config: z
    .object({
      airflowUri: z.string().optional(),
      softwareConfig: z
        .object({
          imageVersion: z.string().optional(),
          airflowConfigOverrides: z.record(z.string(), z.string()).optional(),
        })
        .optional(),
      workloadsConfig: z
        .object({
          worker: z
            .object({
              minCount: Int.optional(),
              maxCount: Int.optional(),
              cpu: z.number().optional(),
              memoryGb: z.number().optional(),
            })
            .optional(),
          scheduler: z.object({ count: Int.optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type ComposerApiOptions = GoogleApiDeps;

export function createComposerApi(deps: ComposerApiOptions): ComposerApi {
  return {
    async environment(ref: ComposerEnvironmentRef): Promise<ComposerEnvironment> {
      const url =
        `${COMPOSER_API}/projects/${segment('projectId', ref.projectId)}` +
        `/locations/${segment('location', ref.location)}` +
        `/environments/${segment('environment', ref.environment)}`;
      const parsed = Environment.safeParse(await googleGetJson(deps, url, ref.projectId));
      if (!parsed.success) {
        throw new SourceError(
          'invalid-response',
          `Composer environments.get returned an unexpected body: ${z.prettifyError(parsed.error).slice(0, 300)}`,
        );
      }
      const config = parsed.data.config;
      const worker = config?.workloadsConfig?.worker;
      return {
        state: parsed.data.state ?? 'STATE_UNSPECIFIED',
        airflowUri: config?.airflowUri ?? null,
        imageVersion: config?.softwareConfig?.imageVersion ?? null,
        airflowConfigOverrides: config?.softwareConfig?.airflowConfigOverrides ?? {},
        worker: {
          minCount: worker?.minCount ?? null,
          maxCount: worker?.maxCount ?? null,
          cpu: worker?.cpu ?? null,
          memoryGb: worker?.memoryGb ?? null,
        },
        schedulerCount: config?.workloadsConfig?.scheduler?.count ?? null,
      };
    },
  };
}
