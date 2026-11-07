import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import type { Bottlenecks } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { linkTo } from '../src/router';
import { BottlenecksPage } from '../src/pages/bottlenecks/BottlenecksPage';
import { BOTTLENECK_EXPLANATIONS } from '../src/pages/bottlenecks/explanations';
import { DEPTH_EXPLANATIONS } from '../src/pages/bottlenecks/explanations-depth';

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
      top_contributors: [
        { dag_id: 'partner_crm_sync', waiting_task_seconds: 7_200, share: 2 / 3 },
        { dag_id: 'partner_tax_sync', waiting_task_seconds: 3_600, share: 1 / 3 },
      ],
      top_pools: [{ pool: 'external_api', waiting_task_seconds: 10_800, share: 1 }],
    },
    {
      id: 'executor-slots-exhausted',
      phase: 'post-queue',
      waiting_task_seconds: 3_600,
      share: 0.25,
      evaluated: true,
      top_contributors: [{ dag_id: 'orders_daily', waiting_task_seconds: 3_600, share: 1 }],
      top_pools: [{ pool: 'default_pool', waiting_task_seconds: 3_600, share: 1 }],
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
    {
      name: 'external_api',
      slots: 4,
      waiting_task_seconds: 10_800,
      starved_minutes: 60,
      utilisation_p95: 1,
      running_slots_avg: 3.5,
      running_slots_peak: 4,
      queued_slots_avg: 0.5,
      ready_task_seconds: 10_800,
      queued_task_seconds: 1_800,
      top_dags: [{ dag_id: 'partner_crm_sync', waiting_task_seconds: 8_000, share: 0.63 }],
      starved_series: [1, null, 0.5],
    },
    {
      name: 'ml',
      slots: 8,
      waiting_task_seconds: 0,
      starved_minutes: 0,
      utilisation_p95: null,
      running_slots_avg: null,
      running_slots_peak: null,
      queued_slots_avg: null,
      ready_task_seconds: 0,
      queued_task_seconds: 0,
      top_dags: [],
      starved_series: [null, null, null],
    },
  ],
  capacity: {
    capacity_bound_minutes: 60,
    minutes_at_max_workers: 60,
    scale_up_lag_p95_seconds: 120,
    utilisation_p95: 1,
    worker_samples: 60,
  },
  sensors: [],
  noisy_neighbours: {
    method: 'HM-017/range',
    evaluated: true,
    not_evaluated_reason: null,
    minutes_with_slots: 60,
    candidates: 3,
    qualified: 2,
    active_share: 0.1,
    min_active_minutes: 60,
    min_affected_tries: 200,
    min_control_tries: 200,
    resamples: 1_000,
    items: [
      {
        dag_id: 'search_index_rebuild',
        active_minutes: 173,
        affected_tries: 819,
        control_tries: 2_675,
        matched_share: 0.97,
        median_wait_active_seconds: 25,
        median_wait_inactive_seconds: 15,
        effect_seconds: 10,
        ci_low_seconds: 5,
        ci_high_seconds: 15,
        confidence: 'high',
        associated_wait_task_minutes: 136.5,
        overlap_windows: [{ from: T(30), to: T(45) }],
      },
      {
        dag_id: 'payments_daily',
        active_minutes: 414,
        affected_tries: 275,
        control_tries: 210,
        matched_share: 0.6,
        median_wait_active_seconds: 22,
        median_wait_inactive_seconds: 20,
        effect_seconds: 2,
        ci_low_seconds: -5,
        ci_high_seconds: 9,
        confidence: 'low',
        associated_wait_task_minutes: 9.2,
        overlap_windows: [],
      },
    ],
  },
  priority_fairness: {
    method: 'HM-023/observed-wait',
    starvation_ratio_evaluated: false,
    not_evaluated_reason: 'The starvation ratio needs a 28-day baseline; it is not computed.',
    pools: [
      {
        pool: 'external_api',
        tries: 40,
        distinct_weights: 2,
        bands: [
          {
            band: 'low',
            min_weight: 1,
            max_weight: 1,
            tries: 25,
            wait_p50_seconds: 900,
            wait_p95_seconds: 1_800,
            p95_low_sample: false,
          },
          {
            band: 'high',
            min_weight: 3,
            max_weight: 3,
            tries: 15,
            wait_p50_seconds: 60,
            wait_p95_seconds: 120,
            p95_low_sample: true,
          },
        ],
      },
      { pool: 'default_pool', tries: 12, distinct_weights: 1, bands: [] },
    ],
  },
};

const reject = () => Promise.reject(new Error('not in this test'));
const apiFor = (data: Bottlenecks): DcamApi => ({
  getMeta: reject,
  getOverview: reject,
  getDagLeague: reject,
  getDagDetail: reject,
  getBottlenecks: async () => data,
  getSchedule: reject,
  getFindings: reject,
  getAlerts: reject,
  getFleet: reject,
  getCollection: reject,
});

function renderPage(data: Bottlenecks = fixture) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <BottlenecksPage
          api={apiFor(data)}
          envId="acme-prod"
          route={{ page: 'bottlenecks' }}
          linkTo={(r) => linkTo(r, 'acme-prod')}
          navigate={() => {}}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const panel = async (title: string) => screen.findByRole('region', { name: title });

