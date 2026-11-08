import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import type { ComponentType } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AlertEvent, AlertRule, Alerts, Meta, Range, RunComparison } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { DEFAULT_PAGE_VIEW, PageParamsContext, ViewContext } from '../src/components/view';
import { AlertsPage } from '../src/pages/alerts/AlertsPage';
import { CapacityPage } from '../src/pages/capacity/CapacityPage';
import { CompareDagsPage } from '../src/pages/compare/CompareDagsPage';
import { DagDetailPage } from '../src/pages/dags/DagDetailPage';
import { DagsPage } from '../src/pages/dags/DagsPage';
import type { PageProps } from '../src/pages/types';
import { linkTo, type PageParams, type Route } from '../src/router';
import { capacityFixture, forecastFixture } from './capacity-fixtures';
import { COMPARISON, RUN_COMPARISON } from './dag-compare-fixtures';
import { DETAIL, LEAGUE } from './dag-fixtures';

/** Whole-page tests: jsdom renders MUI slowly on a loaded machine. */
const UI_TIMEOUT_MS = 30_000;

// jsdom has no layout: give scroll containers a viewport so the virtualised league renders its rows.
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 560 });
});
afterAll(() => {
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
});

const notYet = () => Promise.reject(new Error('not in this test'));
function fakeApi(overrides: Partial<DcamApi> = {}): DcamApi {
  return {
    getMeta: notYet,
    getOverview: notYet,
    getDagLeague: async () => LEAGUE,
    getDagDetail: async () => DETAIL,
    getDagComparison: notYet,
    getCapacity: notYet,
    getForecast: notYet,
    getRunComparison: notYet,
    getBottlenecks: notYet,
    getSchedule: notYet,
    getFindings: notYet,
    getAlerts: notYet,
    getFleet: notYet,
    getCollection: notYet,
    ...overrides,
  };
}

/** Renders a page with fixed page parameters, as a shared link with filters and sort opens it. */
function renderPage(
  Page: ComponentType<PageProps>,
  api: DcamApi,
  route: Route,
  params: PageParams = {},
  range: Range = '24h',
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <ViewContext.Provider value={{ ...DEFAULT_PAGE_VIEW, range }}>
          <PageParamsContext.Provider value={{ params, set: () => {} }}>
            <Page
              api={api}
              envId="acme-prod"
              route={route}
              linkTo={(r) => linkTo(r, 'acme-prod')}
              navigate={vi.fn()}
            />
          </PageParamsContext.Provider>
        </ViewContext.Provider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

interface Download {
  readonly name: string;
  readonly text: string;
}

/** Captures what the export buttons save: the file name and the text of each blob. */
function captureDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  Object.assign(URL, {
    createObjectURL: vi.fn((b: Blob) => {
      blobs.push(b);
      return `blob:dcam/${blobs.length}`;
    }),
    revokeObjectURL: vi.fn(),
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return {
    async files(): Promise<Download[]> {
      return Promise.all(blobs.map(async (b, i) => ({ name: names[i] ?? '', text: await b.text() })));
    },
    restore: () => click.mockRestore(),
  };
}
let downloads: ReturnType<typeof captureDownloads>;
afterEach(() => downloads?.restore());

/** A small RFC 4180 reader for the tests: quoted fields, doubled quotes, CRLF records. */
function parseCsv(text: string): { header: string[]; records: string[][] } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i++;
    } else field += c;
  }
  const [header = [], ...rest] = records;
  return { header, records: rest };
}

/** One column of a CSV file by its header name. */
function csvColumn(text: string, name: string): string[] {
  const { header, records } = parseCsv(text);
  const at = header.indexOf(name);
  if (at === -1) throw new Error(`no column ${name} in ${header.join(',')}`);
  return records.map((r) => r[at] ?? '');
}

const bodyRows = (name: string) =>
  within(screen.getByRole('table', { name }))
    .getAllByRole('row')
    .filter((r) => within(r).queryAllByRole('cell').length > 0);

/** The text of one cell in each body row of a rendered table. */
const tableColumn = (name: string, cellIndex: number): string[] =>
  bodyRows(name).map((r) => within(r).getAllByRole('cell')[cellIndex]?.textContent ?? '');

