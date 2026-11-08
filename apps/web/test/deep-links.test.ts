import { describe, expect, it } from 'vitest';
import {
  airflowBase,
  airflowDagUrl,
  airflowHomeUrl,
  airflowPoolsUrl,
  airflowRunUrl,
  airflowTaskLogUrl,
  composerEnvironmentsUrl,
  composerLogQuery,
  logsExplorerUrl,
  metricsExplorerUrl,
} from '../src/components/deep-links';

const PLACE = { projectId: 'acme-prod-123', location: 'us-central1', environment: 'acme-composer-prod' };
const WINDOW = { from: '2026-11-05T11:00:00.000Z', to: '2026-11-06T11:00:00.000Z' };
const AIRFLOW = 'https://acme-composer-prod.airflow.example';
const RUN = { runId: 'scheduled__2026-11-05T00:00:00+00:00', logicalDate: '2026-11-05T00:00:00.000Z' };

const base = (uri: string) => {
  const b = airflowBase(uri);
  if (!b) throw new Error(`no base for ${uri}`);
  return b;
};

describe('deep links: Cloud console (FR-UI-04)', () => {
  it('FR-UI-04: the Composer environments page and Metrics Explorer of the project', () => {
    expect(composerEnvironmentsUrl(PLACE)).toBe(
      'https://console.cloud.google.com/composer/environments?project=acme-prod-123',
    );
    expect(metricsExplorerUrl(PLACE)).toBe(
      'https://console.cloud.google.com/monitoring/metrics-explorer?project=acme-prod-123',
    );
  });

  it('FR-UI-04: the log query is the Appendix C base filter with the range as a timestamp expression', () => {
    expect(composerLogQuery(PLACE, WINDOW)).toBe(
      [
        'resource.type="cloud_composer_environment"',
        'resource.labels.project_id="acme-prod-123"',
        'resource.labels.location="us-central1"',
        'resource.labels.environment_name="acme-composer-prod"',
        'timestamp>="2026-11-05T11:00:00.000Z"',
        'timestamp<"2026-11-06T11:00:00.000Z"',
      ].join('\n'),
    );
  });

  it("FR-UI-04: a DAG's worker logs add the worker log and the workflow label", () => {
    const query = composerLogQuery(PLACE, WINDOW, { logId: 'airflow-worker', dagId: 'acme_orders_daily' });
    expect(query.split('\n')).toEqual(
      expect.arrayContaining(['log_id("airflow-worker")', 'labels.workflow="acme_orders_daily"']),
    );
  });

  it('FR-UI-04: quotes and backslashes in a value are escaped inside the query string', () => {
    const query = composerLogQuery({ ...PLACE, environment: 'acme "odd" \\ env' }, WINDOW);
    expect(query).toContain('resource.labels.environment_name="acme \\"odd\\" \\\\ env"');
  });

  it('FR-UI-04: Logs Explorer gets the query URL-encoded and the project, nothing else', () => {
    const query = composerLogQuery(PLACE, WINDOW, { logId: 'airflow-worker', dagId: 'acme_orders_daily' });
    const url = logsExplorerUrl(PLACE, query);
    expect(url.startsWith('https://console.cloud.google.com/logs/query;query=')).toBe(true);
    expect(url.endsWith('?project=acme-prod-123')).toBe(true);
    const encoded = url.slice(url.indexOf(';query=') + ';query='.length, url.indexOf('?'));
    // Every reserved character is encoded, so a query can never end the parameter or the path.
    expect(encoded).not.toMatch(/[^A-Za-z0-9\-_.~%]/);
    expect(decodeURIComponent(encoded)).toBe(query);
    expect(encoded).toContain('%0A');
    expect(encoded).toContain('log_id%28%22airflow-worker%22%29');
    expect(url).not.toMatch(/timeRange|cursorTimestamp|storageScope|duration/);
  });

  it('FR-UI-04: a project ID with odd characters is encoded in the project parameter', () => {
    expect(composerEnvironmentsUrl({ ...PLACE, projectId: 'acme prod&x=1' })).toBe(
      'https://console.cloud.google.com/composer/environments?project=acme+prod%26x%3D1',
    );
  });
});

