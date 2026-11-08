import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Collection, DagDetail } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { DagDetailPage } from '../src/pages/dags/DagDetailPage';
import { DagsPage } from '../src/pages/dags/DagsPage';
import { DEPTH_EXPLANATIONS, DEPTH_PANELS } from '../src/pages/dags/depth-explanations';
import { DAG_EXPLANATIONS, LEAGUE_PANELS } from '../src/pages/dags/explanations';
import { linkTo, type Route } from '../src/router';
import { DETAIL, LEAGUE } from './dag-fixtures';
import { DEPTH, dist } from './dag-depth-fixtures';

/** Whole-page tests: jsdom renders MUI slowly on a loaded machine. */
const UI_TIMEOUT_MS = 30_000;

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
    getDagDetail: async () => DEPTH,
    getBottlenecks: notYet,
    getFindings: notYet,
    getAlerts: notYet,
    getFleet: notYet,
    getCollection: notYet,
    getSchedule: notYet,
    getDagComparison: notYet,
    getRunComparison: notYet,
    ...overrides,
  };
}

function renderPage(Page: typeof DagsPage, api: DcamApi, route: Route) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <Page
          api={api}
          envId="acme-prod"
          route={route}
          linkTo={(r) => linkTo(r, 'acme-prod')}
          navigate={vi.fn()}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const route: Route = { page: 'dag', dagId: 'orders_daily' };
const detail = (d: DagDetail) => fakeApi({ getDagDetail: async () => d });
const rowOf = (table: HTMLElement, task: string) =>
  within(table).getByText(task, { selector: 'td' }).closest('tr') as HTMLElement;

