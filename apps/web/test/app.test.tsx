import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterEach, describe, expect, it } from 'vitest';
import type { EnvironmentOverview, Meta } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { App } from '../src/App';
import { EXPLANATIONS } from '../src/explanations';
import { PANELS } from '../src/OverviewPage';

const meta: Meta = {
  name: 'DCAM',
  version: '0.0.0',
  mode: 'demo',
  environments: [
    { env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' },
    { env_id: 'acme-dev', display_name: 'acme-dev', tier: 'dev' },
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
  pareto_80_dag_count: 23,
  top_dags: [{ dag_id: 'orders_daily', executor_slot_seconds: 7_200, share: 0.2 }],
};
const notYet = () => Promise.reject(new Error('not in this test'));
const api: DcamApi = {
  getMeta: async () => meta,
  getOverview: async () => overview,
  getDagLeague: notYet,
  getDagDetail: notYet,
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

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <App api={api} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('M0 app shell', () => {
  it('FR-EMU-01: shows a persistent demo-data banner in demo mode', async () => {
    renderApp();
    expect(await screen.findByText(/demo data for the fictitious "acme" organisation/i)).toBeInTheDocument();
  });

  it('HM-003 / FR-DAGX-03: renders the capacity KPIs and the top DAGs', async () => {
    renderApp();
    expect(await screen.findByText('10.0')).toBeInTheDocument(); // 36,000 s = 10.0 slot-hours
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('23 of 120')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Top DAGs by slot-hours' });
    expect(within(table).getByText('orders_daily')).toBeInTheDocument();
    expect(within(table).getByText('20%')).toBeInTheDocument();
  });

  it('FR-UI-05: every panel has an explanation, and (i) opens it as a dialog', async () => {
    for (const id of PANELS) expect(EXPLANATIONS[id]).toBeDefined();
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'About Executor slot-hours' }));
    const dialog = await screen.findByRole('dialog', { name: 'Executor slot-hours' });
    expect(within(dialog).getByText(/Deferred time is excluded/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Airflow documentation: pools/ })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  });

  it('FR-UI-08: shows the data source and freshness', async () => {
    renderApp();
    const footer = await screen.findByText(
      (_text, el) => el?.tagName === 'FOOTER' && /Data as of .* Source: demo data/.test(el.textContent ?? ''),
    );
    expect(footer).toBeInTheDocument();
  });
});

describe('FR-UI-06 navigation', () => {
  const PAGES = [
    'Fleet',
    'Capacity overview',
    'DAG league table',
    'Bottlenecks',
    'Advisor',
    'Alerts',
    'DCAM health',
    'Wiki',
  ];

  it('FR-UI-06: every page in the navigation is available', async () => {
    renderApp();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const name of PAGES) {
      const link = within(nav).getByRole('link', { name: new RegExp(`^${name}`) });
      expect(link).not.toHaveAttribute('aria-disabled', 'true');
    }
    expect(within(nav).queryByText(/Coming in/)).toBeNull();
  });

  it('FR-UI-06: links carry the selected environment and open the page', async () => {
    renderApp();
    await screen.findByRole('combobox', { name: 'Environment' }); // metadata loaded
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const link = within(nav).getByRole('link', { name: /^Bottlenecks/ });
    expect(link).toHaveAttribute('href', '#/bottlenecks?env=acme-prod');
    await userEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Bottlenecks' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /^Bottlenecks/ })).toHaveAttribute('aria-current', 'page');
  });

  it('FR-UI-06: opens the page and environment named in the URL', async () => {
    window.location.hash = '#/dags?env=acme-dev';
    renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: 'DAG league table' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveTextContent('acme-dev');
  });
});