describe('deep links: Airflow UI (FR-UI-04)', () => {
  it('FR-UI-04: the DAGs home page and the pools list', () => {
    expect(airflowHomeUrl(base(AIRFLOW))).toBe(`${AIRFLOW}/home`);
    expect(airflowPoolsUrl(base(AIRFLOW))).toBe(`${AIRFLOW}/pool/list/`);
  });

  it("FR-UI-04: the DAG's grid ends at the range end, rounded up to the second", () => {
    expect(airflowDagUrl(base(AIRFLOW), 'acme_orders_daily', '2026-11-06T11:00:00.250Z')).toBe(
      `${AIRFLOW}/dags/acme_orders_daily/grid?base_date=2026-11-06T11%3A00%3A01Z`,
    );
    expect(airflowDagUrl(base(AIRFLOW), 'acme_orders_daily')).toBe(`${AIRFLOW}/dags/acme_orders_daily/grid`);
  });

  it('FR-UI-04: a run opens selected in the grid, with a run ID that holds + and :', () => {
    const url = new URL(airflowRunUrl(base(AIRFLOW), 'acme_orders_daily', RUN));
    expect(url.pathname).toBe('/dags/acme_orders_daily/grid');
    expect(url.search).toBe(
      '?dag_run_id=scheduled__2026-11-05T00%3A00%3A00%2B00%3A00&base_date=2026-11-05T00%3A00%3A01Z',
    );
    expect(url.searchParams.get('dag_run_id')).toBe(RUN.runId);
  });

  it("FR-UI-04: the grid's base date is one second after the logical date, so the run is in the grid", () => {
    // DCAM keeps milliseconds and Airflow microseconds: 10:15:30.123 may be 10:15:30.123456 in Airflow.
    const url = new URL(
      airflowRunUrl(base(AIRFLOW), 'acme_orders_daily', {
        runId: 'manual__2026-11-05T10:15:30.123456+00:00',
        logicalDate: '2026-11-05T10:15:30.123Z',
      }),
    );
    expect(url.searchParams.get('base_date')).toBe('2026-11-05T10:15:31Z');
  });

  it("FR-UI-04: a task log opens the grid's logs tab for the task in the run", () => {
    const url = new URL(airflowTaskLogUrl(base(AIRFLOW), 'acme_orders_daily', RUN, 'load.orders to bq'));
    expect(url.pathname).toBe('/dags/acme_orders_daily/grid');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      dag_run_id: RUN.runId,
      task_id: 'load.orders to bq',
      tab: 'logs',
      base_date: '2026-11-05T00:00:01Z',
    });
    expect(url.search).toContain('task_id=load.orders+to+bq');
  });

  it('FR-UI-04: IDs in the path are encoded', () => {
    expect(airflowDagUrl(base(AIRFLOW), 'acme orders+daily:v2')).toBe(
      `${AIRFLOW}/dags/acme%20orders%2Bdaily%3Av2/grid`,
    );
  });

  it('FR-UI-04: a base URL with a path, a trailing slash, a query or a fragment keeps only its path', () => {
    const b = base('http://127.0.0.1:8080/airflow/?x=1#top');
    expect(airflowHomeUrl(b)).toBe('http://127.0.0.1:8080/airflow/home');
    expect(airflowDagUrl(b, 'acme_orders_daily')).toBe(
      'http://127.0.0.1:8080/airflow/dags/acme_orders_daily/grid',
    );
  });

  it('FR-UI-04: no link for an address with credentials, another scheme or no address at all', () => {
    expect(airflowBase('https://acme:secret@acme-composer-prod.airflow.example')).toBeNull();
    expect(airflowBase('https://acme@acme-composer-prod.airflow.example')).toBeNull();
    expect(airflowBase('javascript:alert(1)')).toBeNull();
    expect(airflowBase('ftp://acme-composer-prod.airflow.example')).toBeNull();
    expect(airflowBase('not a url')).toBeNull();
    expect(airflowBase('')).toBeNull();
    expect(airflowBase(null)).toBeNull();
    expect(airflowBase(undefined)).toBeNull();
  });
});