describe('S-16 bottleneck evidence (M3 demo steps 2–3)', () => {
  it('FR-BOTL-01: top contributors list the DAGs and the pools of the selected reason, with shares', async () => {
    renderPage();
    const p = await panel('Top contributors');
    const dags = within(p).getByRole('table', { name: 'DAGs that waited most' });
    expect(within(dags).getByRole('link', { name: 'partner_crm_sync' })).toHaveAttribute(
      'href',
      '#/dags/partner_crm_sync?env=acme-prod',
    );
    expect(within(dags).getByRole('row', { name: /partner_crm_sync/ })).toHaveTextContent('66.7%');
    const pools = within(p).getByRole('table', { name: 'Pools that waited most' });
    expect(within(pools).getByRole('row', { name: /external_api/ })).toHaveTextContent('100%');
    await userEvent.click(within(p).getByRole('button', { name: /Executor slots exhausted/ }));
    expect(within(p).getByRole('link', { name: 'orders_daily' })).toBeInTheDocument();
    expect(within(p).getByRole('table', { name: 'Pools that waited most' })).toHaveTextContent(
      'default_pool',
    );
  });

  it('FR-BOTL-06 / HM-017: noisy neighbours show effect, interval, confidence and overlap, worded as association', async () => {
    renderPage();
    const p = await panel('Noisy neighbours');
    const row = within(p).getByRole('row', { name: /search_index_rebuild/ });
    expect(row).toHaveTextContent('+10s');
    expect(row).toHaveTextContent('5s to 15s');
    expect(row).toHaveTextContent('High');
    expect(row).toHaveTextContent('819');
    expect(row).toHaveTextContent('11:30–11:45');
    expect(within(p).getByRole('row', { name: /payments_daily/ })).toHaveTextContent('Low');
    expect(p).toHaveTextContent(/associated with/i);
    expect(p).not.toHaveTextContent(/\bcaus(es|ed)\b/i);
    expect(within(p).getByText(/Data as of/)).toBeInTheDocument();
  });

  it('FR-UI-07: noisy neighbours say why nothing was evaluated, and why nothing qualified', async () => {
    const { unmount } = renderPage({
      ...fixture,
      noisy_neighbours: {
        ...(fixture.noisy_neighbours as NonNullable<Bottlenecks['noisy_neighbours']>),
        evaluated: false,
        not_evaluated_reason: 'worker_concurrency is not known (no override in the Composer configuration).',
        items: [],
      },
    });
    expect(await panel('Noisy neighbours')).toHaveTextContent('worker_concurrency is not known');
    unmount();
    renderPage({
      ...fixture,
      noisy_neighbours: {
        ...(fixture.noisy_neighbours as NonNullable<Bottlenecks['noisy_neighbours']>),
        qualified: 0,
        items: [],
      },
    });
    const p = await panel('Noisy neighbours');
    expect(p).toHaveTextContent(/No DAG met the minimum samples/);
    expect(p).toHaveTextContent(/60 active minutes/);
  });

  it('FR-ENV-08: the pools table shows slots used, queued, ready and queued waiting, starvation and top DAGs; gaps are not zero', async () => {
    renderPage();
    const p = await panel('Pools');
    const table = within(p).getByRole('table', { name: 'Pools' });
    const api = within(table).getByRole('row', { name: /external_api/ });
    expect(api).toHaveTextContent('3.5 / 4');
    expect(api).toHaveTextContent('3.0');
    expect(api).toHaveTextContent('0.5');
    expect(within(api).getByRole('link', { name: 'partner_crm_sync' })).toBeInTheDocument();
    expect(
      within(api).getByRole('img', { name: /Starved minutes per 1-minute bucket for external_api/ }),
    ).toBeInTheDocument();
    const ml = within(table).getByRole('row', { name: /^ml/ });
    expect(ml).toHaveTextContent('No data');
    await userEvent.click(within(p).getByRole('button', { name: 'View starvation as a table' }));
    const series = within(p).getByRole('table', { name: 'Starved minutes per bucket' });
    expect(within(series).getAllByRole('row')).toHaveLength(1 + 3);
    expect(within(series).getAllByText('no snapshot').length).toBeGreaterThan(0);
  });

  it('HM-023: priority bands per pool with observed waits; low sample is marked; the ratio is not computed yet', async () => {
    renderPage();
    const p = await panel('Priority fairness');
    const table = within(p).getByRole('table', { name: 'Observed wait by priority band' });
    const low = within(table).getByRole('row', { name: /Low/ });
    expect(low).toHaveTextContent('15m');
    expect(low).toHaveTextContent('30m');
    expect(within(table).getByRole('row', { name: /High/ })).toHaveTextContent('≤ 2m');
    expect(p).toHaveTextContent(/1 pool uses one priority weight only/);
    expect(p).toHaveTextContent(/starvation ratio needs a 28-day baseline/i);
  });

  it('FR-UI-05: every new panel has an explanation entry on the page', async () => {
    renderPage();
    for (const [id, x] of Object.entries(DEPTH_EXPLANATIONS)) {
      expect(BOTTLENECK_EXPLANATIONS[id as keyof typeof BOTTLENECK_EXPLANATIONS]).toBe(x);
      expect(await screen.findByRole('button', { name: `About ${x.title}` })).toBeInTheDocument();
    }
  });

  it('FR-UI-07: a server without the evidence fields still renders the page', async () => {
    // An older server: none of the optional evidence fields.
    const older = structuredClone(fixture);
    delete older.noisy_neighbours;
    delete older.priority_fairness;
    for (const r of older.reasons) delete r.top_pools;
    renderPage(older);
    expect(await screen.findByText(/of waiting task-time was caused by/)).toBeInTheDocument();
    expect(await panel('Noisy neighbours')).toHaveTextContent(/not available/i);
  });
});
