import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import type { Bottlenecks } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { EnvironmentPlaceContext } from '../src/components/OpenInMenu';
import { linkTo } from '../src/router';
import { BottlenecksPage } from '../src/pages/bottlenecks/BottlenecksPage';
import { BOTTLENECK_EXPLANATIONS, BOTTLENECK_PANELS } from '../src/pages/bottlenecks/explanations';
import { REASONS } from '../src/pages/bottlenecks/reasons';

const T = (min: number) => new Date(Date.UTC(2026, 10, 5, 11, min)).toISOString();
const fixture: Bottlenecks = {
  env_id: 'acme-prod',
  range: { from: T(0), to: T(60) },
  data_as_of: T(59),
  sources: ['DEMO'],
  bucket_seconds: 60,
  snapshot_interval_seconds: 30,
  waiting_task_seconds: 14_400,
  normal_latency_task_seconds: 600,
  answer: { reason: 'pool-exhausted', share: 0.75, workers_at_max_share: 0.2, advice_withheld: null },
  reasons: [
    {
      id: 'pool-exhausted',
      phase: 'pre-queue',
      waiting_task_seconds: 10_800,
      share: 0.75,
      evaluated: true,
      top_contributors: [{ dag_id: 'partner_crm_sync', waiting_task_seconds: 7_200, share: 2 / 3 }],
    },
    {
      id: 'executor-slots-exhausted',
      phase: 'post-queue',
      waiting_task_seconds: 3_600,
      share: 0.25,
      evaluated: true,
      top_contributors: [{ dag_id: 'orders_daily', waiting_task_seconds: 3_600, share: 1 }],
    },
    {
      id: 'triggerer-capacity',
      phase: 'deferral',
      waiting_task_seconds: 0,
      share: 0,
      evaluated: false,
      top_contributors: [],
    },
  ],
  series: [0, 1, 2].map((i) => ({
    start: T(i),
    waiting_task_seconds: { 'pool-exhausted': 180, 'executor-slots-exhausted': 60 },
    workers: 2,
    worker_slots_used: 1,
  })),
  current: {
    at: T(59),
    binding: 'pool-exhausted',
    scheduled: 3,
    queued: 1,
    running: 8,
    workers: { current: 2, target: 2, min: 1, max: 2 },
    worker_slots: 8,
  },
  pools: [
    { name: 'external_api', slots: 1, waiting_task_seconds: 10_800, starved_minutes: 60, utilisation_p95: 1 },
  ],
  capacity: {
    capacity_bound_minutes: 60,
    minutes_at_max_workers: 60,
    scale_up_lag_p95_seconds: 120,
    utilisation_p95: 1,
    worker_samples: 60,
  },
  sensors: [{ dag_id: 'partner_feed_wait', task_id: 'wait_for_1_1', slot_seconds: 1_200 }],
};

const reject = () => Promise.reject(new Error('not in this test'));
const apiFor = (data: Bottlenecks): DcamApi => ({
  getMeta: reject,
  getOverview: reject,
  getDagLeague: reject,
  getDagDetail: reject,
  getBottlenecks: async () => data,
  getSchedule: reject,
  getDagComparison: reject,
  getRunComparison: reject,
  getCapacity: reject,
  getForecast: reject,
  getFindings: reject,
  getAlerts: reject,
  getFleet: reject,
  getCollection: reject,
});

/** The KPI card whose (i) title is `title`. */
const kpi = async (title: string) => {
  const heading = await screen.findByRole('heading', { name: title });
  const card = heading.closest('.MuiPaper-root');
  if (!(card instanceof HTMLElement)) throw new Error(`No KPI card for ${title}`);
  return card;
};

