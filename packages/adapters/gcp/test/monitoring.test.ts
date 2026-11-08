import { describe, expect, it } from 'vitest';
import type { MetricQuery } from '@dcam/ports';
import { createMonitoringApi } from '../src/index';
import { fakeHttp, fakeTokens } from './support/fakes';

const T0 = Date.parse('2026-11-05T10:00:00Z');
const QUERY: MetricQuery = {
  projectId: 'acme-prod-123',
  metricType: 'composer.googleapis.com/environment/num_celery_workers',
  resourceType: 'cloud_composer_environment',
  resourceLabels: { environment_name: 'acme-composer-prod', location: 'europe-west1' },
  from: T0,
  to: T0 + 3 * 60_000,
  alignmentPeriodSeconds: 60,
  aligner: 'ALIGN_MAX',
};

const point = (minute: number, value: Record<string, unknown>) => ({
  interval: {
    startTime: new Date(T0 + (minute - 1) * 60_000).toISOString(),
    endTime: new Date(T0 + minute * 60_000).toISOString(),
  },
  value,
});

const series = (labels: Record<string, string>, points: unknown[]) => ({
  metric: { type: QUERY.metricType, labels },
  resource: {
    type: 'cloud_composer_environment',
    labels: { project_id: 'acme-prod-123', environment_name: 'acme-composer-prod', location: 'europe-west1' },
  },
  metricKind: 'GAUGE',
  valueType: 'INT64',
  // Cloud Monitoring lists points newest first.
  points,
});

