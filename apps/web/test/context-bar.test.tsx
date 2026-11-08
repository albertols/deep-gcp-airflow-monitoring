import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CollectionEnvironment,
  CollectorStatus,
  EnvironmentOverview,
  Meta,
  Range,
} from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { App } from '../src/App';
import { freshnessOf } from '../src/components/ContextBar';
import { DETAIL, LEAGUE } from './dag-fixtures';

/** Whole-app tests with several interactions: jsdom renders MUI slowly on a loaded machine. */
const UI_TIMEOUT_MS = 30_000;

// jsdom has no layout: give scroll containers a viewport so the virtualised league renders rows.
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 560 });
});
afterAll(() => {
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
});
afterEach(() => {
  window.location.hash = '';
});

const META: Meta = {
  name: 'DCAM',
  version: '0.0.0',
  mode: 'demo',
  environments: [
    { env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' },
    { env_id: 'acme-dev', display_name: 'acme-dev', tier: 'dev' },
  ],
};
const DAY = 86_400_000;
const AS_OF = '2026-11-05T12:00:00.000Z';

/** A different answer per range, so each panel shows which range it was drawn from. */
function overviewFor(envId: string, range: Range): EnvironmentOverview {
  const days = range === '7d' ? 7 : 1;
  return {
    env_id: envId,
    range: { from: new Date(Date.parse(AS_OF) - days * DAY).toISOString(), to: AS_OF },
    coverage: 1,
    data_as_of: AS_OF,
    sources: ['DEMO'],
    approximate: false,
    total_executor_slot_seconds: 36_000 * days,
    peak_concurrency: 40 + days,
    dag_count: 120,
    active_dag_count: 64,
    pareto_80_dag_count: 20 + days,
    top_dags: [
      {
        dag_id: range === '7d' ? 'acme_weekly_rollup' : 'acme_orders_daily',
        executor_slot_seconds: 7_200,
        share: 0.2,
      },
    ],
  };
}

const reject = () => Promise.reject(new Error('not in this test'));
function fakeApi() {
  const api = {
    getMeta: vi.fn(async () => META),
    getOverview: vi.fn(async (envId: string, range: Range) => overviewFor(envId, range)),
    getDagLeague: vi.fn(async () => LEAGUE),
    getDagDetail: vi.fn(async () => DETAIL),
    getBottlenecks: vi.fn(reject),
    getFindings: vi.fn(reject),
    getAlerts: vi.fn(reject),
    getFleet: vi.fn(reject),
    getCollection: vi.fn(reject),
    getSchedule: vi.fn(reject),
  } satisfies DcamApi;
  return api;
}

function renderApp(api: DcamApi, { pollMs }: { pollMs?: number } = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, ...(pollMs ? { refetchInterval: pollMs, staleTime: 0 } : {}) },
    },
  });
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <App api={api} localTimeZone="Asia/Kolkata" />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return client;
}

const hashQuery = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');
const bar = () => screen.getByRole('group', { name: 'Context' });

