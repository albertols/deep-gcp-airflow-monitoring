import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { useCallback, useMemo, useState, type ComponentType } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Meta } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import { ApiError, type DcamApi } from '../src/api';
import { timeFormat } from '../src/components/time';
import { DEFAULT_PAGE_VIEW, PageParamsContext, ViewContext, type View } from '../src/components/view';
import { CompareDagsPage } from '../src/pages/compare/CompareDagsPage';
import { COMPARE_EXPLANATIONS, COMPARE_PAGE_PANELS } from '../src/pages/dags/compare-explanations';
import { DagsPage } from '../src/pages/dags/DagsPage';
import type { PageProps } from '../src/pages/types';
import { linkTo, type PageParams, type Route } from '../src/router';
import { COMPARISON } from './dag-compare-fixtures';
import { LEAGUE } from './dag-fixtures';

const UI_TIMEOUT_MS = 30_000;
const notYet = () => Promise.reject(new Error('not in this test'));
const META: Meta = {
  name: 'DCAM',
  version: '0.0.0-test',
  mode: 'demo',
  environments: [
    { env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' },
    { env_id: 'acme-test', display_name: 'acme-test', tier: 'test' },
  ],
};

function fakeApi(overrides: Partial<DcamApi> = {}): DcamApi {
  return {
    getMeta: async () => META,
    getOverview: notYet,
    getDagLeague: async () => LEAGUE,
    getDagDetail: notYet,
    getDagComparison: async () => COMPARISON,
    getCapacity: notYet,
    getForecast: notYet,
    getRunComparison: notYet,
    getBottlenecks: notYet,
    getFindings: notYet,
    getAlerts: notYet,
    getFleet: notYet,
    getCollection: notYet,
    getSchedule: notYet,
    ...overrides,
  };
}

/** The shell's page parameters, kept in state, so a page's URL changes can be read back (FR-UI-02). */
function Shell({
  Page,
  api,
  initial,
  onParams,
  view,
}: {
  Page: ComponentType<PageProps>;
  api: DcamApi;
  initial: PageParams;
  onParams: (p: PageParams) => void;
  view: View;
}) {
  const [params, setParams] = useState<PageParams>(initial);
  const set = useCallback(
    (patch: Readonly<Record<string, string | null>>) =>
      setParams((current) => {
        const next: Record<string, string> = { ...current };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') delete next[k];
          else next[k] = v;
        }
        onParams(next);
        return next;
      }),
    [onParams],
  );
  const value = useMemo(() => ({ params, set }), [params, set]);
  return (
    <ViewContext.Provider value={view}>
      <PageParamsContext.Provider value={value}>
        <Page
          api={api}
          envId="acme-prod"
          route={{ page: 'compare-dags' }}
          linkTo={(r: Route, p?: PageParams) => linkTo(r, 'acme-prod', undefined, p)}
          navigate={vi.fn()}
        />
      </PageParamsContext.Provider>
    </ViewContext.Provider>
  );
}

function renderPage({
  api = fakeApi(),
  dags = 'acme-prod:logistics_export,acme-test:logistics_export',
  Page = CompareDagsPage,
  initial,
  view = DEFAULT_PAGE_VIEW,
}: {
  api?: DcamApi;
  dags?: string;
  Page?: ComponentType<PageProps>;
  initial?: PageParams;
  view?: View;
} = {}) {
  const onParams = vi.fn<(p: PageParams) => void>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <Shell Page={Page} api={api} initial={initial ?? { dags }} onParams={onParams} view={view} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { onParams, lastParams: () => onParams.mock.calls.at(-1)?.[0] };
}

const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole('cell')
    .map((c) => c.textContent ?? '');
const rowNamed = (table: HTMLElement, name: string) =>
  within(table).getByRole('rowheader', { name }).closest('tr') as HTMLElement;

