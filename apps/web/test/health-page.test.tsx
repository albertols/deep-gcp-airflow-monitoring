import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import type { Collection, CollectionEnvironment, CollectorStatus } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { linkTo } from '../src/router';
import { COLLECTION_POLL_MS as POLL_MS } from '../src/components/collection';
import { HealthPage } from '../src/pages/health/HealthPage';
import {
  COLLECTOR_COLUMNS,
  FOOTPRINT_COLUMNS,
  HEALTH_EXPLANATIONS,
  HEALTH_PANELS,
} from '../src/pages/health/explanations';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

const collector = (over: Partial<CollectorStatus>): CollectorStatus => ({
  id: 'af.live',
  source: 'SRC-AF-API',
  state: 'ok',
  cadence_seconds: 30,
  last_attempt_at: at(10),
  last_success_at: at(10),
  next_run_at: at(-20),
  lag_seconds: 12,
  consecutive_failures: 0,
  error_rate_1h: 0,
  last_error: null,
  ...over,
});

const environment = (over: Partial<CollectionEnvironment>): CollectionEnvironment => ({
  env_id: 'acme-prod',
  profile: 'standard',
  reduced_fidelity: false,
  failing: false,
  collectors: [collector({})],
  footprint: [
    {
      api: 'airflow',
      budget_per_minute: 12,
      requests_1h: 540,
      requests_24h: 12_960,
      errors_24h: 4,
      bytes_24h: 52_400_000,
      p95_latency_ms: 180,
    },
    {
      api: 'monitoring',
      budget_per_minute: 30,
      requests_1h: 60,
      requests_24h: 1_440,
      errors_24h: 0,
      bytes_24h: 3_100,
      p95_latency_ms: null,
    },
  ],
  series_24h: 2_880,
  ...over,
});

const LIVE: Collection = {
  mode: 'live',
  generated_at: at(0),
  environments: [
    environment({
      reduced_fidelity: true,
      failing: true,
      collectors: [
        collector({}),
        collector({
          id: 'composer.config',
          source: 'SRC-COMPOSER',
          state: 'failing',
          cadence_seconds: 600,
          last_success_at: at(5_400),
          lag_seconds: 5_400,
          consecutive_failures: 3,
          error_rate_1h: 0.5,
          last_error: {
            kind: 'permission-denied',
            message: 'The caller does not have permission composer.environments.get.',
            fix_hint:
              'gcloud projects add-iam-policy-binding PROJECT_ID --member=user:EMAIL --role=roles/composer.viewer',
            at: at(60),
          },
        }),
        collector({
          id: 'mon.core',
          source: 'SRC-MON',
          state: 'waiting',
          cadence_seconds: 60,
          last_attempt_at: null,
          last_success_at: null,
          next_run_at: at(5),
          lag_seconds: null,
          error_rate_1h: null,
        }),
      ],
    }),
    environment({
      env_id: 'acme-dev',
      profile: 'eco',
      collectors: [
        collector({ id: 'af.live', state: 'degraded', consecutive_failures: 1 }),
        collector({
          id: 'mon.core',
          source: 'SRC-MON',
          state: 'disabled',
          cadence_seconds: 0,
          last_attempt_at: null,
          last_success_at: null,
          next_run_at: null,
          lag_seconds: null,
          error_rate_1h: null,
        }),
      ],
      series_24h: null,
    }),
  ],
};
const DEMO: Collection = { mode: 'demo', generated_at: at(0), environments: [] };

const reject = () => Promise.reject(new Error('not in this test'));
function fakeApi(getCollection: DcamApi['getCollection']): DcamApi {
  return {
    getMeta: reject,
    getOverview: reject,
    getDagLeague: reject,
    getDagDetail: reject,
    getBottlenecks: reject,
    getFindings: reject,
    getAlerts: reject,
    getFleet: reject,
    getCollection,
  };
}

function renderPage(api: DcamApi, envId = 'acme-prod') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <HealthPage
          api={api}
          envId={envId}
          route={{ page: 'health' }}
          linkTo={(r) => linkTo(r, envId)}
          navigate={() => {}}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return client;
}

/** The polling interval the page asked TanStack Query for, resolved for the current data. */
function refetchInterval(client: QueryClient) {
  const query = client.getQueryCache().find({ queryKey: ['collection'] });
  if (!query) return undefined;
  const interval = query.observers[0]?.options.refetchInterval;
  return typeof interval === 'function' ? interval(query) : interval;
}

