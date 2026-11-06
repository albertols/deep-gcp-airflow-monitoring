import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DagDetail, DagLeague } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { DagDetailPage } from '../src/pages/dags/DagDetailPage';
import { DagsPage } from '../src/pages/dags/DagsPage';
import { DAG_EXPLANATIONS, DETAIL_PANELS, LEAGUE_PANELS } from '../src/pages/dags/explanations';
import { linkTo, type Route } from '../src/router';
import { DETAIL, LEAGUE, row } from './dag-fixtures';

/** Whole-page tests with several interactions: jsdom renders MUI slowly on a loaded machine. */
const UI_TIMEOUT_MS = 30_000;

// jsdom has no layout: give scroll containers a viewport so the virtualiser renders rows.
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
    getBottlenecks: notYet,
    getFindings: notYet,
    getAlerts: notYet,
    getFleet: notYet,
    getCollection: notYet,
    ...overrides,
  };
}

function renderPage(Page: typeof DagsPage, api: DcamApi, route: Route) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigate = vi.fn();
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <Page
          api={api}
          envId="acme-prod"
          route={route}
          linkTo={(r) => linkTo(r, 'acme-prod')}
          navigate={navigate}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { navigate };
}

/** Enters a search term in one change, as a paste does (typing re-renders per key). */
async function search(text: string) {
  await userEvent.click(screen.getByRole('textbox', { name: 'Search DAGs' }));
  await userEvent.paste(text);
}

const leagueRows = () => {
  const table = screen.getByRole('table', { name: 'DAG league table' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).queryByRole('link')?.textContent ?? '')
    .filter(Boolean);
};

