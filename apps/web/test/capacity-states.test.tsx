import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import type { Capacity, Collection, CollectorStatus, Spread } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import { ApiError, type DcamApi } from '../src/api';
import { linkTo } from '../src/router';
import { CapacityPage } from '../src/pages/capacity/CapacityPage';
import {
  CAPACITY_EXPLANATIONS,
  CAPACITY_TAB_PANELS,
  DAG_LOAD_PANELS,
  FORECAST_EXPLANATIONS,
  FORECAST_PANELS,
} from '../src/pages/capacity/explanations';
import { NOW, capacityApi, capacityFixture, unknownConcurrency } from './capacity-fixtures';

function renderPage(api: DcamApi) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <CapacityPage
          api={api}
          envId="acme-prod"
          route={{ page: 'capacity' }}
          linkTo={(r) => linkTo(r, 'acme-prod')}
          navigate={() => {}}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

async function alertWith(text: RegExp) {
  const alert = (await screen.findByText(text)).closest('[role="alert"]');
  if (!(alert instanceof HTMLElement)) throw new Error(`No alert says ${String(text)}`);
  return alert;
}

const NO_SAMPLES: Spread = { p50: null, p95: null, max: null, samples: 0, low_sample: true };
const NO_SCALE_SAMPLES = 'Scale events need Cloud Monitoring worker counts.';

const collector = (id: string, cadence: number, lag: number | null): CollectorStatus => ({
  id,
  source: 'SRC-AF-API',
  state: 'ok',
  cadence_seconds: cadence,
  last_attempt_at: null,
  last_success_at: null,
  next_run_at: null,
  lag_seconds: lag,
  consecutive_failures: 0,
  error_rate_1h: null,
  last_error: null,
});
const live = (collectors: CollectorStatus[]): Collection => ({
  mode: 'live',
  generated_at: new Date(NOW).toISOString(),
  environments: [
    {
      env_id: 'acme-prod',
      profile: 'standard',
      reduced_fidelity: false,
      failing: false,
      collectors,
      footprint: [],
      series_24h: null,
      backfill: [],
    },
  ],
});

