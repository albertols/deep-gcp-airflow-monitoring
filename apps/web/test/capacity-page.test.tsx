import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterEach, describe, expect, it } from 'vitest';
import type { Range } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { App } from '../src/App';
import { DEFAULT_PAGE_VIEW, ViewContext } from '../src/components/view';
import { linkTo, parseLocation, toHref } from '../src/router';
import { CapacityPage } from '../src/pages/capacity/CapacityPage';
import { capacityApi } from './capacity-fixtures';

afterEach(() => {
  window.location.hash = '';
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderPage(
  api: DcamApi = capacityApi(),
  { range = '24h', mode = 'dark' }: { range?: Range; mode?: 'dark' | 'light' } = {},
) {
  return render(
    <ThemeProvider theme={createDcamTheme(mode)}>
      <QueryClientProvider client={client()}>
        <ViewContext.Provider value={{ ...DEFAULT_PAGE_VIEW, range }}>
          <CapacityPage
            api={api}
            envId="acme-prod"
            route={{ page: 'capacity' }}
            linkTo={(r) => linkTo(r, 'acme-prod')}
            navigate={() => {}}
          />
        </ViewContext.Provider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function renderApp(api: DcamApi = capacityApi()) {
  return render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client()}>
        <App api={api} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('S-04 capacity page: route, tabs and range (FR-ENV-02, FR-UI-01, FR-UI-02)', () => {
  it('FR-ENV-02: S-04 has its own route and a "Capacity" navigation entry', async () => {
    expect(parseLocation('/capacity', '?env=acme-prod')).toMatchObject({
      route: { page: 'capacity' },
      envId: 'acme-prod',
    });
    expect(toHref({ page: 'capacity' }, 'acme-prod')).toBe('/capacity?env=acme-prod');
    renderApp();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const link = within(nav).getByRole('link', { name: /^Capacity Worker slots/ });
    await waitFor(() => expect(link).toHaveAttribute('href', '#/capacity?env=acme-prod'));
    await userEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Capacity' })).toBeInTheDocument();
  });

  it('FR-UI-02: the tab is in the URL, so a shared link opens the forecast', async () => {
    window.location.hash = '#/capacity?env=acme-prod&tab=forecast';
    renderApp();
    expect(await screen.findByRole('tab', { name: 'Forecast', selected: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Load by DAG' }));
    await waitFor(() => expect(window.location.hash).toContain('tab=dags'));
    await userEvent.click(screen.getByRole('tab', { name: 'Capacity' }));
    await waitFor(() => expect(window.location.hash).not.toContain('tab='));
  });

  it('FR-UI-01: with 30 days in the context bar the page asks for 7 days and says so', async () => {
    const api = capacityApi();
    renderPage(api, { range: '30d' });
    expect(
      await screen.findByText(/^Capacity covers the last 7 days: the longest range it analyses/),
    ).toBeInTheDocument();
    expect(api.calls).toEqual(['7d']);
  });

  it('FR-UI-01: with 15 minutes in the context bar the page asks for the last hour and says so', async () => {
    const api = capacityApi();
    renderPage(api, { range: '15m' });
    expect(
      await screen.findByText(/^Capacity covers the last hour: the shortest range it analyses/),
    ).toBeInTheDocument();
    expect(api.calls).toEqual(['1h']);
  });

  it('FR-UI-01: a supported range is used as it is, without a note', async () => {
    const api = capacityApi();
    renderPage(api, { range: '6h' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Capacity' })).toBeInTheDocument();
    await waitFor(() => expect(api.calls).toEqual(['6h']));
    expect(screen.queryByText(/^Capacity covers the last/)).toBeNull();
  });
});