describe('S-11 DAG league table page', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-DAGX-03: shows the Pareto, Gini, active DAGs and total slot-hours KPIs', async () => {
    renderPage(DagsPage, fakeApi(), { page: 'dags' });
    expect(await screen.findByText('2 of 4')).toBeInTheDocument();
    expect(screen.getByText('0.41')).toBeInTheDocument();
    expect(screen.getByText('3 of 4')).toBeInTheDocument();
    expect(screen.getByText('33.3')).toBeInTheDocument(); // 120,000 s
    expect(screen.getByText(/compared with the previous 24 h/)).toBeInTheDocument();
  });

  it('FR-DAGX-02: lists every DAG by share, descending, with links to the DAG detail', async () => {
    renderPage(DagsPage, fakeApi(), { page: 'dags' });
    await screen.findByRole('table', { name: 'DAG league table' });
    expect(leagueRows()).toEqual(['orders_daily', 'fraud_scoring_hourly', 'partner_crm_sync', 'idle_export']);
    expect(screen.getByRole('link', { name: 'orders_daily' })).toHaveAttribute(
      'href',
      '#/dags/orders_daily?env=acme-prod',
    );
    const orders = screen.getByRole('link', { name: 'orders_daily' }).closest('tr') as HTMLElement;
    expect(within(orders).getByText('60%')).toBeInTheDocument();
    expect(within(orders).getByText('+10.0 pp')).toBeInTheDocument();
    const partner = screen.getByRole('link', { name: 'partner_crm_sync' }).closest('tr') as HTMLElement;
    expect(within(partner).getByText('new')).toBeInTheDocument();
    expect(within(partner).getByText('≤ 25m')).toBeInTheDocument(); // low-sample p95 shows the max
  });

  it('FR-DAGX-01: sorting by a column header reorders the rows', async () => {
    renderPage(DagsPage, fakeApi(), { page: 'dags' });
    await screen.findByRole('table', { name: 'DAG league table' });
    await userEvent.click(screen.getByRole('button', { name: 'Sort by p95 queue wait' }));
    expect(leagueRows()[0]).toBe('partner_crm_sync');
    expect(screen.getByRole('columnheader', { name: /p95 queue wait/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sort by p95 queue wait' }));
    expect(leagueRows()[0]).toBe('orders_daily');
    expect(leagueRows().at(-1)).toBe('idle_export'); // no data stays last
  });

  it('FR-DAGX-07: presets and filters change the rows, and an empty result says what to do', async () => {
    renderPage(DagsPage, fakeApi(), { page: 'dags' });
    await screen.findByRole('table', { name: 'DAG league table' });
    await userEvent.click(screen.getByRole('button', { name: 'Flaky' }));
    expect(leagueRows()).toEqual(['fraud_scoring_hourly']);
    await userEvent.click(screen.getByRole('button', { name: 'Capacity hogs' }));
    expect(leagueRows()).toEqual(['orders_daily', 'fraud_scoring_hourly']);
    await search('nothing-like-this');
    expect(await screen.findByText(/No DAG matches/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(leagueRows()).toHaveLength(4);
  });

  it('NFR-PERF-03: renders only a window of rows at 5,000 DAGs, and search still finds any DAG', async () => {
    const rows = Array.from({ length: 5_000 }, (_, i) =>
      row(`dag_${String(i).padStart(4, '0')}`, {
        executor_slot_seconds: 5_000 - i,
        share: (5_000 - i) / 12_502_500,
      }),
    );
    renderPage(DagsPage, fakeApi({ getDagLeague: async () => ({ ...LEAGUE, rows, dag_count: 5_000 }) }), {
      page: 'dags',
    });
    const table = await screen.findByRole('table', { name: 'DAG league table' });
    expect(table).toHaveAttribute('aria-rowcount', '5001');
    const rendered = within(table).getAllByRole('row').length;
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(80);
    await search('dag_4999');
    await waitFor(() => expect(leagueRows()).toEqual(['dag_4999']));
  });

  it('FR-DAGX-04: a treemap by team and DAG with a legend, a description and a table view', async () => {
    renderPage(DagsPage, fakeApi(), { page: 'dags' });
    const map = await screen.findByRole('group', { name: 'Capacity by team and DAG' });
    expect(map).toHaveAccessibleDescription(/3 teams and 3 DAGs/);
    expect(within(map).getByRole('link', { name: /^orders_daily/ })).toHaveAttribute(
      'href',
      '#/dags/orders_daily?env=acme-prod',
    );
    const legend = screen.getByRole('list', { name: 'Treemap colours' });
    expect(within(legend).getByText('5 min or more')).toBeInTheDocument();
    await userEvent.click(within(map).getByRole('button', { name: 'Filter to team ml-platform' }));
    expect(leagueRows()).toEqual(['fraud_scoring_hourly']);
    await userEvent.click(screen.getByRole('button', { name: 'View treemap as table' }));
    const table = screen.getByRole('table', { name: 'Capacity by team and DAG' });
    expect(within(table).getByText('fraud_scoring_hourly')).toBeInTheDocument();
  });

  it('FR-DAGX-02: exports the filtered rows as CSV', async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return 'blob:dcam';
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderPage(DagsPage, fakeApi(), { page: 'dags' });
    await screen.findByRole('table', { name: 'DAG league table' });
    await userEvent.click(screen.getByRole('button', { name: 'Flaky' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(click).toHaveBeenCalled();
    const text = await created[0]?.text();
    expect(text?.split('\r\n').filter(Boolean)).toHaveLength(2);
    expect(text).toContain('fraud_scoring_hourly');
    click.mockRestore();
  });

  it('FR-UI-05 / FR-UI-08: every KPI, panel and column has an explanation; provenance is shown', async () => {
    for (const id of LEAGUE_PANELS) expect(DAG_EXPLANATIONS[id], id).toBeDefined();
    renderPage(DagsPage, fakeApi(), { page: 'dags' });
    await screen.findByRole('table', { name: 'DAG league table' });
    const titles = new Set(LEAGUE_PANELS.map((id) => DAG_EXPLANATIONS[id].title));
    const about = screen.getAllByRole('button', { name: /^About / }).map((b) => b.getAttribute('aria-label'));
    for (const title of titles) expect(about, title).toContain(`About ${title}`);
    expect(
      screen.getByText(
        (_t, el) => el?.tagName === 'FOOTER' && /Data as of .* Source: demo data/.test(el.textContent ?? ''),
      ),
    ).toBeInTheDocument();
  });

  it('FR-UI-07: says what to do when the environment has no DAGs yet', async () => {
    renderPage(
      DagsPage,
      fakeApi({
        getDagLeague: async (): Promise<DagLeague> => ({
          ...LEAGUE,
          rows: [],
          dag_count: 0,
          active_dag_count: 0,
          pareto_80_dag_count: 0,
          total_executor_slot_seconds: 0,
          gini: 0,
        }),
      }),
      { page: 'dags' },
    );
    expect(await screen.findByText(/No DAGs are known in this environment yet/)).toBeInTheDocument();
  });
});

describe('S-12 DAG detail page', { timeout: UI_TIMEOUT_MS }, () => {
  const route: Route = { page: 'dag', dagId: 'orders_daily' };

  it('FR-DAGD-01: header with file, schedule, owners, tags and every limit that can throttle the DAG', async () => {
    renderPage(DagDetailPage, fakeApi(), route);
    expect(await screen.findByRole('heading', { level: 1, name: 'orders_daily' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /DAG league table/ })).toHaveAttribute(
      'href',
      '#/dags?env=acme-prod',
    );
    const limits = await screen.findByRole('table', { name: 'Limits that can throttle this DAG' });
    for (const text of [
      'max_active_tasks',
      'max_active_runs',
      'Pool etl',
      'parallelism × schedulers',
      'Worker slots',
    ])
      expect(within(limits).getByText(new RegExp(text))).toBeInTheDocument();
    expect(within(limits).getByText('2 of 24 slots per task')).toBeInTheDocument();
    expect(within(limits).getByText('192')).toBeInTheDocument();
    expect(within(limits).getByText('72')).toBeInTheDocument();
    expect(screen.getByText('/home/airflow/gcs/dags/finance-data/orders_daily.py')).toBeInTheDocument();
    expect(screen.getByText('finance-data-oncall')).toBeInTheDocument();
  });

  it('HM-032: a limit DCAM does not know says so instead of showing a number', async () => {
    const unknown: DagDetail = {
      ...DETAIL,
      meta: { ...DETAIL.meta, limits: { ...DETAIL.meta.limits, parallelism: null, worker_slots: null } },
    };
    renderPage(DagDetailPage, fakeApi({ getDagDetail: async () => unknown }), route);
    const limits = await screen.findByRole('table', { name: 'Limits that can throttle this DAG' });
    expect(within(limits).getAllByText('Not known yet')).toHaveLength(2);
    expect(within(limits).getAllByText(/no override in the Composer configuration/i)).toHaveLength(2);
  });

  it('FR-DAGD-02 / HM-005: KPIs and a runs timeline whose runs can be shown in the Gantt', async () => {
    const getDagDetail = vi.fn(async (): Promise<DagDetail> => DETAIL);
    renderPage(DagDetailPage, fakeApi({ getDagDetail }), route);
    expect(await screen.findByText('42%')).toBeInTheDocument(); // self-throttled
    expect(screen.getByText('≤ 40m')).toBeInTheDocument(); // low-sample p95 run duration
    const timeline = screen.getByRole('radiogroup', { name: 'Runs' });
    expect(within(timeline).getAllByRole('radio')).toHaveLength(2);
    expect(within(timeline).getByRole('radio', { checked: true })).toHaveAccessibleName(/failed/);
    await userEvent.click(within(timeline).getByRole('radio', { name: /10:00/ }));
    await waitFor(() =>
      expect(getDagDetail).toHaveBeenLastCalledWith(
        'acme-prod',
        'orders_daily',
        '24h',
        DETAIL.runs[0]?.run_id,
      ),
    );
  });

  it('HM-002: the runs table labels a start delay not measured from the data interval end', async () => {
    const [first, second] = DETAIL.runs as [DagDetail['runs'][number], DagDetail['runs'][number]];
    const runs: DagDetail['runs'] = [
      { ...first, start_delay_seconds: 602, start_delay_basis: 'logical_date' },
      { ...second, start_delay_seconds: null, start_delay_basis: 'not_scheduled' },
    ];
    renderPage(DagDetailPage, fakeApi({ getDagDetail: async () => ({ ...DETAIL, runs }) }), route);
    await userEvent.click(await screen.findByRole('button', { name: 'View runs as table' }));
    const table = screen.getByRole('table', { name: 'Runs' });
    expect(within(table).getByRole('row', { name: /10:00/ })).toHaveTextContent('10m 2s from logical date');
    expect(within(table).getByRole('row', { name: /11:02/ })).toHaveTextContent('Not a scheduled run');
  });

  it('FR-DAGD-03: the Gantt draws pre-queue wait, queue wait and running in distinct styles with a legend', async () => {
    renderPage(DagDetailPage, fakeApi(), route);
    const gantt = await screen.findByRole('img', {
      name: /Gantt of run scheduled__2026-11-05T11:00:00\+00:00/,
    });
    expect(gantt).toHaveAccessibleDescription(/2 tries/);
    const legend = screen.getByRole('list', { name: 'Gantt legend' });
    for (const label of [
      'Ready, waiting to be queued',
      'Queued, waiting for a worker',
      'Running',
      'Failed try',
    ])
      expect(within(legend).getByText(label)).toBeInTheDocument();
    const fills = new Set(
      ['pre-queue', 'queued', 'running'].map((kind) =>
        gantt.querySelector(`[data-segment="${kind}"]`)?.getAttribute('fill'),
      ),
    );
    expect(fills.size).toBe(3);
    await userEvent.click(screen.getByRole('button', { name: 'View Gantt as table' }));
    expect(screen.getByRole('table', { name: /Gantt of run/ })).toBeInTheDocument();
  });

  it('FR-DAGD-04: per-task table sorted by contribution to run duration', async () => {
    renderPage(DagDetailPage, fakeApi(), route);
    const table = await screen.findByRole('table', { name: 'Tasks' });
    const first = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(within(first).getByText('load')).toBeInTheDocument();
    expect(within(first).getByText('25m')).toBeInTheDocument();
    expect(within(first).getByText('70%')).toBeInTheDocument();
  });

  it('FR-UI-05: every KPI, panel and column on the detail page has an explanation', async () => {
    for (const id of DETAIL_PANELS) expect(DAG_EXPLANATIONS[id], id).toBeDefined();
    renderPage(DagDetailPage, fakeApi(), route);
    await screen.findByRole('table', { name: 'Tasks' });
    const about = screen.getAllByRole('button', { name: /^About / }).map((b) => b.getAttribute('aria-label'));
    for (const id of DETAIL_PANELS) expect(about, id).toContain(`About ${DAG_EXPLANATIONS[id].title}`);
  });

  it('FR-UI-07: an unknown DAG says what to do next', async () => {
    renderPage(
      DagDetailPage,
      fakeApi({ getDagDetail: () => Promise.reject(new Error('No DAG "x" is known')) }),
      route,
    );
    expect(await screen.findByText(/No DAG "x" is known/)).toBeInTheDocument();
  });
});