async function pickRange(label: string) {
  await userEvent.click(within(bar()).getByRole('combobox', { name: 'Time range' }));
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

describe('FR-UI-01 global context bar', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-UI-01: shows the environment, the range presets from 15 minutes to 90 days, the time zone, updates and freshness', async () => {
    renderApp(fakeApi());
    await screen.findByText('10.0');
    const context = bar();
    expect(within(context).getByRole('combobox', { name: 'Environment' })).toHaveTextContent('acme-prod');
    expect(within(context).getByRole('combobox', { name: 'Time range' })).toHaveTextContent('Last 24 hours');
    expect(within(context).getByRole('button', { name: 'UTC' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(context).getByRole('button', { name: 'Local (GMT+5:30)' })).toBeInTheDocument();
    expect(within(context).getByRole('button', { name: 'Pause updates' })).toBeInTheDocument();
    expect(within(context).getByRole('status')).toHaveTextContent('Data as of 5 Nov, 12:00:00 UTC');

    await userEvent.click(within(context).getByRole('combobox', { name: 'Time range' }));
    const options = within(await screen.findByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Last 15 minutes',
      'Last hour',
      'Last 6 hours',
      'Last 24 hours',
      'Last 7 days',
      'Last 30 days',
      'Last 90 days',
    ]);
  });

  it('FR-UI-01: a range change refetches every panel of the page with the new range', async () => {
    const api = fakeApi();
    renderApp(api);
    expect(await screen.findByText('10.0')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Time range' })).toBeNull(); // no range control of its own

    await pickRange('Last 7 days');
    await waitFor(() => expect(api.getOverview).toHaveBeenLastCalledWith('acme-prod', '7d'));
    // Every panel shows the 7-day answer: the three KPIs, the table and the footer.
    expect(await screen.findByText('70.0')).toBeInTheDocument();
    expect(screen.getByText('47')).toBeInTheDocument();
    expect(screen.getByText('27 of 120')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Top DAGs by slot-hours' });
    expect(within(table).getByText('acme_weekly_rollup')).toBeInTheDocument();
    expect(within(table).queryByText('acme_orders_daily')).toBeNull();
    const footer = screen.getByText((_t, el) => el?.tagName === 'FOOTER');
    expect(footer).toHaveTextContent('Range 29 Oct, 12:00 UTC to 5 Nov, 12:00 UTC');
    expect(screen.getByText(/^Last 7 days\./)).toBeInTheDocument();
    expect(hashQuery().get('range')).toBe('7d');
  });

  it("FR-UI-01: the DAG league asks for the bar's range, and a new range drops the selected run", async () => {
    const api = fakeApi();
    window.location.hash = `#/dags/orders_daily?env=acme-prod&range=6h&run=${encodeURIComponent(DETAIL.runs[0]?.run_id ?? '')}`;
    renderApp(api);
    await waitFor(() =>
      expect(api.getDagDetail).toHaveBeenLastCalledWith(
        'acme-prod',
        'orders_daily',
        '6h',
        DETAIL.runs[0]?.run_id,
      ),
    );
    await pickRange('Last 30 days');
    await waitFor(() =>
      expect(api.getDagDetail).toHaveBeenLastCalledWith('acme-prod', 'orders_daily', '30d', undefined),
    );
    expect(hashQuery().get('run')).toBeNull();
    expect(hashQuery().get('range')).toBe('30d');
  });

  it("FR-UI-01: the schedule page asks for the bar's range, which the bar offers there", async () => {
    const api = fakeApi();
    window.location.hash = '#/schedule?env=acme-prod&range=30d';
    renderApp(api);
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalledWith('acme-prod', '30d'));
    const picker = within(await screen.findByRole('group', { name: 'Context' })).getByRole('combobox', {
      name: 'Time range',
    });
    expect(picker).toHaveTextContent('Last 30 days');
    expect(picker).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('FR-UI-01: paused stops polling every query; resuming loads at once and polls again', async () => {
    const api = fakeApi();
    renderApp(api, { pollMs: 40 });
    await screen.findByText('10.0');
    await waitFor(() => expect(api.getOverview.mock.calls.length).toBeGreaterThan(2));

    await userEvent.click(within(bar()).getByRole('button', { name: 'Pause updates' }));
    expect(hashQuery().get('paused')).toBe('1');
    expect(within(bar()).getByRole('status')).toHaveTextContent('Paused · data as of');
    const overview = api.getOverview.mock.calls.length;
    const meta = api.getMeta.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.getOverview.mock.calls.length).toBe(overview);
    expect(api.getMeta.mock.calls.length).toBe(meta);

    // A user action still loads while paused.
    await pickRange('Last 7 days');
    await waitFor(() => expect(api.getOverview).toHaveBeenLastCalledWith('acme-prod', '7d'));
    const afterRange = api.getOverview.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.getOverview.mock.calls.length).toBe(afterRange);

    await userEvent.click(within(bar()).getByRole('button', { name: 'Resume updates' }));
    expect(hashQuery().get('paused')).toBeNull();
    await waitFor(() => expect(api.getOverview.mock.calls.length).toBeGreaterThan(afterRange + 2));
  });

  it('FR-UI-01: the time zone toggle changes every rendered time', async () => {
    renderApp(fakeApi());
    await screen.findByText('10.0');
    const footer = () => screen.getByText((_t, el) => el?.tagName === 'FOOTER');
    expect(footer()).toHaveTextContent('Data as of Thu, 5 Nov 2026, 12:00:00 UTC');
    expect(footer()).toHaveTextContent('Range 4 Nov, 12:00 UTC to 5 Nov, 12:00 UTC');

    await userEvent.click(within(bar()).getByRole('button', { name: 'Local (GMT+5:30)' }));
    expect(hashQuery().get('tz')).toBe('local');
    expect(footer()).toHaveTextContent('Data as of Thu, 5 Nov 2026, 17:30:00 GMT+5:30');
    expect(footer()).toHaveTextContent('Range 4 Nov, 17:30 GMT+5:30 to 5 Nov, 17:30 GMT+5:30');
    expect(within(bar()).getByRole('status')).toHaveTextContent('Data as of 5 Nov, 17:30:00 GMT+5:30');

    await userEvent.click(within(bar()).getByRole('button', { name: 'UTC' }));
    expect(footer()).toHaveTextContent('Data as of Thu, 5 Nov 2026, 12:00:00 UTC');
    expect(hashQuery().get('tz')).toBeNull();
  });

  it('FR-UI-01: pages with a fixed 24-hour window say so instead of offering a range that would not apply', async () => {
    window.location.hash = '#/alerts?env=acme-prod&range=7d';
    renderApp(fakeApi());
    const picker = await within(await screen.findByRole('group', { name: 'Context' })).findByRole(
      'combobox',
      {
        name: 'Time range',
      },
    );
    expect(picker).toHaveTextContent('Last 24 hours');
    expect(picker).toHaveAttribute('aria-disabled', 'true');
    // The chosen range stays in the URL for the pages that use it.
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: /^DAG league table/ })).toHaveAttribute(
      'href',
      '#/dags?env=acme-prod&range=7d',
    );
  });
});

