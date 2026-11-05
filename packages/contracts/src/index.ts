import createClient from 'openapi-fetch';
import type { components, paths } from './generated/api';

export type { components, paths };
export type Schemas = components['schemas'];
export type EnvironmentOverview = Schemas['EnvironmentOverview'];
export type Meta = Schemas['Meta'];
export type Problem = Schemas['Problem'];

/** Typed client for DCAM's own API, generated from openapi.yaml. */
export function createApiClient(baseUrl = '') {
  return createClient<paths>({ baseUrl });
}