describe('FR-COLL-07 Cloud Monitoring timeSeries.list', () => {
  it('FR-AUTH-04: builds the documented query with filter, interval, aggregation and view', async () => {
    const { http, requests } = fakeHttp({ status: 200, body: {} });
    const api = createMonitoringApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    await api.series({
      ...QUERY,
      metricLabels: { state: 'running' },
      reducer: 'REDUCE_SUM',
      groupBy: ['resource.labels.workload_name', 'metric.labels.state'],
    });
    const url = requests[0]?.url;
    expect(url?.origin + (url?.pathname ?? '')).toBe(
      'https://monitoring.googleapis.com/v3/projects/acme-prod-123/timeSeries',
    );
    const p = url?.searchParams;
    expect(p?.get('filter')).toBe(
      'metric.type = "composer.googleapis.com/environment/num_celery_workers" AND ' +
        'resource.type = "cloud_composer_environment" AND ' +
        'resource.labels.environment_name = "acme-composer-prod" AND resource.labels.location = "europe-west1" AND ' +
        'metric.labels.state = "running"',
    );
    expect(p?.get('interval.startTime')).toBe('2026-11-05T10:00:00.000Z');
    expect(p?.get('interval.endTime')).toBe('2026-11-05T10:03:00.000Z');
    expect(p?.get('aggregation.alignmentPeriod')).toBe('60s');
    expect(p?.get('aggregation.perSeriesAligner')).toBe('ALIGN_MAX');
    expect(p?.get('aggregation.crossSeriesReducer')).toBe('REDUCE_SUM');
    expect(p?.getAll('aggregation.groupByFields')).toEqual([
      'resource.labels.workload_name',
      'metric.labels.state',
    ]);
    expect(p?.get('view')).toBe('FULL');
    expect(p?.has('pageToken')).toBe(false);
    // Spaces travel as %20, never as form-encoded '+'.
    expect(url?.search).not.toContain('+');
    expect(url?.search).toContain('filter=metric.type%20%3D%20%22composer.googleapis.com');
    expect(requests[0]?.headers).toMatchObject({
      authorization: 'Bearer acme-token-1',
      'x-goog-user-project': 'acme-prod-123',
    });
  });

  it('FR-AUTH-04: auth.quotaProjectId is sent as x-goog-user-project', async () => {
    const { http, requests } = fakeHttp({ status: 200, body: {} });
    const api = createMonitoringApi({
      http,
      tokens: fakeTokens().tokens,
      quotaProjectId: 'acme-billing-456',
    });
    await api.series(QUERY);
    expect(requests[0]?.headers['x-goog-user-project']).toBe('acme-billing-456');
  });

  it('FR-COLL-07: escapes quotes and backslashes in filter values, and refuses odd label keys', async () => {
    const { http, requests } = fakeHttp({ status: 200, body: {} });
    const api = createMonitoringApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    await api.series({ ...QUERY, resourceLabels: { environment_name: 'acme"x\\y' } });
    expect(requests[0]?.url.searchParams.get('filter')).toContain(
      'resource.labels.environment_name = "acme\\"x\\\\y"',
    );
    await expect(
      api.series({ ...QUERY, resourceLabels: { 'environment_name OR true': 'x' } }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('FR-COLL-07: refuses alignment periods under 60 s and empty intervals before any request', async () => {
    const { http, requests } = fakeHttp();
    const api = createMonitoringApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    for (const bad of [
      { alignmentPeriodSeconds: 30 },
      { alignmentPeriodSeconds: 90.5 },
      { from: QUERY.to, to: QUERY.from },
    ]) {
      await expect(api.series({ ...QUERY, ...bad })).rejects.toBeInstanceOf(RangeError);
    }
    expect(requests).toHaveLength(0);
  });

  it('FR-COLL-07: maps int64 strings, doubles, booleans and distribution means; points oldest first, at = interval end', async () => {
    const { http } = fakeHttp({
      status: 200,
      body: {
        timeSeries: [
          series({ state: 'running' }, [
            point(3, { int64Value: '7' }),
            point(2, { int64Value: '5' }),
            point(1, { int64Value: '4' }),
          ]),
          series({ state: 'cpu' }, [point(2, { doubleValue: 0.25 }), point(1, { doubleValue: 0.5 })]),
          series({ state: 'healthy' }, [point(2, { boolValue: false }), point(1, { boolValue: true })]),
          // Empty distributions (count "0", or count omitted as proto3 JSON does for 0) are gaps, not 0.
          series({ state: 'latency' }, [
            point(1, { distributionValue: { count: '3', mean: 12.5 } }),
            point(2, { distributionValue: { count: '0' } }),
            point(3, { distributionValue: {} }),
          ]),
        ],
        unit: '1',
      },
    });
    const api = createMonitoringApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    const result = await api.series(QUERY);
    const at = (m: number) => T0 + m * 60_000;
    expect(result).toEqual([
      {
        metricLabels: { state: 'running' },
        resourceLabels: {
          project_id: 'acme-prod-123',
          environment_name: 'acme-composer-prod',
          location: 'europe-west1',
        },
        points: [
          { at: at(1), value: 4 },
          { at: at(2), value: 5 },
          { at: at(3), value: 7 },
        ],
      },
      expect.objectContaining({
        points: [
          { at: at(1), value: 0.5 },
          { at: at(2), value: 0.25 },
        ],
      }),
      expect.objectContaining({
        points: [
          { at: at(1), value: 1 },
          { at: at(2), value: 0 },
        ],
      }),
      expect.objectContaining({ points: [{ at: at(1), value: 12.5 }] }),
    ]);
  });

  it('FR-COLL-07: skips points that are not numbers (strings, NaN) and series without labels map to empty records', async () => {
    const { http } = fakeHttp({
      status: 200,
      body: {
        timeSeries: [
          {
            metric: { type: QUERY.metricType },
            resource: { type: 'cloud_composer_environment' },
            points: [
              point(2, { stringValue: 'x' }),
              point(1, { doubleValue: 'NaN' }),
              point(3, { doubleValue: 'Infinity' }),
            ],
          },
        ],
      },
    });
    const api = createMonitoringApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    expect(await api.series(QUERY)).toEqual([{ metricLabels: {}, resourceLabels: {}, points: [] }]);
  });

  it('FR-COLL-07: follows nextPageToken and merges a series split across pages', async () => {
    const { http, requests } = fakeHttp(
      {
        status: 200,
        body: {
          timeSeries: [
            series({ state: 'running' }, [point(3, { int64Value: '7' })]),
            series({ state: 'queued' }, [point(1, { int64Value: '1' })]),
          ],
          nextPageToken: 'acme-page-2',
        },
      },
      {
        status: 200,
        body: {
          timeSeries: [
            series({ state: 'running' }, [point(2, { int64Value: '5' }), point(3, { int64Value: '7' })]),
          ],
          nextPageToken: '',
        },
      },
    );
    const api = createMonitoringApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    const result = await api.series(QUERY);
    expect(requests.map((r) => r.url.searchParams.get('pageToken'))).toEqual([null, 'acme-page-2']);
    expect(result.map((s) => [s.metricLabels['state'], s.points.map((p) => p.value)])).toEqual([
      ['running', [5, 7]],
      ['queued', [1]],
    ]);
  });

  it('FR-COLL-07: stops with a non-transient error at the page cap instead of returning a partial result', async () => {
    const page = (n: number) => ({
      status: 200,
      body: { timeSeries: [], nextPageToken: `acme-page-${n + 1}` },
    });
    const { http, requests } = fakeHttp(page(1), page(2), page(3));
    const api = createMonitoringApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null, maxPages: 3 });
    const error: unknown = await api.series(QUERY).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'SourceError', kind: 'invalid-response', transient: false });
    expect((error as Error).message).toMatch(/3 pages/);
    expect(requests).toHaveLength(3);
  });

  it('FR-COLL-07: executionErrors (possibly incomplete data) fail transiently', async () => {
    const { http } = fakeHttp({
      status: 200,
      body: { timeSeries: [], executionErrors: [{ code: 14, message: 'acme backend unavailable' }] },
    });
    const api = createMonitoringApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    await expect(api.series(QUERY)).rejects.toMatchObject({ kind: 'unavailable', transient: true });
  });

  it('FR-AUTH-06: errors are classified (API disabled with the enable command)', async () => {
    const { http } = fakeHttp({
      status: 403,
      body: {
        error: {
          code: 403,
          message:
            'Cloud Monitoring API has not been used in project acme-prod-123 before or it is disabled.',
          status: 'PERMISSION_DENIED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'SERVICE_DISABLED',
              domain: 'googleapis.com',
              metadata: { consumer: 'projects/acme-prod-123', service: 'monitoring.googleapis.com' },
            },
          ],
        },
      },
    });
    const api = createMonitoringApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    const error: unknown = await api.series(QUERY).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'api-disabled' });
    expect((error as { details: { fixHint: string } }).details.fixHint).toContain(
      'gcloud services enable monitoring.googleapis.com --project=acme-prod-123',
    );
  });
});