describe('FR-UI-02 URL as state', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-UI-02: opening a shared link restores environment, range, time zone, paused, filters, sort and table view', async () => {
    const api = fakeApi();
    window.location.hash =
      '#/dags?env=acme-dev&range=30d&tz=local&paused=1&team=ml-platform&sort=runs.asc&treemap=table';
    renderApp(api);
    await waitFor(() => expect(api.getDagLeague).toHaveBeenCalledWith('acme-dev', '30d'));
    const context = await screen.findByRole('group', { name: 'Context' });
    expect(within(context).getByRole('combobox', { name: 'Environment' })).toHaveTextContent('acme-dev');
    expect(within(context).getByRole('combobox', { name: 'Time range' })).toHaveTextContent('Last 30 days');
    expect(within(context).getByRole('button', { name: 'Local (GMT+5:30)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(context).getByRole('button', { name: 'Resume updates' })).toBeInTheDocument();
    await screen.findByRole('table', { name: 'DAG league table' });
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveTextContent('ml-platform');
    expect(screen.getByText('Showing 1 of 4 DAGs')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Runs/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('button', { name: 'View treemap as chart' })).toBeInTheDocument();
  });

  it('FR-UI-02: filters and sort change the URL, so the link can be shared', async () => {
    renderApp(fakeApi());
    await userEvent.click(
      await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', {
        name: /^DAG league table/,
      }),
    );
    await screen.findByRole('table', { name: 'DAG league table' });
    await userEvent.click(screen.getByRole('button', { name: 'Flaky' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sort by p95 queue wait' }));
    await userEvent.click(screen.getByRole('textbox', { name: 'Search DAGs' }));
    await userEvent.paste('fraud');
    expect(hashQuery().get('preset')).toBe('flaky');
    expect(hashQuery().get('sort')).toBe('queue_wait_p95.desc');
    expect(hashQuery().get('q')).toBe('fraud');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(hashQuery().get('preset')).toBeNull();
    expect(hashQuery().get('q')).toBeNull();
    expect(hashQuery().get('sort')).toBe('queue_wait_p95.desc'); // sorting is not a filter
  });
});

describe('§12.10 freshness in live mode', () => {
  const collector = (p: Partial<CollectorStatus>): CollectorStatus => ({
    id: 'af.live',
    source: 'SRC-AF-API',
    state: 'ok',
    cadence_seconds: 30,
    last_attempt_at: AS_OF,
    last_success_at: AS_OF,
    next_run_at: null,
    lag_seconds: 20,
    consecutive_failures: 0,
    error_rate_1h: 0,
    last_error: null,
    ...p,
  });
  const env = (collectors: CollectorStatus[]): CollectionEnvironment => ({
    env_id: 'acme-prod',
    profile: 'standard',
    reduced_fidelity: false,
    failing: false,
    collectors,
    footprint: [],
    series_24h: null,
  });

  it('§12.10 / FR-UI-01: fresh up to 2 × cadence, stale (amber) above, very stale (red) above 5 ×', () => {
    expect(freshnessOf(env([collector({ lag_seconds: 59 })]))?.level).toBe('fresh');
    expect(freshnessOf(env([collector({ lag_seconds: 61 })]))?.level).toBe('stale');
    expect(freshnessOf(env([collector({ lag_seconds: 151 })]))?.level).toBe('very-stale');
    expect(freshnessOf(env([collector({ lag_seconds: 151 })]))?.detail).toMatch(/Open DCAM health/);
  });

  it('§12.10: disabled collectors and the Monitoring ingestion delay do not make data stale; no data yet says so', () => {
    const monitoring = collector({
      id: 'mon.core',
      source: 'SRC-MON',
      cadence_seconds: 60,
      lag_seconds: 300,
    });
    const off = collector({ id: 'af.facts', state: 'disabled', lag_seconds: 9_999 });
    expect(freshnessOf(env([collector({}), monitoring, off]))?.level).toBe('fresh');
    expect(freshnessOf(env([collector({ lag_seconds: null, state: 'waiting' })]))?.level).toBe('waiting');
    expect(freshnessOf(env([]))).toBeNull();
    expect(freshnessOf(undefined)).toBeNull();
  });
});