function renderPage(data: Bottlenecks = fixture) {
  const api = apiFor(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <BottlenecksPage
          api={api}
          envId="acme-prod"
          route={{ page: 'bottlenecks' }}
          linkTo={(r) => linkTo(r, 'acme-prod')}
          navigate={() => {}}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('S-16 bottlenecks page (FR-BOTL-01)', () => {
  it('FR-BOTL-01: answers in one sentence which limit caused most waiting', async () => {
    renderPage();
    const answer = await screen.findByText(/of waiting task-time was caused by/);
    expect(answer).toHaveTextContent('75% of waiting task-time was caused by "Pool exhausted"');
  });

  it('FR-BOTL-01: lists reasons with their share and top contributors, and marks reasons not collected yet', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Waiting by reason' });
    const pool = within(table).getByRole('row', { name: /Pool exhausted/ });
    expect(within(pool).getByText('75%')).toBeInTheDocument();
    expect(within(pool).getByRole('link', { name: 'partner_crm_sync' })).toHaveAttribute(
      'href',
      '#/dags/partner_crm_sync?env=acme-prod',
    );
    const triggerer = within(table).getByRole('row', { name: /Triggerer capacity/ });
    expect(within(triggerer).getByText(/Not collected yet/)).toBeInTheDocument();
  });

  it('§12.8: the waiting chart has a legend, an accessible description and a table view', async () => {
    renderPage();
    const chart = await screen.findByRole('img', { name: /Waiting task-minutes per 1-minute bucket/ });
    expect(chart).toBeInTheDocument();
    const legend = screen.getByRole('list', { name: 'Legend: waiting by reason' });
    expect(within(legend).getByText('Pool exhausted')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View waiting as a table' }));
    const table = screen.getByRole('table', { name: 'Waiting task-minutes per bucket' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 3);
  });

  it('REC-CONC-02 / HM-008: shows pool starvation and sensor slot time', async () => {
    renderPage();
    const pools = await screen.findByRole('table', { name: 'Pools' });
    expect(within(pools).getByRole('row', { name: /external_api/ })).toHaveTextContent('60');
    expect(screen.getByRole('link', { name: 'partner_feed_wait' })).toBeInTheDocument();
  });

  it('FR-UI-05: every panel and reason has an explanation', () => {
    for (const id of BOTTLENECK_PANELS) expect(BOTTLENECK_EXPLANATIONS[id]).toBeDefined();
    for (const r of Object.values(REASONS)) expect(r.description.length).toBeGreaterThan(20);
  });

  it('HM-032: capacity-bound minutes show "Not known yet" while worker_concurrency is unknown, not 0 min', async () => {
    renderPage({
      ...fixture,
      current: { ...fixture.current, worker_slots: null },
      capacity: { ...fixture.capacity, capacity_bound_minutes: null },
    });
    const card = await kpi('Capacity-bound minutes');
    expect(card).toHaveTextContent('Not known yet');
    expect(card).toHaveTextContent(/worker_concurrency is not known/);
    expect(card).not.toHaveTextContent(/\d+\s*min/);
  });

  it('FR-BOTL-01: the footer names the af.live cadence DCAM observed, and says when it has none', async () => {
    const { unmount } = renderPage({ ...fixture, snapshot_interval_seconds: 10 });
    expect(await screen.findByRole('contentinfo')).toHaveTextContent('live snapshots every 10 s');
    unmount();
    renderPage({ ...fixture, snapshot_interval_seconds: null });
    const footer = await screen.findByRole('contentinfo');
    expect(footer).toHaveTextContent('fewer than two live snapshots in this range');
    expect(footer).not.toHaveTextContent(/every \d+ s/);
  });

  it('§8.1: without Cloud Monitoring worker samples the capacity KPIs say "No data", never 0 min', async () => {
    renderPage({
      ...fixture,
      capacity: {
        ...fixture.capacity,
        minutes_at_max_workers: null,
        capacity_bound_minutes: null,
        scale_up_lag_p95_seconds: null,
        utilisation_p95: null,
        worker_samples: 0,
      },
    });
    for (const title of ['Minutes at max workers', 'Capacity-bound minutes']) {
      const card = await kpi(title);
      expect(card).toHaveTextContent('No data');
      expect(card).toHaveTextContent('Needs Cloud Monitoring worker samples');
      expect(card).not.toHaveTextContent(/\d+\s*min/);
    }
    expect(await kpi('Scale-up lag (p95)')).toHaveTextContent('Needs Cloud Monitoring worker samples');
  });

  it('§13.2: below the advisor data gate the headline states the cause but gives no advice', async () => {
    renderPage({
      ...fixture,
      answer: {
        reason: 'parallelism',
        share: 0.49,
        workers_at_max_share: 1,
        advice_withheld: 'Only 2% of the window has live snapshots; the rule needs 80%.',
      },
    });
    const answer = await screen.findByText(/of waiting task-time was caused by/);
    expect(answer).toHaveTextContent('49% of waiting task-time was caused by "Global parallelism"');
    expect(answer).toHaveTextContent(
      'No advice yet. Only 2% of the window has live snapshots; the rule needs 80%.',
    );
    expect(answer).not.toHaveTextContent(REASONS.parallelism.action);
  });
});

describe('"Open in" on the bottleneck page (FR-UI-04)', () => {
  it('FR-UI-04: opens the Airflow pools list and the environment logs over the range of the analysis', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const place = {
      composer: { project_id: 'acme-prod-123', location: 'us-central1', environment: 'acme-composer-prod' },
      airflow_uri: 'https://acme-composer-prod.airflow.example',
    };
    render(
      <ThemeProvider theme={createDcamTheme('dark')}>
        <QueryClientProvider client={client}>
          <EnvironmentPlaceContext.Provider value={{ mode: 'live', place }}>
            <BottlenecksPage
              api={apiFor(fixture)}
              envId="acme-prod"
              route={{ page: 'bottlenecks' }}
              linkTo={(r) => linkTo(r, 'acme-prod')}
              navigate={() => {}}
            />
          </EnvironmentPlaceContext.Provider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Open in' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /^Pools/ })).toHaveAttribute(
      'href',
      'https://acme-composer-prod.airflow.example/pool/list/',
    );
    const logs = within(menu).getByRole('menuitem', { name: /Logs Explorer: environment logs/ });
    expect(decodeURIComponent(logs.getAttribute('href') ?? '')).toContain(
      `timestamp>="${fixture.range.from}"`,
    );
  });
});
