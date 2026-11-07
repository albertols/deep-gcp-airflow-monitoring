/**
 * Cloud Monitoring API v3 `projects.timeSeries.list` (the default Monitoring path, ADR-0014), aligned.
 *
 * - Method: https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list (`filter`,
 *   `interval.*`, `aggregation.*` and `view` are required or used; `pageSize` counts points with
 *   `view=FULL`, default and maximum 100,000).
 * - Response: https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/ListTimeSeriesResponse (a
 *   non-empty `nextPageToken` means more pages; `executionErrors` mean the data may be incomplete).
 * - Values: https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/TypedValue (`int64Value` is a
 *   string, `distributionValue.mean` is omitted when the count is zero). Points are listed newest first
 *   (https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/TimeSeries).
 * - Alignment periods are at least 60 s; timestamps are RFC 3339 and durations `"<seconds>s"` (protobuf JSON
 *   mapping, https://protobuf.dev/programming-guides/json/).
 *
 * Paging: every page is read up to `maxPages` (default 20). Reaching the cap fails the call with a
 * non-transient `invalid-response` error instead of returning a silently truncated result: a query that
 * needs more pages is too broad and must be narrowed (shorter window, longer alignment, a reducer).
 * ⚠️ VERIFY whether one series can be split across pages; series with the same labels are merged.
 *
 * @implements FR-AUTH-04, FR-COLL-07, NFR-OBS-06
 */
import { z } from 'zod';
import { SourceError, type MetricQuery, type MetricSeries, type MonitoringApi } from '@dcam/ports';
import { googleGetJson, segment, type GoogleApiDeps } from './google-request';

export const MONITORING_API = 'https://monitoring.googleapis.com/v3';
export const DEFAULT_MAX_PAGES = 20;

const Labels = z.record(z.string(), z.string());
const NumberLike = z.union([z.number(), z.string()]);

const Point = z.object({
  interval: z.object({ endTime: z.string(), startTime: z.string().optional() }),
  value: z
    .object({
      boolValue: z.boolean().optional(),
      int64Value: NumberLike.optional(),
      doubleValue: NumberLike.optional(),
      distributionValue: z
        .object({ count: NumberLike.optional(), mean: z.number().optional() })
        .loose()
        .optional(),
    })
    .loose(),
});

