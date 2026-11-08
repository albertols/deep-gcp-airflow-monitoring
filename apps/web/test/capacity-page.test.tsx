import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterEach, describe, expect, it } from 'vitest';
import type { Capacity, Range } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { App } from '../src/App';
import { DEFAULT_PAGE_VIEW, ViewContext } from '../src/components/view';
import { linkTo, parseLocation, toHref } from '../src/router';
import { CapacityPage } from '../src/pages/capacity/CapacityPage';
import { capacityApi, capacityFixture } from './capacity-fixtures';

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

const panel = (title: string) => screen.findByRole('region', { name: title });

/** The alert whose text starts as `text` says. */
async function alertWith(text: RegExp) {
  const alert = (await screen.findByText(text)).closest('[role="alert"]');
  if (!(alert instanceof HTMLElement)) throw new Error(`No alert says ${String(text)}`);
  return alert;
}

/** The KPI card whose (i) title is `title`. */
async function kpi(title: string) {
  const card = (await screen.findByRole('heading', { name: title })).closest('.MuiPaper-root');
  if (!(card instanceof HTMLElement)) throw new Error(`No KPI card for ${title}`);
  return card;
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

describe('S-04 capacity tab: slots and capacity-bound periods (FR-ENV-02, HM-011)', () => {
  it('FR-ENV-02: answers first: how long the environment was capacity-bound, and its longest stretch', async () => {
    renderPage();
    const answer = await alertWith(/^Capacity-bound for 65 min in the last 24 hours/);
    expect(answer).toHaveTextContent(
      'The longest stretch was 52 min from 5 Nov, 02:03 UTC: workers at the maximum of 6 with up to 70 task instances queued.',
    );
    expect(within(answer).getByRole('link', { name: /bottlenecks page/ })).toHaveAttribute(
      'href',
      '#/bottlenecks?env=acme-prod',
    );
  });

  it('HM-011: KPIs for capacity-bound minutes, minutes at max workers, utilisation and peak queued', async () => {
    renderPage();
    expect(await kpi('Capacity-bound minutes')).toHaveTextContent(/65\s*min/);
    expect(await kpi('Capacity-bound minutes')).toHaveTextContent('4.5% of the observed minutes, 2 periods');
    expect(await kpi('Minutes at max workers')).toHaveTextContent(/75\s*min/);
    expect(await kpi('Worker slot utilisation (p95)')).toHaveTextContent('100%');
    expect(await kpi('Peak queued')).toHaveTextContent(/70\s*task instances/);
  });

  it('FR-ENV-02: capacity-bound buckets are highlighted on the slots chart, not by colour alone, and named in its description', async () => {
    renderPage();
    const p = await panel('Worker slots and use');
    const chart = within(p).getByRole('img', {
      name: /Worker slots against running and queued task instances/,
    });
    expect(chart).toHaveAccessibleName(
      expect.stringContaining(
        'Capacity-bound: 4 Nov, 19:00–19:13 UTC (13 min); 5 Nov, 02:03–02:55 UTC (52 min).',
      ),
    );
    // One hatched band with its own title per bucket that has capacity-bound minutes.
    const bands = within(chart).getAllByText(/^Capacity-bound \d/);
    expect(bands).toHaveLength(5);
    expect(bands[1]).toHaveTextContent('Capacity-bound 02:00–02:15 UTC: 12 min');
  });

  it('FR-ENV-02 / NFR-A11Y-01: the slots chart has a table view that marks the capacity-bound buckets', async () => {
    renderPage();
    const p = await panel('Worker slots and use');
    await userEvent.click(within(p).getByRole('button', { name: 'View as a table' }));
    const table = within(p).getByRole('table', { name: 'Worker slots per bucket' });
    // Rows are found by their time cell: name queries over 96 rows are slow in jsdom.
    const row = within(table).getByText('5 Nov, 02:15').closest('tr');
    expect(row).toHaveTextContent('Capacity-bound');
    expect(row).toHaveTextContent('72');
    expect(within(table).getAllByText('Capacity-bound')).toHaveLength(5);
  });

  it('FR-ENV-02: lists every capacity-bound period with its start, end, minutes, peak queued and workers', async () => {
    renderPage();
    const p = await panel('Capacity-bound periods');
    const table = within(p).getByRole('table', { name: 'Capacity-bound periods' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/5 Nov, 02:03.*02:55.*52 min.*70.*6 of 6/);
    expect(rows[1]).toHaveTextContent(/4 Nov, 19:00.*19:13.*13 min.*53/);
  });

  it('FR-ENV-02: says plainly when the environment was never capacity-bound', async () => {
    const calm: Capacity = {
      ...capacityFixture,
      summary: { ...capacityFixture.summary, capacity_bound_minutes: 0, capacity_bound_share: 0 },
      series: capacityFixture.series.map((b) => ({ ...b, capacity_bound_minutes: 0 })),
      capacity_bound: { ...capacityFixture.capacity_bound, period_count: 0, periods: [] },
    };
    renderPage(capacityApi(calm));
    expect(await screen.findByText(/^Not capacity-bound in the last 24 hours/)).toHaveTextContent(
      'workers were never at the maximum of 6 with at least 15 task instances queued (the larger of 10 and 20% of the 72 worker slots)',
    );
    expect(await panel('Capacity-bound periods')).toHaveTextContent(
      'No capacity-bound period in this range.',
    );
  });
});
