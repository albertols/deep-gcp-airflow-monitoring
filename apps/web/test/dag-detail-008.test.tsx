import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { COMPARE_EXPLANATIONS, DAG_DETAIL_008_PANELS } from '../src/pages/dags/compare-explanations';
import { DagDetailPage } from '../src/pages/dags/DagDetailPage';
import { linkTo, type PageParams, type Route } from '../src/router';
import { RUN_1, RUN_2, RUN_COMPARISON, WITH_008, olderServer } from './dag-compare-fixtures';
import { LEAGUE } from './dag-fixtures';

/** Whole-page tests: jsdom renders MUI slowly on a loaded machine. */
const UI_TIMEOUT_MS = 30_000;
const notYet = () => Promise.reject(new Error('not in this test'));

function fakeApi(overrides: Partial<DcamApi> = {}): DcamApi {
  return {
    getMeta: notYet,
    getOverview: notYet,
    getDagLeague: async () => LEAGUE,
    getDagDetail: async () => WITH_008,
    getDagComparison: notYet,
    getRunComparison: async () => RUN_COMPARISON,
    getBottlenecks: notYet,
    getFindings: notYet,
    getAlerts: notYet,
    getFleet: notYet,
    getCollection: notYet,
    getSchedule: notYet,
    ...overrides,
  };
}

const route: Route = { page: 'dag', dagId: 'orders_daily' };

function renderPage(api: DcamApi = fakeApi()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <DagDetailPage
          api={api}
          envId="acme-prod"
          route={route}
          linkTo={(r: Route, p?: PageParams) => linkTo(r, 'acme-prod', undefined, p)}
          navigate={vi.fn()}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('S-12 DAG detail, feature 008', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-DAGD-05 / FR-DAGD-06: DAG detail shows the concurrency profile and the impact on the environment', async () => {
    renderPage();
    const concurrency = await screen.findByRole('region', { name: 'Concurrency profile' });
    expect(within(concurrency).getByTestId('self-throttling')).toHaveTextContent(/REC-DAG-01/);
    const impact = screen.getByRole('region', { name: 'Impact on the environment' });
    expect(within(impact).getByTestId('noisy-neighbour')).toHaveTextContent('+45s');
  });

  it('FR-DAGD-05: an older server without the new fields still shows the rest of the page', async () => {
    const older = olderServer(WITH_008, 'concurrency', 'impact');
    renderPage(fakeApi({ getDagDetail: async () => older }));
    expect(await screen.findByText(/does not report the concurrency profile yet/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Tasks' })).toBeInTheDocument());
  });

  it('FR-DAGD-01: the DAG’s findings, most severe first, each linked to the advisor', async () => {
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Findings' });
    const items = within(panel).getAllByRole('listitem');
    expect(items.map((i) => within(i).getByRole('link').textContent)).toEqual([
      'Workers at maximum while tasks are queued',
      'DAG throttled by max_active_tasks',
    ]);
    expect(within(items[0] as HTMLElement).getByText('Critical')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('REC-DAG-01')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      '#/advisor?env=acme-prod&finding=acme-prod%3AREC-DAG-01%3Adag%3Aorders_daily',
    );
  });

  it('FR-DAGD-01: without open findings the panel says so and what that covers', async () => {
    renderPage(fakeApi({ getDagDetail: async () => ({ ...WITH_008, findings: [] }) }));
    const panel = await screen.findByRole('region', { name: 'Findings' });
    expect(panel).toHaveTextContent(/No open findings for this DAG in the last 24 hours/);
  });

  it('FR-DAGD-08: "Compare with other DAGs" opens the comparison with this DAG in it', async () => {
    renderPage();
    expect(await screen.findByRole('link', { name: 'Compare with other DAGs' })).toHaveAttribute(
      'href',
      '#/compare/dags?env=acme-prod&dags=acme-prod%3Aorders_daily',
    );
  });
});

