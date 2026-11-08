import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterEach, describe, expect, it } from 'vitest';
import type { EnvironmentOverview, Meta } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { App } from '../src/App';
import { EnvironmentPlaceContext } from '../src/components/OpenInMenu';
import { DagDetailPage } from '../src/pages/dags/DagDetailPage';
import { linkTo } from '../src/router';
import { DETAIL } from './dag-fixtures';

const PLACE = {
  composer: { project_id: 'acme-prod-123', location: 'us-central1', environment: 'acme-composer-prod' },
  airflow_uri: 'https://acme-composer-prod.airflow.example',
};
const AIRFLOW = PLACE.airflow_uri;
const meta: Meta = {
  name: 'DCAM',
  version: '0.0.0',
  mode: 'demo',
  environments: [
    { env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod', ...PLACE },
    { env_id: 'acme-dev', display_name: 'acme-dev', tier: 'dev', airflow_uri: 'http://127.0.0.1:8080' },
  ],
};
const overview: EnvironmentOverview = {
  env_id: 'acme-prod',
  range: { from: '2026-11-04T12:00:00.000Z', to: '2026-11-05T12:00:00.000Z' },
  data_as_of: '2026-11-05T12:00:00.000Z',
  sources: ['DEMO'],
  approximate: false,
  total_executor_slot_seconds: 36_000,
  peak_concurrency: 42,
  dag_count: 120,
  active_dag_count: 64,
  pareto_80_dag_count: 23,
  top_dags: [{ dag_id: 'acme_orders_daily', executor_slot_seconds: 7_200, share: 0.2 }],
};
const notYet = () => Promise.reject(new Error('not in this test'));
const api: DcamApi = {
  getMeta: async () => meta,
  getOverview: async () => overview,
  getDagLeague: notYet,
  getDagDetail: async () => DETAIL,
  getBottlenecks: notYet,
  getSchedule: notYet,
  getFindings: notYet,
  getAlerts: notYet,
  getFleet: notYet,
  getCollection: notYet,
};
afterEach(() => {
  window.location.hash = '';
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const hrefOf = (menu: HTMLElement, name: RegExp) =>
  within(menu).getByRole('menuitem', { name }).getAttribute('href');

describe('"Open in" on the pages (FR-UI-04)', () => {
  it('FR-UI-04: the overview opens the selected environment over the range of its data, with the demo note', async () => {
    render(
      <ThemeProvider theme={createDcamTheme('dark')}>
        <QueryClientProvider client={client()}>
          <App api={api} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Open in' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Demo data/ })).toBeInTheDocument();
    expect(hrefOf(menu, /^DAGs/)).toBe(`${AIRFLOW}/home`);
    const logs = decodeURIComponent(hrefOf(menu, /Logs Explorer: environment logs/) ?? '');
    expect(logs).toContain('resource.labels.environment_name="acme-composer-prod"');
    expect(logs).toContain('timestamp>="2026-11-04T12:00:00.000Z"');
    expect(logs).toContain('timestamp<"2026-11-05T12:00:00.000Z"');
  });

  it('FR-UI-04: another environment of the shell has its own place: a self-managed Airflow', async () => {
    window.location.hash = '#/?env=acme-dev';
    render(
      <ThemeProvider theme={createDcamTheme('dark')}>
        <QueryClientProvider client={client()}>
          <App api={api} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Open in' }));
    const menu = await screen.findByRole('menu');
    expect(hrefOf(menu, /^DAGs/)).toBe('http://127.0.0.1:8080/home');
    expect(
      within(menu).getByText(/self-managed Airflow, so it has no Cloud console pages/),
    ).toBeInTheDocument();
  });

  function renderDetail(pageApi: DcamApi = api) {
    render(
      <ThemeProvider theme={createDcamTheme('dark')}>
        <QueryClientProvider client={client()}>
          <EnvironmentPlaceContext.Provider value={{ mode: 'live', place: PLACE }}>
            <DagDetailPage
              api={pageApi}
              envId="acme-prod"
              route={{ page: 'dag', dagId: 'orders_daily' }}
              linkTo={(r) => linkTo(r, 'acme-prod')}
              navigate={() => {}}
            />
          </EnvironmentPlaceContext.Provider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
  }

  it('FR-UI-04: the DAG page opens its grid to the range end and the run shown in the Gantt chart', async () => {
    renderDetail();
    await screen.findByRole('table', { name: 'Tasks' });
    await userEvent.click(screen.getByRole('button', { name: 'Open in' }));
    const menu = await screen.findByRole('menu');
    expect(hrefOf(menu, /^DAG grid/)).toBe(
      `${AIRFLOW}/dags/orders_daily/grid?base_date=2026-11-05T12%3A00%3A00Z`,
    );
    const run = new URL(hrefOf(menu, /^Selected run/) ?? '');
    expect(run.searchParams.get('dag_run_id')).toBe('scheduled__2026-11-05T11:00:00+00:00');
    expect(decodeURIComponent(hrefOf(menu, /Logs Explorer: DAG worker logs/) ?? '')).toContain(
      'labels.workflow="orders_daily"',
    );
  });

  it("FR-UI-04: a task row opens the task's log in the selected run and its worker logs while it ran", async () => {
    renderDetail();
    const table = await screen.findByRole('table', { name: 'Tasks' });
    expect(within(table).getByRole('button', { name: /^About Open in/ })).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: 'Open in: load' }));
    const menu = await screen.findByRole('menu');
    const log = new URL(hrefOf(menu, /^Task log/) ?? '');
    expect(Object.fromEntries(log.searchParams)).toEqual({
      dag_run_id: 'scheduled__2026-11-05T11:00:00+00:00',
      task_id: 'load',
      tab: 'logs',
      base_date: '2026-11-05T11:00:01Z',
    });
    // The load try ran 11:13 to 11:20 in the selected run.
    const logs = decodeURIComponent(hrefOf(menu, /Logs Explorer: task worker logs/) ?? '');
    expect(logs).toContain('timestamp>="2026-11-05T11:12:00.000Z"');
    expect(logs).toContain('timestamp<"2026-11-05T11:21:00.000Z"');
  });

  it('FR-UI-04: a run with a custom run ID, whose first start stands in for its logical date, says so', async () => {
    // The server sends the first start as the logical date when the run ID carries none (dags.ts).
    const custom = {
      ...DETAIL.runs[1]!,
      run_id: 'acme_rerun_2026_11_05',
      logical_date: DETAIL.runs[1]!.start,
    };
    renderDetail({
      ...api,
      getDagDetail: async () => ({
        ...DETAIL,
        runs: [DETAIL.runs[0]!, custom],
        gantt: { ...DETAIL.gantt, run_id: custom.run_id },
      }),
    });
    await screen.findByRole('table', { name: 'Tasks' });
    await userEvent.click(screen.getByRole('button', { name: 'Open in' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /^Selected run/ })).toHaveTextContent(
      /does not know the logical date of this run/,
    );
  });
});