/** The first link of each body row (DAG IDs link to the DAG). */
const linkColumn = (name: string): string[] =>
  bodyRows(name).map((r) => within(r).queryAllByRole('link')[0]?.textContent ?? '');

async function exportCsv(what: string): Promise<Download> {
  await userEvent.click(screen.getByRole('button', { name: `Export CSV, ${what}` }));
  const files = await downloads.files();
  const file = files.at(-1);
  if (!file) throw new Error('nothing was downloaded');
  return file;
}

describe('FR-STORE-04 the export equals the filtered view', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-STORE-04: the DAG league exports its filtered, sorted rows in their order', async () => {
    downloads = captureDownloads();
    renderPage(DagsPage, fakeApi(), { page: 'dags' }, { tag: 'hourly', sort: 'dag_id.desc' });
    await screen.findByRole('table', { name: 'DAG league table' });
    const shown = linkColumn('DAG league table');
    expect(shown).toEqual(['partner_crm_sync', 'fraud_scoring_hourly']);

    const file = await exportCsv('DAG league table');
    expect(file.name).toBe('dcam-dags-acme-prod-24h-2026-11-05T1200Z.csv');
    expect(csvColumn(file.text, 'dag_id')).toEqual(shown);
    // Machine-readable values, not the table's formatted text.
    expect(csvColumn(file.text, 'executor_slot_seconds')).toEqual(['12000', '36000']);
    expect(csvColumn(file.text, 'share_ratio')).toEqual(['0.1', '0.3']);
    expect(csvColumn(file.text, 'run_duration_p95_seconds')).toEqual(['1500', '900']);
    expect(csvColumn(file.text, 'run_duration_p95_low_sample')).toEqual(['true', 'false']);
  });

  it('FR-STORE-04: alert rules and alert history export their filtered rows, in order', async () => {
    downloads = captureDownloads();
    renderPage(
      AlertsPage,
      fakeApi({ getMeta: async () => META, getAlerts: async () => ALERTS }),
      {
        page: 'alerts',
      },
      { state: 'firing', event: 'fired' },
    );
    await screen.findByRole('table', { name: 'Alert rules' });
    const rules = tableColumn('Alert rules', 1).map((text) => text.slice(0, 5));
    expect(rules).toEqual(['AL-15', 'AL-19']);
    const rulesFile = await exportCsv('Alert rules');
    expect(rulesFile.name).toBe('dcam-alert-rules-acme-prod-24h-2026-11-05T1159Z.csv');
    expect(csvColumn(rulesFile.text, 'rule_id')).toEqual(rules);
    expect(csvColumn(rulesFile.text, 'value')).toEqual(['34.5', '3']);
    expect(csvColumn(rulesFile.text, 'since_utc')).toEqual([
      '2026-11-05T11:40:00.000Z',
      '2026-11-05T12:00:00.000Z',
    ]);

    const history = tableColumn('Alert history', 2);
    expect(history).toEqual(['AL-19', 'AL-15', 'AL-15']);
    const historyFile = await exportCsv('Alert history');
    expect(csvColumn(historyFile.text, 'rule_id')).toEqual(history);
    expect(csvColumn(historyFile.text, 'kind')).toEqual(['fired', 'fired', 'fired']);
    expect(csvColumn(historyFile.text, 'at_utc')[0]).toBe('2026-11-05T12:00:00.000Z');
  });

  it('FR-STORE-04: the DAG tasks and runs export the rows their tables show', async () => {
    downloads = captureDownloads();
    renderPage(DagDetailPage, fakeApi(), { page: 'dag', dagId: 'orders_daily' }, { runs: 'table' });
    await screen.findByRole('table', { name: 'Tasks' });
    const tasks = tableColumn('Tasks', 0);
    expect(tasks).toEqual(['load', 'extract']);
    const tasksFile = await exportCsv('Tasks');
    expect(tasksFile.name).toBe('dcam-dag-orders_daily-tasks-acme-prod-24h-2026-11-05T1200Z.csv');
    expect(csvColumn(tasksFile.text, 'task_id')).toEqual(tasks);
    expect(csvColumn(tasksFile.text, 'duration_p95_seconds')).toEqual(['1800', '600']);
    expect(csvColumn(tasksFile.text, 'duration_p95_low_sample')).toEqual(['true', 'true']);
    expect(csvColumn(tasksFile.text, 'failure_rate_ratio')).toEqual(['', '']);

    // The runs table lists the latest run first; so does its file.
    const runsFile = await exportCsv('Runs');
    expect(csvColumn(runsFile.text, 'start_utc')).toEqual([
      '2026-11-05T11:02:00.000Z',
      '2026-11-05T10:00:05.000Z',
    ]);
    expect(csvColumn(runsFile.text, 'duration_seconds')).toEqual(['1080', '2400']);
  });
});

