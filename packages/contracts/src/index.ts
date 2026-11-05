import createClient from 'openapi-fetch';
import type { components, paths } from './generated/api';

export type { components, paths };
export type Schemas = components['schemas'];
export type EnvironmentOverview = Schemas['EnvironmentOverview'];
export type Meta = Schemas['Meta'];
export type Problem = Schemas['Problem'];
export type SourceId = Schemas['SourceId'];
export type Quantile = Schemas['Quantile'];
export type Severity = Schemas['Severity'];
export type FindingRef = Schemas['FindingRef'];
export type DagLeague = Schemas['DagLeague'];
export type DagLeagueRow = Schemas['DagLeagueRow'];
export type DagDetail = Schemas['DagDetail'];
export type WaitReasonId = Schemas['WaitReasonId'];
export type Bottlenecks = Schemas['Bottlenecks'];
export type Finding = Schemas['Finding'];
export type Findings = Schemas['Findings'];
export type AlertState = Schemas['AlertState'];
export type AlertRule = Schemas['AlertRule'];
export type AlertEvent = Schemas['AlertEvent'];
export type Alerts = Schemas['Alerts'];
export type HealthCheck = Schemas['HealthCheck'];
export type FleetCard = Schemas['FleetCard'];
export type Fleet = Schemas['Fleet'];
export type Range = '1h' | '6h' | '24h';

/** Typed client for DCAM's own API, generated from openapi.yaml. */
export function createApiClient(baseUrl = '') {
  return createClient<paths>({ baseUrl });
}