describe('S-13 run comparison on DAG detail (FR-DAGD-09)', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-DAGD-09: compares the run in the Gantt chart with the previous successful run by default', async () => {
    const getRunComparison = vi.fn(async () => RUN_COMPARISON);
    renderPage(fakeApi({ getRunComparison }));
    await screen.findByRole('table', { name: 'Tasks by contribution to the duration difference' });
    // The Gantt shows run 2 (failed); run 1 is the latest successful run before it.
    expect(getRunComparison).toHaveBeenCalledWith('acme-prod', 'orders_daily', RUN_1, RUN_2, '24h');
    const panel = screen.getByRole('region', { name: 'Compare runs' });
    expect(within(panel).getByRole('combobox', { name: 'Compared with (A)' })).toHaveTextContent(
      /5 Nov, 10:00/,
    );
  });

  it('FR-DAGD-09: ranks tasks by their contribution to the run duration difference and states the method', async () => {
    renderPage();
    const table = await screen.findByRole('table', {
      name: 'Tasks by contribution to the duration difference',
    });
    const rows = within(table).getAllByRole('row').slice(1);
    const cells = (r: HTMLElement) =>
      within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent ?? '');
    expect(rows.map((r) => cells(r)[1])).toEqual(['load', 'notify', 'cleanup', 'extract']);
    expect(rows.map((r) => cells(r)[0])).toEqual(['1', '2', '3', '4']);
    const load = rows[0] as HTMLElement;
    expect(load).toHaveTextContent('8m 20s → 18m 20s');
    expect(load).toHaveTextContent('+10m');
    expect(load).toHaveTextContent('+11m');
    expect(load).toHaveTextContent(/longest of 8 map indexes/);
    expect(rows[2] as HTMLElement).toHaveTextContent(/Not in run B/);
    expect(rows[3] as HTMLElement).toHaveTextContent('−1m');
    const panel = screen.getByRole('region', { name: 'Compare runs' });
    expect(panel).toHaveTextContent(/B took 10m longer than A \(20m against 30m\)/);
    expect(panel).toHaveTextContent(/HM-007\/timing/);
    expect(within(panel).getByText(/Source: demo data/)).toBeInTheDocument();
  });

  it('FR-DAGD-09: with a run in progress, tasks rank by their duration difference and the panel says so', async () => {
    const inProgress = {
      ...RUN_COMPARISON,
      ranking: 'duration_delta' as const,
      b: {
        ...RUN_COMPARISON.b,
        state: 'running' as const,
        end: null,
        duration_seconds: null,
        critical_path_seconds: null,
      },
      duration_delta_seconds: null,
      explained_seconds: null,
      tasks: RUN_COMPARISON.tasks.map((t) => ({
        ...t,
        contribution_seconds: null,
        contribution_wait_seconds: null,
        contribution_running_seconds: null,
      })),
    };
    renderPage(fakeApi({ getRunComparison: async () => inProgress }));
    const panel = await screen.findByRole('region', { name: 'Compare runs' });
    expect(
      await within(panel).findByText(/B is still running, so it has no critical path yet/),
    ).toBeInTheDocument();
  });

  it('FR-DAGD-09: a DAG with one run in the range asks for a longer range instead of comparing', async () => {
    const one = { ...WITH_008, runs: WITH_008.runs.slice(1) };
    const getRunComparison = vi.fn(async () => RUN_COMPARISON);
    renderPage(fakeApi({ getDagDetail: async () => one, getRunComparison }));
    const panel = await screen.findByRole('region', { name: 'Compare runs' });
    expect(panel).toHaveTextContent(/Only one run of this DAG in the range/);
    expect(getRunComparison).not.toHaveBeenCalled();
  });

  it('FR-UI-07: a problem from the server is shown in the panel', async () => {
    renderPage(
      fakeApi({ getRunComparison: async () => Promise.reject(new Error('Run b is not in the range.')) }),
    );
    const panel = await screen.findByRole('region', { name: 'Compare runs' });
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/Run b is not in the range/);
  });
});

describe('S-12 explanations, feature 008', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-UI-05: every new panel and column on DAG detail has an explanation', async () => {
    for (const id of DAG_DETAIL_008_PANELS) expect(COMPARE_EXPLANATIONS[id], id).toBeDefined();
    renderPage();
    await screen.findByRole('table', { name: 'Tasks by contribution to the duration difference' });
    const about = screen.getAllByRole('button', { name: /^About / }).map((b) => b.getAttribute('aria-label'));
    for (const id of DAG_DETAIL_008_PANELS)
      expect(about, id).toContain(`About ${COMPARE_EXPLANATIONS[id].title}`);
  });
});