describe(
  'FR-STORE-04 the capacity, compare and DAG detail tables export their rows',
  { timeout: UI_TIMEOUT_MS },
  () => {
    it('FR-STORE-04: the capacity tab exports the rows of its tables, named after the range it covers', async () => {
      downloads = captureDownloads();
      const api = fakeApi({
        getCapacity: async () => capacityFixture,
        getForecast: async () => forecastFixture,
      });
      // 30 days in the context bar: the page covers 7 days, and so do its files.
      renderPage(CapacityPage, api, { page: 'capacity' }, { slots: 'table' }, '30d');
      await screen.findByRole('table', { name: 'Worker slots per bucket' });

      const shownBuckets = tableColumn('Worker slots per bucket', 0);
      expect(shownBuckets).toHaveLength(96);
      const slots = await exportCsv('Worker slots per bucket');
      expect(slots.name).toBe('dcam-capacity-slots-acme-prod-7d-2026-11-05T1159Z.csv');
      expect(csvColumn(slots.text, 'bucket_start_utc')).toEqual(capacityFixture.series.map((b) => b.start));
      expect(csvColumn(slots.text, 'worker_slots_mean').slice(0, 2)).toEqual(['36', '36']);
      expect(csvColumn(slots.text, 'capacity_bound_minutes')).toContain('15');

      // Capacity-bound periods: newest first, as the table lists them.
      const periods = await exportCsv('Capacity-bound periods');
      expect(tableColumn('Capacity-bound periods', 0)).toEqual(['5 Nov, 02:03', '4 Nov, 19:00']);
      expect(csvColumn(periods.text, 'start_utc')).toEqual([
        '2026-11-05T02:03:00.000Z',
        '2026-11-04T19:00:00.000Z',
      ]);
      expect(csvColumn(periods.text, 'length_minutes')).toEqual(['52', '13']);

      // A pool without snapshots has empty cells, never 0.
      const pools = await exportCsv('Pool slots');
      expect(csvColumn(pools.text, 'pool')).toEqual(linkless('Pool slots'));
      expect(csvColumn(pools.text, 'starved_minutes')).toEqual(['0', '35', '']);
      expect(csvColumn(pools.text, 'running_slots_mean')).toEqual(['20', '10', '']);
    });

    it('FR-STORE-04: a compare table exports one record per DAG it shows, in its order', async () => {
      downloads = captureDownloads();
      const api = fakeApi({ getMeta: async () => META_TWO, getDagComparison: async () => COMPARISON });
      renderPage(CompareDagsPage, api, { page: 'compare-dags' }, { dags: DAGS });
      await screen.findByRole('table', { name: 'Resource shares' });

      const shown = linkColumn('Resource shares');
      expect(shown).toEqual(['logistics_export', 'logistics_export']);
      const file = await exportCsv('Resource shares');
      expect(file.name).toBe('dcam-compare-resources-24h-2026-11-05T1200Z.csv');
      expect(csvColumn(file.text, 'dag_id')).toEqual(shown);
      expect(csvColumn(file.text, 'env_id')).toEqual(tableColumn('Resource shares', 1));
      expect(csvColumn(file.text, 'executor_slot_seconds')).toEqual(['199800', '10036']);
      expect(csvColumn(file.text, 'share_ratio')).toEqual(['0.054', '0.0093']);

      // The KPI table has a column per DAG; its file has a record per DAG, with units in the names.
      const kpis = await exportCsv('Aligned KPIs');
      expect(csvColumn(kpis.text, 'env_id')).toEqual(['acme-prod', 'acme-test']);
      expect(csvColumn(kpis.text, 'run_duration_p95_seconds')).toEqual(['3742', '1370']);
      expect(csvColumn(kpis.text, 'run_duration_p95_low_sample')).toEqual(['false', 'true']);
      expect(csvColumn(kpis.text, 'flaky_rate_ratio')).toEqual(['0.014', '']);
    });

    it('FR-STORE-04: the run comparison exports the tasks it shows: the first 25, or all of them', async () => {
      downloads = captureDownloads();
      const many = manyTasks(30);
      renderPage(DagDetailPage, fakeApi({ getRunComparison: async () => many }), {
        page: 'dag',
        dagId: 'orders_daily',
      });
      const name = 'Tasks by contribution to the duration difference';
      await screen.findByRole('table', { name });
      const first = tableColumn(name, 1);
      expect(first).toHaveLength(25);
      const file = await exportCsv(name);
      expect(file.name).toBe('dcam-dag-orders_daily-run-comparison-acme-prod-24h-2026-11-05T1200Z.csv');
      expect(csvColumn(file.text, 'task_id')).toEqual(first);
      expect(csvColumn(file.text, 'rank')).toEqual(tableColumn(name, 0));
      expect(csvColumn(file.text, 'contribution_seconds')[0]).toBe('660');
      // `cleanup` did not run in B: its B values are empty, never 0.
      const at = first.indexOf('cleanup');
      expect(csvColumn(file.text, 'duration_b_seconds')[at]).toBe('');
      expect(csvColumn(file.text, 'duration_delta_seconds')[at]).toBe('');

      await userEvent.click(screen.getByRole('button', { name: 'Show all 30 tasks' }));
      const all = tableColumn(name, 1);
      expect(all).toHaveLength(30);
      expect(csvColumn((await exportCsv(name)).text, 'task_id')).toEqual(all);
    });
  },
);