describe('DCAM health page (FR-SELF-01, FR-COLL-11, HM-030)', () => {
  it('FR-SELF-01: shows one section per environment with its collection profile', async () => {
    renderPage(fakeApi(async () => LIVE));
    expect(await screen.findByRole('heading', { level: 1, name: 'DCAM health' })).toBeInTheDocument();
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    expect(within(prod).getByText('Standard profile')).toBeInTheDocument();
    const dev = screen.getByRole('region', { name: 'acme-dev' });
    expect(within(dev).getByText('Eco profile')).toBeInTheDocument();
  });

  it('FR-COLL-11: the selected environment comes first, where its header badge leads', async () => {
    renderPage(
      fakeApi(async () => LIVE),
      'acme-dev',
    );
    await screen.findByRole('region', { name: 'acme-dev' });
    const names = screen
      .getAllByRole('region')
      .map((r) => r.getAttribute('aria-labelledby'))
      .filter((id) => id?.startsWith('health-acme'));
    expect(names).toEqual(['health-acme-dev', 'health-acme-prod']);
  });

  it('FR-COLL-11: each collector shows its state as an icon and a label, never colour alone', async () => {
    renderPage(fakeApi(async () => LIVE));
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    const table = within(prod).getByRole('table', { name: 'Collectors for acme-prod' });
    const failing = within(table).getByRole('row', { name: /composer\.config/ });
    expect(within(failing).getByText('Failing')).toBeInTheDocument();
    expect(within(failing).getByTestId('collector-state-failing')).toBeInTheDocument();
    expect(within(failing).getByText('Cloud Composer API')).toBeInTheDocument();
    expect(within(failing).getByText('every 10m')).toBeInTheDocument();
    expect(within(failing).getByText('50%')).toBeInTheDocument(); // error rate in the last hour
    expect(within(failing).getByText('3')).toBeInTheDocument(); // consecutive failures
    expect(within(failing).getByText('1h 30m')).toBeInTheDocument(); // lag
    const ok = within(table).getByRole('row', { name: /af\.live/ });
    expect(within(ok).getByText('OK')).toBeInTheDocument();
    expect(within(ok).getByTestId('collector-state-ok')).toBeInTheDocument();
    const waiting = within(table).getByRole('row', { name: /mon\.core/ });
    expect(within(waiting).getByText('Waiting')).toBeInTheDocument();
    expect(within(waiting).getByText('Never')).toBeInTheDocument();
  });

  it('FR-COLL-11: the last success is a relative time, with the absolute time in a tooltip', async () => {
    renderPage(fakeApi(async () => LIVE));
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    const row = within(prod).getByRole('row', { name: /composer\.config/ });
    const time = within(row).getByText('1h 30m ago');
    expect(time.closest('time')).toHaveAttribute('dateTime', at(5_400));
    await userEvent.hover(time);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(new Date(at(5_400)).toUTCString());
  });

  it('FR-COLL-11: shows when each collector runs next, relative to the status time', async () => {
    renderPage(fakeApi(async () => LIVE));
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    const ok = within(prod).getByRole('row', { name: /af\.live/ });
    expect(within(ok).getByText('in 20s').closest('time')).toHaveAttribute('dateTime', at(-20));
    const overdue = within(prod).getByRole('row', { name: /mon\.core/ });
    expect(within(overdue).getByText('Due now')).toBeInTheDocument();
    const dev = screen.getByRole('region', { name: 'acme-dev' });
    const disabled = within(dev).getByRole('row', { name: /mon\.core/ });
    expect(within(disabled).getByText('Disabled')).toBeInTheDocument();
    expect(within(disabled).getByText('Not scheduled')).toBeInTheDocument();
  });

  it('FR-COLL-11: the last error comes with its fix hint in a copyable block', async () => {
    renderPage(fakeApi(async () => LIVE));
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    const row = within(prod).getByRole('row', { name: /composer\.config/ });
    expect(within(row).getByText(/does not have permission composer\.environments\.get/)).toBeInTheDocument();
    expect(within(row).getByText('permission-denied')).toBeInTheDocument();
    expect(within(row).getByText(/--role=roles\/composer\.viewer/).tagName).toBe('CODE');
    expect(within(row).getByRole('button', { name: 'Copy the fix for composer.config' })).toBeInTheDocument();
  });

  it('FR-COLL-11: a failing environment says so and what to do next', async () => {
    renderPage(fakeApi(async () => LIVE));
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    const alert = within(prod).getByText('Collection failing').closest('[role="alert"]');
    expect(alert).toHaveTextContent(/three or more cycles in a row/);
    expect(alert).toHaveTextContent(/pnpm dcam doctor/);
    const dev = screen.getByRole('region', { name: 'acme-dev' });
    expect(within(dev).queryByText('Collection failing')).toBeNull();
  });

  it('FR-COLL-06: reduced fidelity explains that DCAM slowed down to stay within its request budget', async () => {
    renderPage(fakeApi(async () => LIVE));
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    const notice = within(prod).getByText('Reduced fidelity').closest('[role="alert"]');
    expect(notice).toHaveTextContent(/slowed collection to stay within its request budget/);
    const dev = screen.getByRole('region', { name: 'acme-dev' });
    expect(within(dev).queryByText('Reduced fidelity')).toBeNull();
  });

  it('HM-030: the footprint table shows requests against the budget, errors, bytes and p95 latency per API', async () => {
    renderPage(fakeApi(async () => LIVE));
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    const table = within(prod).getByRole('table', { name: 'Requests to each API from acme-prod' });
    const airflow = within(table).getByRole('row', { name: /Airflow REST API/ });
    expect(within(airflow).getByText('12 per min')).toBeInTheDocument();
    expect(within(airflow).getByText('540')).toBeInTheDocument();
    expect(within(airflow).getByText('75% of 720')).toBeInTheDocument(); // 540 of 12 × 60
    expect(within(airflow).getByText('12,960')).toBeInTheDocument();
    expect(within(airflow).getByText('75% of 17,280')).toBeInTheDocument();
    expect(within(airflow).getByText('4')).toBeInTheDocument();
    expect(within(airflow).getByText('52.4 MB')).toBeInTheDocument();
    expect(within(airflow).getByText('180 ms')).toBeInTheDocument();
    const monitoring = within(table).getByRole('row', { name: /Cloud Monitoring/ });
    expect(within(monitoring).getByText('3.1 kB')).toBeInTheDocument();
    expect(within(monitoring).getAllByText('—').length).toBeGreaterThan(0); // no latency yet
  });

  it('NFR-OBS-06: shows the Cloud Monitoring series count, or "not used" without Monitoring', async () => {
    renderPage(fakeApi(async () => LIVE));
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    expect(within(prod).getByText('2,880')).toHaveTextContent('2,880 series');
    const dev = screen.getByRole('region', { name: 'acme-dev' });
    expect(within(dev).getByText('Not used')).toBeInTheDocument();
  });

  it('FR-SELF-01: demo mode explains that demo data is simulated, nothing is collected, and how to see real data', async () => {
    renderPage(fakeApi(async () => DEMO));
    const note = await screen.findByRole('region', { name: 'Demo mode collects nothing' });
    expect(note).toHaveTextContent(/Demo data is simulated/);
    expect(note).toHaveTextContent(/DCAM collects nothing and sends no request to Google Cloud or Airflow/);
    expect(within(note).getByText('pnpm dcam')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('FR-SELF-01: live mode with no environment says how to add one', async () => {
    renderPage(fakeApi(async () => ({ ...LIVE, environments: [] })));
    expect(await screen.findByText(/No environments are configured/)).toBeInTheDocument();
  });

  it('FR-SELF-01: polls every 10 s while visible in live mode', async () => {
    const client = renderPage(fakeApi(async () => LIVE));
    await screen.findByRole('region', { name: 'acme-prod' });
    expect(POLL_MS).toBe(10_000);
    expect(refetchInterval(client)).toBe(POLL_MS);
  });

  it('FR-SELF-01: does not poll in demo mode, which has no collectors', async () => {
    const client = renderPage(fakeApi(async () => DEMO));
    await screen.findByRole('region', { name: 'Demo mode collects nothing' });
    expect(refetchInterval(client)).toBe(false);
  });

  it('FR-UI-07: shows the error and what to do next when the status cannot be loaded', async () => {
    renderPage(fakeApi(() => Promise.reject(new Error('Server unavailable'))));
    expect(
      await screen.findByText(/Couldn't load collection health: Server unavailable/),
    ).toBeInTheDocument();
  });

  it('FR-UI-08: names the source and the time of the status', async () => {
    renderPage(fakeApi(async () => LIVE));
    const footer = await screen.findByText(
      (_text, el) =>
        el?.tagName === 'FOOTER' && /Status as of .* DCAM's own request log/.test(el.textContent ?? ''),
    );
    expect(footer).toBeInTheDocument();
  });

  it('FR-UI-05: every number column has an (i) explanation in its header', async () => {
    renderPage(fakeApi(async () => LIVE));
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    const header = (name: string) =>
      within(within(prod).getByRole('table', { name })).getAllByRole('row')[0]!;
    const collectors = header('Collectors for acme-prod');
    for (const id of COLLECTOR_COLUMNS)
      expect(
        within(collectors).getByRole('button', { name: `About ${HEALTH_EXPLANATIONS[id].title}` }),
      ).toBeInTheDocument();
    const footprint = header('Requests to each API from acme-prod');
    for (const id of FOOTPRINT_COLUMNS)
      expect(
        within(footprint).getByRole('button', { name: `About ${HEALTH_EXPLANATIONS[id].title}` }),
      ).toBeInTheDocument();
    expect(COLLECTOR_COLUMNS.length + FOOTPRINT_COLUMNS.length).toBe(12);
  });

  it('FR-UI-05: every panel has an explanation, and each environment shows its (i) buttons', async () => {
    for (const id of HEALTH_PANELS) expect(HEALTH_EXPLANATIONS[id], id).toBeDefined();
    renderPage(fakeApi(async () => LIVE));
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    for (const id of HEALTH_PANELS)
      expect(
        within(prod).getByRole('button', { name: `About ${HEALTH_EXPLANATIONS[id].title}` }),
      ).toBeInTheDocument();
  });
});