describe('S-04 states, explanations and provenance (FR-UI-05, FR-UI-07, FR-UI-08)', () => {
  it('FR-UI-07: while loading, a skeleton names what is loading', async () => {
    renderPage({ ...capacityApi(), getCapacity: () => new Promise<Capacity>(() => {}) });
    expect(await screen.findByLabelText('Loading the capacity analysis')).toBeInTheDocument();
  });

  it('FR-UI-07: an error says what happened and what to do next', async () => {
    renderPage({
      ...capacityApi(),
      getCapacity: () => Promise.reject(new ApiError('Unknown environment "acme-nope".', 404)),
    });
    expect(
      await screen.findByText(
        'Couldn\'t load the capacity analysis: Unknown environment "acme-nope". Check that DCAM is still running, then reload the page.',
      ),
    ).toBeInTheDocument();
  });

  it('FR-UI-07: partial data: a banner lists what is missing and links to DCAM health', async () => {
    renderPage(
      capacityApi({
        ...unknownConcurrency,
        slots_source: 'hostnames',
        summary: { ...unknownConcurrency.summary, observed_minutes: 720, coverage: 0.5 },
        scale_events: { evaluated: false, not_evaluated_reason: NO_SCALE_SAMPLES, up: 0, down: 0, items: [] },
        workloads: [{ workload: 'celery-worker', samples: 0, cpu: NO_SAMPLES, memory: NO_SAMPLES }],
      }),
    );
    const banner = await alertWith(/^Part of the capacity data is missing/);
    for (const line of [
      'Worker figures cover 50% of the last 24 hours: the rest are gaps, not zero.',
      'Worker counts estimated from task instance hostnames: a lower bound, as an idle worker runs no task.',
      'worker_concurrency is not known, so worker slots, utilisation and capacity-bound minutes are not evaluated (HM-032).',
      `Scale events are not evaluated: ${NO_SCALE_SAMPLES}`,
      'No worker CPU and memory samples from Cloud Monitoring in this range.',
    ])
      expect(banner).toHaveTextContent(line);
    expect(within(banner).getByRole('link', { name: /DCAM health/ })).toHaveAttribute(
      'href',
      '#/health?env=acme-prod',
    );
  });

  it('FR-UI-07: empty: without any worker figure the page says why and what to do', async () => {
    const empty: Capacity = {
      ...capacityFixture,
      data_as_of: null,
      sources: [],
      slots_source: null,
      summary: {
        ...capacityFixture.summary,
        observed_minutes: 0,
        coverage: 0,
        utilisation: NO_SAMPLES,
        minutes_at_max_workers: null,
        capacity_bound_minutes: null,
        capacity_bound_share: null,
        running_peak: null,
        queued_peak: null,
        scale_up_lag_seconds: NO_SAMPLES,
      },
      series: capacityFixture.series.map((b) => ({
        start: b.start,
        observed_minutes: 0,
        workers_mean: null,
        workers_max: null,
        target_max: null,
        worker_slots_mean: null,
        running_mean: null,
        running_peak: null,
        queued_mean: null,
        queued_peak: null,
        running_tries_mean: null,
        utilisation_mean: null,
        minutes_at_max: null,
        capacity_bound_minutes: null,
        cpu_max: null,
        memory_max: null,
      })),
      capacity_bound: {
        ...capacityFixture.capacity_bound,
        evaluated: false,
        not_evaluated_reason: 'No worker figures in this range.',
        period_count: 0,
        periods: [],
      },
      scale_events: { evaluated: false, not_evaluated_reason: NO_SCALE_SAMPLES, up: 0, down: 0, items: [] },
      workloads: [{ workload: 'celery-worker', samples: 0, cpu: NO_SAMPLES, memory: NO_SAMPLES }],
      heatmap: { time_zone: 'UTC', cells: [] },
      pools: [],
    };
    renderPage(capacityApi(empty));
    expect(await alertWith(/^No worker figures for the last 24 hours yet\./)).toHaveTextContent(
      'They come from Cloud Monitoring worker samples or, without them, live snapshots from the Airflow REST API. Check the collectors on the DCAM health page.',
    );
    expect(screen.queryByText(/^Part of the capacity data is missing/)).toBeNull();
    expect(await screen.findByRole('contentinfo')).toHaveTextContent('No data collected yet');
  });

  it('FR-UI-07 / §12.10: stale: a chip when live snapshots lag over 2 × their cadence; nothing while fresh', async () => {
    renderPage({
      ...capacityApi(),
      getCollection: async () => live([collector('af.live', 60, 600), collector('af.facts', 60, 30)]),
    });
    const chip = await screen.findByText('Live snapshots 10 min old');
    expect(chip.closest('.MuiChip-root')).toHaveClass('MuiChip-colorError');
    expect(screen.queryByText(/^Task history .* old$/)).toBeNull();
  });

  it('FR-UI-05: every panel and KPI of every tab has an (i) explanation, and every entry is used', async () => {
    expect([...CAPACITY_TAB_PANELS, ...DAG_LOAD_PANELS].sort()).toEqual(
      Object.keys(CAPACITY_EXPLANATIONS).sort(),
    );
    expect([...FORECAST_PANELS].sort()).toEqual(Object.keys(FORECAST_EXPLANATIONS).sort());
    renderPage(capacityApi());
    for (const id of CAPACITY_TAB_PANELS)
      expect(
        await screen.findByRole('button', { name: `About ${CAPACITY_EXPLANATIONS[id].title}` }),
      ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Load by DAG' }));
    for (const id of DAG_LOAD_PANELS)
      expect(
        await screen.findByRole('button', { name: `About ${CAPACITY_EXPLANATIONS[id].title}` }),
      ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Forecast' }));
    for (const id of FORECAST_PANELS)
      expect(
        await screen.findByRole('button', { name: `About ${FORECAST_EXPLANATIONS[id].title}` }),
      ).toBeInTheDocument();
  });

  it('FR-UI-08: each tab has a provenance footer with its sources and data as of', async () => {
    renderPage(capacityApi());
    expect(await screen.findByRole('contentinfo')).toHaveTextContent(
      'Data as of Thu, 5 Nov 2026, 11:59:00 UTC · Source: demo data · 15-minute buckets; worker figures from Cloud Monitoring samples, else live snapshots; heatmaps in UTC',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Load by DAG' }));
    expect(await screen.findByRole('contentinfo')).toHaveTextContent(
      'Source: demo data · computed from task tries (FR-DAGX-06/task-tries); hours in UTC',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Forecast' }));
    expect(await screen.findByRole('contentinfo')).toHaveTextContent(
      'an estimate (HM-010/run-profiles) from up to 28 days of task history',
    );
  });
});