/** The text of the first cell of each body row, for tables whose first column is not a link. */
const linkless = (name: string): string[] => tableColumn(name, 0);

const DAGS = 'acme-prod:logistics_export,acme-test:logistics_export';
const META_TWO: Meta = {
  name: 'DCAM',
  version: '0.0.0',
  mode: 'demo',
  environments: [
    { env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' },
    { env_id: 'acme-test', display_name: 'acme-test', tier: 'test' },
  ],
};

/** The fixture's four tasks, then `n − 4` more with smaller contributions, in the server's order. */
function manyTasks(n: number): RunComparison {
  const extra = Array.from({ length: n - RUN_COMPARISON.tasks.length }, (_, i) => ({
    ...(RUN_COMPARISON.tasks[1] as RunComparison['tasks'][number]),
    task_id: `acme_step_${String(i + 1).padStart(2, '0')}`,
  }));
  return { ...RUN_COMPARISON, tasks: [...RUN_COMPARISON.tasks, ...extra] };
}

const T = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 5, h, m)).toISOString();
const META: Meta = {
  name: 'DCAM',
  version: '0.0.0',
  mode: 'demo',
  environments: [{ env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' }],
};
const rule = (id: string, p: Partial<AlertRule>): AlertRule => ({
  id,
  name: `Rule ${id}`,
  env_id: 'acme-prod',
  severity: 'warning',
  state: 'inactive',
  condition: 'A condition',
  for_seconds: 0,
  threshold: null,
  value: null,
  unit: '',
  since: null,
  summary: 'A summary.',
  runbook: null,
  export_cloud_monitoring: 'no',
  fired_count_24h: 0,
  ...p,
});
const event = (id: string, rule_id: string, kind: AlertEvent['kind'], at: string): AlertEvent => ({
  id,
  rule_id,
  env_id: 'acme-prod',
  severity: 'warning',
  kind,
  at,
  value: 1,
});
const ALERTS: Alerts = {
  data_as_of: T(11, 59),
  sources: ['DEMO'],
  rules: [
    rule('AL-01', { value: 99, unit: '%', threshold: 90 }),
    rule('AL-05', { state: 'pending', value: 14, since: T(11, 52) }),
    rule('AL-15', { state: 'firing', value: 34.5, unit: 'min', since: T(11, 40), fired_count_24h: 2 }),
    rule('AL-19', { state: 'firing', value: 3, unit: 'restarts', since: T(12), fired_count_24h: 1 }),
  ],
  events: [
    event('e4', 'AL-19', 'fired', T(12)),
    event('e3', 'AL-15', 'fired', T(11, 40)),
    event('e2', 'AL-15', 'resolved', T(9, 30)),
    event('e1', 'AL-15', 'fired', T(8, 0)),
  ],
};