describe('S-12 DAG detail in depth', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-TASK-01 / HM-016: each task against its baseline band, with the verdict in words', async () => {
    renderPage(DagDetailPage, fakeApi(), route);
    const panel = await screen.findByRole('region', { name: 'Duration against baseline' });
    expect(within(panel).getByText(/Runs are slower than their baseline/)).toBeInTheDocument();
    expect(within(panel).getByText(/×1\.7/)).toBeInTheDocument();
    const table = within(panel).getByRole('table', { name: 'Task durations against baseline' });
    const rows = within(table).getAllByRole('row').slice(1);
    // Regressions first, then tasks within their baseline, then the ones DCAM cannot judge.
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      'load',
      'extract',
      'notify',
      'cleanup',
    ]);
    const load = rowOf(table, 'load');
    expect(within(load).getByText('Regression')).toBeInTheDocument();
    expect(within(load).getByText('×2.0')).toBeInTheDocument();
    expect(
      within(load).getByRole('img', { name: /Now: median 20m, p95 30m from 24 tries/ }),
    ).toHaveAccessibleName(/Baseline: median 10m, p95 15m from 25 tries/);
    expect(within(rowOf(table, 'extract')).getByText('Within baseline')).toBeInTheDocument();
    expect(within(rowOf(table, 'notify')).getByText('Too few runs')).toBeInTheDocument();
    expect(within(rowOf(table, 'cleanup')).getByText('No baseline yet')).toBeInTheDocument();
  });

  it('HM-016: a baseline shorter than 28 days is labelled partial with the days it covers', async () => {
    renderPage(DagDetailPage, fakeApi(), route);
    const panel = await screen.findByRole('region', { name: 'Duration against baseline' });
    expect(
      within(panel).getByText(/Partial baseline: DCAM has history for 1\.0 of its 28 days/),
    ).toBeInTheDocument();
  });

  it('HM-016: without history before the range, the baseline is not available yet and says what to do', async () => {
    const empty: DagDetail = {
      ...DEPTH,
      baseline: {
        ...(DEPTH.baseline as NonNullable<DagDetail['baseline']>),
        history_from: null,
        coverage: 0,
      },
      regression: {
        status: 'no_baseline',
        current: dist(1_500, 2_400, 24),
        baseline: dist(0, 0, 0),
        ratio: null,
        p_value: null,
        q_value: null,
      },
    };
    renderPage(DagDetailPage, detail(empty), route);
    const panel = await screen.findByRole('region', { name: 'Duration against baseline' });
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      /Baseline not available yet: DCAM has no task history before this range.*reads the last 7 days/,
    );
    expect(within(panel).getByText(/0 successful runs in the 28 days before this range/)).toBeInTheDocument();
  });

  it('FR-UI-07: a server without these fields says the panels are not available, instead of showing zeros', async () => {
    renderPage(DagDetailPage, detail(DETAIL), route);
    const duration = await screen.findByRole('region', { name: 'Duration against baseline' });
    expect(within(duration).getByText(/does not report this yet/)).toBeInTheDocument();
    const reliability = screen.getByRole('region', { name: 'Failures, retries and flakiness' });
    expect(within(reliability).getByText(/does not report this yet/)).toBeInTheDocument();
  });

  it('HM-015: failure, retry and flaky rates for the DAG and per task; counts below 20 samples', async () => {
    renderPage(DagDetailPage, fakeApi(), route);
    const panel = await screen.findByRole('region', { name: 'Failures, retries and flakiness' });
    expect(within(panel).getByText('12.5%')).toBeInTheDocument(); // run failure rate
    expect(within(panel).getByText('10%')).toBeInTheDocument(); // flaky rate
    expect(within(panel).getByText(/2 inferred from the try number/)).toBeInTheDocument();
    expect(within(panel).getByText('5m')).toBeInTheDocument(); // MTTR
    expect(within(panel).getByText(/Error signatures need Cloud Logging/)).toBeInTheDocument();
    const table = within(panel).getByRole('table', { name: 'Task reliability' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('extract');
    const extract = rowOf(table, 'extract');
    expect(within(extract).getByText('25%')).toBeInTheDocument();
    const notify = rowOf(table, 'notify');
    expect(within(notify).getByText('3 of 12')).toBeInTheDocument();
  });

  it('HM-007: the Gantt marks the critical path as an estimate, and the summary names its steps', async () => {
    renderPage(DagDetailPage, fakeApi(), route);
    const gantt = await screen.findByRole('img', { name: /Gantt of run/ });
    expect(gantt.querySelectorAll('[data-critical="true"]')).toHaveLength(2);
    expect(gantt).toHaveAccessibleDescription(/critical path, estimated from timing: 2 tries/i);
    const legend = screen.getByRole('list', { name: 'Gantt legend' });
    expect(within(legend).getByText('Critical path (estimate)')).toBeInTheDocument();
    const summary = screen
      .getByRole('region', { name: 'Run Gantt' })
      .querySelector('[data-testid="critical-path"]');
    expect(summary).toHaveTextContent(/extract → load/);
    expect(summary).toHaveTextContent(/running 15m \(83\.3%\), waiting 3m \(16\.7%\)/);
    expect(summary).toHaveTextContent(/load: 100% of runs/);
    await userEvent.click(screen.getByRole('button', { name: 'View Gantt as table' }));
    const table = screen.getByRole('table', { name: /Gantt of run/ });
    expect(within(table).getAllByText('On the path')).toHaveLength(2);
  });

  it('HM-007: a running run says the critical path shows once it has finished', async () => {
    renderPage(DagDetailPage, detail({ ...DEPTH, gantt: { ...DEPTH.gantt, critical_path: null } }), route);
    expect(await screen.findByText(/critical path shows once the run has finished/i)).toBeInTheDocument();
  });

  it('FR-UI-07: task history older than five collection cycles marks the panels stale', async () => {
    const collection: Collection = {
      mode: 'live',
      generated_at: DETAIL.range.to,
      environments: [
        {
          env_id: 'acme-prod',
          profile: 'standard',
          reduced_fidelity: false,
          failing: false,
          collectors: [
            {
              id: 'af.facts',
              source: 'SRC-AF-API',
              state: 'degraded',
              cadence_seconds: 60,
              last_attempt_at: DETAIL.range.to,
              last_success_at: '2026-11-05T11:48:00.000Z',
              next_run_at: null,
              lag_seconds: 720,
              consecutive_failures: 2,
              error_rate_1h: 0.2,
              last_error: null,
            },
          ],
          footprint: [],
          series_24h: null,
        },
      ],
    };
    renderPage(DagDetailPage, fakeApi({ getCollection: async () => collection }), route);
    const panel = await screen.findByRole('region', { name: 'Duration against baseline' });
    expect(await within(panel).findByText('Task history 12 min old')).toBeInTheDocument();
    const reliability = screen.getByRole('region', { name: 'Failures, retries and flakiness' });
    expect(within(reliability).getByText('Task history 12 min old')).toBeInTheDocument();
  });

  it('FR-UI-05 / FR-UI-08: every new panel, KPI and column has an explanation; panels show provenance', async () => {
    for (const id of DEPTH_PANELS) expect(DEPTH_EXPLANATIONS[id], id).toBeDefined();
    renderPage(DagDetailPage, fakeApi(), route);
    await screen.findByRole('table', { name: 'Task reliability' });
    const about = screen.getAllByRole('button', { name: /^About / }).map((b) => b.getAttribute('aria-label'));
    for (const id of DEPTH_PANELS) expect(about, id).toContain(`About ${DEPTH_EXPLANATIONS[id].title}`);
    for (const name of ['Duration against baseline', 'Failures, retries and flakiness'])
      expect(within(screen.getByRole('region', { name })).getByText(/Source: demo data/)).toBeInTheDocument();
  });
});

describe('S-11 league: flakiness column', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-DAGX-02 / HM-015: a Flaky column with retries in its tooltip and an explanation', async () => {
    expect(LEAGUE_PANELS).toContain('dagx-col-flaky');
    renderPage(DagsPage, fakeApi(), { page: 'dags' });
    const table = await screen.findByRole('table', { name: 'DAG league table' });
    expect(within(table).getByRole('button', { name: 'Sort by Flaky' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `About ${DAG_EXPLANATIONS['dagx-col-flaky'].title}` }),
    ).toBeInTheDocument();
    const fraud = screen.getByRole('link', { name: 'fraud_scoring_hourly' }).closest('tr') as HTMLElement;
    expect(within(fraud).getByTitle('14 retries in 96 tries')).toHaveTextContent('12%');
    const idle = screen.getByRole('link', { name: 'idle_export' }).closest('tr') as HTMLElement;
    expect(within(idle).getByTitle(/Fewer than 20 task instances/)).toHaveTextContent('—');
  });
});