const Page = z.object({
  timeSeries: z
    .array(
      z.object({
        metric: z.object({ labels: Labels.optional() }).loose().optional(),
        resource: z.object({ labels: Labels.optional() }).loose().optional(),
        points: z.array(Point).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  executionErrors: z.array(z.object({ message: z.string().optional() }).loose()).optional(),
});

export interface MonitoringApiOptions extends GoogleApiDeps {
  /** Pages read per query before failing (default 20). */
  readonly maxPages?: number;
}

const LABEL_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GROUP_BY =
  /^(metric|resource)\.labels\.[A-Za-z_][A-Za-z0-9_]*$|^metadata\.(system|user)_labels\.[A-Za-z_][A-Za-z0-9_.]*$/;

const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function filterOf(query: MetricQuery): string {
  const clauses = [
    `metric.type = ${quote(query.metricType)}`,
    `resource.type = ${quote(query.resourceType)}`,
  ];
  for (const [prefix, labels] of [
    ['resource.labels', query.resourceLabels],
    ['metric.labels', query.metricLabels ?? {}],
  ] as const) {
    for (const [key, value] of Object.entries(labels)) {
      if (!LABEL_KEY.test(key)) throw new RangeError(`label key "${key}" is not a valid identifier`);
      clauses.push(`${prefix}.${key} = ${quote(value)}`);
    }
  }
  return clauses.join(' AND ');
}

function numeric(value: z.infer<typeof Point>['value']): number | undefined {
  let n: number | undefined;
  if (value.int64Value !== undefined) n = Number(value.int64Value);
  else if (value.doubleValue !== undefined) n = Number(value.doubleValue);
  else if (value.boolValue !== undefined) n = value.boolValue ? 1 : 0;
  else if (value.distributionValue !== undefined) {
    // An empty distribution (count 0, which proto3 JSON omits) has no mean: a gap, not 0.
    const count = Number(value.distributionValue.count ?? 0);
    n = count > 0 ? (value.distributionValue.mean ?? 0) : undefined;
  }
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

/** Stable key of a series' labels, for merging pages. */
const keyOf = (metric: Record<string, string>, resource: Record<string, string>) =>
  JSON.stringify([Object.entries(metric).sort(), Object.entries(resource).sort()]);

export function createMonitoringApi(deps: MonitoringApiOptions): MonitoringApi {
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  return {
    async series(query) {
      if (!Number.isInteger(query.alignmentPeriodSeconds) || query.alignmentPeriodSeconds < 60) {
        throw new RangeError(
          `alignmentPeriodSeconds must be a whole number ≥ 60, not ${query.alignmentPeriodSeconds}`,
        );
      }
      if (!(query.from < query.to)) throw new RangeError('the interval must end after it starts');
      for (const field of query.groupBy ?? []) {
        if (!GROUP_BY.test(field)) throw new RangeError(`groupBy field "${field}" is not supported`);
      }
      const base = new URL(`${MONITORING_API}/projects/${segment('projectId', query.projectId)}/timeSeries`);
      const p = base.searchParams;
      p.set('filter', filterOf(query));
      p.set('interval.startTime', new Date(query.from).toISOString());
      p.set('interval.endTime', new Date(query.to).toISOString());
      p.set('aggregation.alignmentPeriod', `${query.alignmentPeriodSeconds}s`);
      p.set('aggregation.perSeriesAligner', query.aligner);
      if (query.reducer) p.set('aggregation.crossSeriesReducer', query.reducer);
      for (const field of query.groupBy ?? []) p.append('aggregation.groupByFields', field);
      p.set('view', 'FULL');

      const merged = new Map<
        string,
        {
          metricLabels: Record<string, string>;
          resourceLabels: Record<string, string>;
          points: Map<number, number>;
        }
      >();
      let pageToken: string | undefined;
      for (let page = 1; ; page++) {
        const url = new URL(base);
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        // Spaces as %20 rather than form-style '+' (a literal '+' is already %2B).
        url.search = url.searchParams.toString().replace(/\+/g, '%20');
        const parsed = Page.safeParse(await googleGetJson(deps, url.toString(), query.projectId));
        if (!parsed.success) {
          throw new SourceError(
            'invalid-response',
            `Cloud Monitoring timeSeries.list returned an unexpected body: ${z.prettifyError(parsed.error).slice(0, 300)}`,
          );
        }
        const errors = parsed.data.executionErrors ?? [];
        if (errors.length > 0) {
          throw new SourceError(
            'unavailable',
            `Cloud Monitoring reported ${errors.length} execution error(s); the data may be incomplete: ${errors[0]?.message ?? 'no message'}`,
          );
        }
        for (const s of parsed.data.timeSeries ?? []) {
          const metricLabels = s.metric?.labels ?? {};
          const resourceLabels = s.resource?.labels ?? {};
          const key = keyOf(metricLabels, resourceLabels);
          let entry = merged.get(key);
          if (!entry) {
            entry = { metricLabels, resourceLabels, points: new Map() };
            merged.set(key, entry);
          }
          for (const point of s.points ?? []) {
            const at = Date.parse(point.interval.endTime);
            const value = numeric(point.value);
            if (!Number.isNaN(at) && value !== undefined) entry.points.set(at, value);
          }
        }
        pageToken = parsed.data.nextPageToken || undefined;
        if (!pageToken) break;
        if (page >= maxPages) {
          throw new SourceError(
            'invalid-response',
            `Cloud Monitoring query for ${query.metricType} needs more than ${maxPages} pages; DCAM stops ` +
              'instead of storing a partial result. Narrow the query (shorter window, longer alignment or a reducer).',
          );
        }
      }
      return [...merged.values()].map((s): MetricSeries => ({
        metricLabels: s.metricLabels,
        resourceLabels: s.resourceLabels,
        points: [...s.points].sort(([a], [b]) => a - b).map(([at, value]) => ({ at, value })),
      }));
    },
  };
}