describe('S-14 compare DAGs (FR-DAGD-08)', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-DAGD-08: with fewer than 2 DAGs it asks for more and does not call the API', async () => {
    const getDagComparison = vi.fn(async () => COMPARISON);
    renderPage({ api: fakeApi({ getDagComparison }), dags: 'acme-prod:orders_daily' });
    expect(await screen.findByText(/Add at least one more DAG to compare/)).toBeInTheDocument();
    expect(getDagComparison).not.toHaveBeenCalled();
  });

  it('FR-DAGD-08: aligned KPIs, one column per DAG, from the same or different environments', async () => {
    const getDagComparison = vi.fn(async () => COMPARISON);
    renderPage({ api: fakeApi({ getDagComparison }) });
    const table = await screen.findByRole('table', { name: 'Aligned KPIs' });
    expect(getDagComparison).toHaveBeenCalledWith(
      'acme-prod:logistics_export,acme-test:logistics_export',
      '24h',
    );
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers.slice(1)).toEqual(['A logistics_exportacme-prod', 'B logistics_exportacme-test']);
    expect(cells(rowNamed(table, 'Runs'))).toEqual(['24', '12']);
    // Below 20 samples, a p95 is the maximum (§8.9).
    expect(cells(rowNamed(table, 'Run duration p95'))).toEqual(['1h 2m', '≤ 22m 50s']);
    expect(cells(rowNamed(table, 'Flaky rate'))).toEqual(['1.4%', '—']);
  });

  it('FR-DAGD-08: duration distributions overlaid on the shared bins, with a table view', async () => {
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Duration distributions' });
    expect(within(panel).getByRole('img', { name: /4 shared bins from 10m to 1h 7m/ })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'View as table' }));
    const table = within(panel).getByRole('table', { name: 'Successful runs per duration bin' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(cells(rows[0] as HTMLElement)).toEqual(['0 (0%)', '6 (50%)']);
    expect(within(rows[0] as HTMLElement).getByRole('rowheader')).toHaveTextContent('10m to 20m');
  });

  it('FR-DAGD-08: hourly load profiles are in UTC, even when the context bar shows local time', async () => {
    const local = { ...DEFAULT_PAGE_VIEW, tz: 'local' as const, time: timeFormat('local', 'Asia/Kolkata') };
    renderPage({ view: local });
    const panel = await screen.findByRole('region', { name: 'Hourly load profile' });
    expect(panel).toHaveTextContent(/Hours of the day in UTC/);
    expect(panel).toHaveTextContent(/The context bar shows local time; this profile stays in UTC/);
    await userEvent.click(within(panel).getByRole('button', { name: 'View as table' }));
    const table = within(panel).getByRole('table', { name: 'Mean running tasks per UTC hour' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(24);
    expect(within(rows[0] as HTMLElement).getByRole('rowheader')).toHaveTextContent('00:00–01:00 UTC');
    // acme-test has no history for that hour: a gap, not zero.
    expect(within(rows[0] as HTMLElement).getByTitle('No history for this hour')).toHaveTextContent('—');
  });

  it('FR-DAGD-08: resource shares of each DAG’s own environment', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Resource shares' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0] as HTMLElement).toHaveTextContent('55.5');
    expect(rows[0] as HTMLElement).toHaveTextContent('5.4%');
    expect(rows[1] as HTMLElement).toHaveTextContent(/etl 2.8 slot-hours \(9.9%\)/);
  });

  it('FR-DAGD-08: shows each environment’s capacity context, with times in the context bar’s zone', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Capacity context' });
    expect(cells(rowNamed(table, 'Worker slots (maximum)'))).toEqual(['72', 'Not known yet']);
    expect(cells(rowNamed(table, 'Workers'))).toEqual(['2 to 6', '1 to 6']);
    expect(cells(rowNamed(table, 'Utilisation of the maximum slots'))).toEqual(['60%', '—']);
    expect(cells(rowNamed(table, 'Task history'))[1]).toMatch(/50% of the range, since 5 Nov, 00:00 UTC/);
  });

  it('FR-DAGD-08 / FR-UI-02: removing and adding DAGs writes the selection to the URL; a fifth is refused', async () => {
    const four =
      'acme-prod:logistics_export,acme-test:logistics_export,acme-prod:orders_daily,acme-prod:fraud_scoring_hourly';
    const { lastParams } = renderPage({ dags: four });
    const panel = await screen.findByRole('region', { name: 'DAGs compared' });
    expect(within(panel).getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(panel).toHaveTextContent(/You can compare up to 4 DAGs/);

    await userEvent.click(within(panel).getByRole('button', { name: 'Remove acme-prod:orders_daily' }));
    expect(lastParams()).toEqual({
      dags: 'acme-prod:logistics_export,acme-test:logistics_export,acme-prod:fraud_scoring_hourly',
    });

    await userEvent.type(within(panel).getByRole('combobox', { name: 'DAG' }), 'partner');
    await userEvent.click(await screen.findByRole('option', { name: 'partner_crm_sync' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    expect(lastParams()?.['dags']).toBe(
      'acme-prod:logistics_export,acme-test:logistics_export,acme-prod:fraud_scoring_hourly,acme-prod:partner_crm_sync',
    );
  });

  it('FR-UI-07: a problem from the server is shown with its detail and what to do', async () => {
    const problem = new ApiError('No DAG "nope" is known in environment "acme-prod".', 404);
    renderPage({ api: fakeApi({ getDagComparison: async () => Promise.reject(problem) }) });
    expect(await screen.findByRole('alert')).toHaveTextContent(/No DAG "nope" is known/);
    expect(screen.getByRole('alert')).toHaveTextContent(/Remove it, or pick another DAG/);
  });

  it('FR-UI-05 / FR-UI-08: every panel has an explanation and a provenance footer', async () => {
    for (const id of COMPARE_PAGE_PANELS) expect(COMPARE_EXPLANATIONS[id], id).toBeDefined();
    renderPage();
    await screen.findByRole('table', { name: 'Aligned KPIs' });
    const about = screen.getAllByRole('button', { name: /^About / }).map((b) => b.getAttribute('aria-label'));
    for (const id of COMPARE_PAGE_PANELS)
      expect(about, id).toContain(`About ${COMPARE_EXPLANATIONS[id].title}`);
    for (const id of COMPARE_PAGE_PANELS.filter((x) => x !== 'cmp-selection'))
      expect(
        within(screen.getByRole('region', { name: COMPARE_EXPLANATIONS[id].title })).getByText(
          /Source: demo data/,
        ),
        id,
      ).toBeInTheDocument();
  });
});

describe('S-11 league: select DAGs to compare (FR-DAGD-08)', { timeout: UI_TIMEOUT_MS }, () => {
  // The league is virtualised: give the scroll viewport a height so jsdom renders its rows.
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 560 });
  });
  afterAll(() => {
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
  });

  it('FR-DAGD-08: select rows in the league, then "Compare"; at most 4 can be selected', async () => {
    const { lastParams } = renderPage({ Page: DagsPage, initial: {} });
    const table = await screen.findByRole('table', { name: 'DAG league table' });
    expect(screen.getByRole('button', { name: 'Compare' })).toBeDisabled();
    await userEvent.click(within(table).getByRole('checkbox', { name: 'Select orders_daily to compare' }));
    await userEvent.click(
      within(table).getByRole('checkbox', { name: 'Select fraud_scoring_hourly to compare' }),
    );
    expect(lastParams()).toEqual({ compare: 'orders_daily,fraud_scoring_hourly' });
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Compare 2 DAGs' })).toHaveAttribute(
        'href',
        '#/compare/dags?env=acme-prod&dags=acme-prod%3Aorders_daily%2Cacme-prod%3Afraud_scoring_hourly',
      ),
    );
  });

  it('FR-DAGD-08: with 4 selected, the other rows cannot be selected', async () => {
    renderPage({
      Page: DagsPage,
      initial: { compare: 'orders_daily,fraud_scoring_hourly,partner_crm_sync,idle_export' },
    });
    const table = await screen.findByRole('table', { name: 'DAG league table' });
    expect(within(table).getByRole('checkbox', { name: 'Select orders_daily to compare' })).toBeChecked();
    expect(screen.getByRole('link', { name: 'Compare 4 DAGs' })).toBeInTheDocument();
    expect(screen.getByText(/You can compare up to 4 DAGs/)).toBeInTheDocument();
  });
});
