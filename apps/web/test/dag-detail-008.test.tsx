import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { DagDetailPage } from '../src/pages/dags/DagDetailPage';
import { linkTo, type PageParams, type Route } from '../src/router';
import { RUN_COMPARISON, WITH_008, olderServer } from './dag-compare-fixtures';
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
});
