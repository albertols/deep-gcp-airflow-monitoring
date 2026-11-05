import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Collection, CollectionEnvironment, EnvironmentOverview, Meta } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { App } from '../src/App';
import { COLLECTION_POLL_MS } from '../src/components/collection';

const AT = '2026-11-05T12:00:00.000Z';
const ENVIRONMENTS: Meta['environments'] = [
  { env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' },
  { env_id: 'acme-dev', display_name: 'acme-dev', tier: 'dev' },
  { env_id: 'acme-test', display_name: 'acme-test', tier: 'test' },
];
const LIVE_META: Meta = { name: 'DCAM', version: '0.1.0', mode: 'live', environments: ENVIRONMENTS };
const DEMO_META: Meta = { ...LIVE_META, mode: 'demo' };

const env = (
  env_id: string,
  { failing = false, reduced_fidelity = false }: { failing?: boolean; reduced_fidelity?: boolean } = {},
): CollectionEnvironment => ({
  env_id,
  profile: 'standard',
  reduced_fidelity,
  failing,
  collectors: [],
  footprint: [],
  series_24h: null,
});
const COLLECTION: Collection = {
  mode: 'live',
  generated_at: AT,
  environments: [
    env('acme-prod', { failing: true }),
    env('acme-dev'),
    env('acme-test', { reduced_fidelity: true }),
  ],
};
const overview: EnvironmentOverview = {
  env_id: 'acme-prod',
  range: { from: '2026-11-04T12:00:00.000Z', to: AT },
  data_as_of: AT,
  sources: ['SRC-AF-API'],
  approximate: false,
  total_executor_slot_seconds: 3_600,
  peak_concurrency: 4,
  dag_count: 3,
  pareto_80_dag_count: 1,
  top_dags: [],
};

const reject = () => Promise.reject(new Error('not in this test'));
function fakeApi(meta: Meta) {
  const getCollection = vi.fn(async () => COLLECTION);
  const api: DcamApi = {
    getMeta: async () => meta,
    getOverview: async () => overview,
    getDagLeague: reject,
    getDagDetail: reject,
    getBottlenecks: reject,
    getFindings: reject,
    getAlerts: reject,
    getFleet: reject,
    getCollection,
  };
  return { api, getCollection };
}

function renderApp(api: DcamApi) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <App api={api} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return client;
}

/** The polling interval the shell asked TanStack Query for, resolved for the current data. */
function refetchInterval(client: QueryClient) {
  const query = client.getQueryCache().find({ queryKey: ['collection'] });
  if (!query) return undefined;
  const interval = query.observers[0]?.options.refetchInterval;
  return typeof interval === 'function' ? interval(query) : interval;
}

afterEach(() => {
  window.location.hash = '';
});

describe('live mode in the shell (FR-COLL-11, FR-SELF-01)', () => {
  it('FR-COLL-11: live mode shows a "Live" chip with an icon, and no demo banner', async () => {
    renderApp(fakeApi(LIVE_META).api);
    const banner = await screen.findByRole('banner');
    const chip = await within(banner).findByText('Live');
    expect(chip.closest('.MuiChip-root')?.querySelector('svg')).not.toBeNull();
    expect(screen.queryByText(/demo data for the fictitious "acme" organisation/i)).toBeNull();
    expect(within(banner).queryByText('Demo data')).toBeNull();
  });

  it('FR-EMU-01: demo mode keeps its banner and shows no "Live" chip or collection badge', async () => {
    const { api, getCollection } = fakeApi(DEMO_META);
    renderApp(api);
    expect(await screen.findByText(/demo data for the fictitious "acme" organisation/i)).toBeInTheDocument();
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('Demo data')).toBeInTheDocument();
    expect(within(banner).queryByText('Live')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Collection failing' })).toBeNull();
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('FR-COLL-11: a failing selected environment shows "Collection failing" next to it, linking to DCAM health', async () => {
    renderApp(fakeApi(LIVE_META).api);
    const banner = await screen.findByRole('banner');
    const badge = await within(banner).findByRole('link', { name: 'Collection failing' });
    expect(badge).toHaveAttribute('href', '#/health?env=acme-prod');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(within(banner).queryByRole('link', { name: 'Reduced fidelity' })).toBeNull();
  });

  it('FR-COLL-06: a selected environment with reduced fidelity says so, linking to DCAM health', async () => {
    window.location.hash = '#/?env=acme-test';
    renderApp(fakeApi(LIVE_META).api);
    const banner = await screen.findByRole('banner');
    const badge = await within(banner).findByRole('link', { name: 'Reduced fidelity' });
    expect(badge).toHaveAttribute('href', '#/health?env=acme-test');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(within(banner).queryByRole('link', { name: 'Collection failing' })).toBeNull();
  });

  it('FR-COLL-11: no badge when the selected environment collects normally', async () => {
    window.location.hash = '#/?env=acme-dev';
    const { api, getCollection } = fakeApi(LIVE_META);
    renderApp(api);
    expect(await screen.findByRole('combobox', { name: 'Environment' })).toHaveTextContent('acme-dev');
    await vi.waitFor(() => expect(getCollection).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Collection failing' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Reduced fidelity' })).toBeNull();
  });

  it('FR-SELF-01: live mode refreshes the collection status every 10 s on every page', async () => {
    const { api, getCollection } = fakeApi(LIVE_META);
    const client = renderApp(api);
    await screen.findByRole('link', { name: 'Collection failing' });
    expect(getCollection).toHaveBeenCalledTimes(1);
    expect(refetchInterval(client)).toBe(COLLECTION_POLL_MS);
    expect(COLLECTION_POLL_MS).toBe(10_000);
  });

  it('FR-SELF-01: the navigation links to DCAM health, which opens the page', async () => {
    renderApp(fakeApi(LIVE_META).api);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await screen.findByRole('combobox', { name: 'Environment' });
    const link = within(nav).getByRole('link', { name: /^DCAM health/ });
    expect(link).toHaveAttribute('href', '#/health?env=acme-prod');
    await userEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'DCAM health' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'acme-prod' })).toBeInTheDocument();
  });
});
