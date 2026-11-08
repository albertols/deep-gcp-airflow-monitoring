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
export type DurationDistribution = Schemas['DurationDistribution'];
export type DurationRegression = Schemas['DurationRegression'];
export type TaskReliability = Schemas['TaskReliability'];
export type DagConcurrency = Schemas['DagConcurrency'];
export type DagImpact = Schemas['DagImpact'];
export type DagNoisyNeighbour = Schemas['DagNoisyNeighbour'];
export type DagComparison = Schemas['DagComparison'];
export type CompareEnvironment = Schemas['CompareEnvironment'];
export type CompareDag = Schemas['CompareDag'];
export type RunComparison = Schemas['RunComparison'];
export type RunSide = Schemas['RunSide'];
export type TaskInRun = Schemas['TaskInRun'];
export type WaitReasonId = Schemas['WaitReasonId'];
export type Bottlenecks = Schemas['Bottlenecks'];
export type NoisyNeighbours = Schemas['NoisyNeighbours'];
export type NoisyNeighbour = Schemas['NoisyNeighbour'];
export type PriorityFairness = Schemas['PriorityFairness'];
export type Schedule = Schemas['Schedule'];
export type Spread = Schemas['Spread'];
export type LimitSource = Schemas['LimitSource'];
export type Capacity = Schemas['Capacity'];
export type Forecast = Schemas['Forecast'];
export type ForecastWindow = Schemas['ForecastWindow'];
export type ForecastCheck = Schemas['ForecastCheck'];
export type Finding = Schemas['Finding'];
export type Findings = Schemas['Findings'];
export type AlertState = Schemas['AlertState'];
export type AlertRule = Schemas['AlertRule'];
export type AlertEvent = Schemas['AlertEvent'];
export type Alerts = Schemas['Alerts'];
export type HealthCheck = Schemas['HealthCheck'];
export type FleetCard = Schemas['FleetCard'];
export type Fleet = Schemas['Fleet'];
export type Collection = Schemas['Collection'];
export type CollectionEnvironment = Schemas['CollectionEnvironment'];
export type CollectionStorage = Schemas['CollectionStorage'];
export type CollectorStatus = Schemas['CollectorStatus'];
export type ApiFootprint = Schemas['ApiFootprint'];
export type BackfillStatus = Schemas['BackfillStatus'];
export type ConfigIssue = Schemas['ConfigIssue'];
/** Time range preset of the `range` query parameter (FR-UI-01). */
export type Range = components['parameters']['Range'];
/** The capacity page's range, up to 7 days (`CapacityRange` in openapi.yaml). */
export type CapacityRange = components['parameters']['CapacityRange'];

/** Typed client for DCAM's own API, generated from openapi.yaml. */
export function createApiClient(baseUrl = '') {
  return createClient<paths>({ baseUrl });
}
