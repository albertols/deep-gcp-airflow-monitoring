import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import type { Fleet, FleetCard } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { linkTo } from '../src/router';
import { FleetPage } from '../src/pages/fleet/FleetPage';
import { FLEET_EXPLANATIONS, FLEET_PANELS } from '../src/pages/fleet/explanations';

const AT = '2026-11-05T12:00:00.000Z';
const card = (over: Partial<FleetCard>): FleetCard => ({
  env_id: 'acme-prod',
  display_name: 'acme-prod',
  tier: 'prod',
  composer_image: 'composer-3-airflow-2.11.1-build.22',
  airflow_version: '2.11.1',
  health: {
    score: 95,
    label: 'healthy',
    evaluated: 9,
    total: 9,
    checks: [
      {
        id: 'worker-restarts',
        label: 'Worker restarts',
        state: 'fail',
        critical: false,
        weight: 5,
        threshold: '≤ 1 in 24 h',
        value: '3',
      },
      {
        id: 'heartbeat',
        label: 'Scheduler heartbeat complete',
        state: 'pass',
        critical: true,
        weight: 20,
        threshold: '≥ 90 % of the last 4 h',
        value: '98%',
      },
    ],
  },
  running: 42,
  queued: 7,
  workers: { current: 6, min: 2, max: 6 },
  failures_24h: 12,
  slot_seconds_24h: 3_168_000,
  waiting_task_seconds_24h: 36_000,
  top_reason: 'pool-exhausted',
  top_findings: [
    { id: 'f1', rule_id: 'REC-CAP-01', title: 'Workers at max with a long queue', severity: 'critical' },
  ],
  alerts_firing: 2,
  data_as_of: AT,
  ...over,
});
const fleet: Fleet = {
  data_as_of: AT,
  sources: ['DEMO'],
  environments: [
    card({}),
    card({
      env_id: 'acme-test',
      display_name: 'acme-test',
      tier: 'test',
      health: { score: 75, label: 'degraded', evaluated: 9, total: 9, checks: [] },
      top_findings: [],
      alerts_firing: 0,
      top_reason: 'parallelism',
    }),
  ],
};
const reject = () => Promise.reject(new Error('not in this test'));
const apiFor = (data: Fleet): DcamApi => ({
  getMeta: reject,
  getOverview: reject,
  getDagLeague: reject,
  getDagDetail: reject,
  getBottlenecks: reject,
  getSchedule: reject,
  getDagComparison: reject,
  getRunComparison: reject,
  getFindings: reject,
  getAlerts: reject,
  getFleet: async () => data,
  getCollection: reject,
});

function renderPage(data: Fleet = fleet) {
  const api = apiFor(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <FleetPage
          api={api}
          envId="acme-prod"
          route={{ page: 'fleet' }}
          linkTo={(r) => linkTo(r, 'acme-prod')}
          navigate={() => {}}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('S-02 fleet page (FR-FLEET-01/02)', () => {
  it('FR-FLEET-01: shows one card per environment with health, load, workers and the main bottleneck', async () => {
    renderPage();
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    expect(within(prod).getByText('Healthy')).toBeInTheDocument();
    expect(within(prod).getByText('95')).toBeInTheDocument();
    expect(within(prod).getByText('6 of 6 max')).toBeInTheDocument();
    expect(within(prod).getByText('Pool exhausted')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'acme-test' })).getByText('Degraded'),
    ).toBeInTheDocument();
  });

  it('FR-FLEET-02: the health score explains itself check by check', async () => {
    renderPage();
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    await userEvent.click(within(prod).getByRole('button', { name: /Show the 9 checks/ }));
    const checks = within(prod).getByRole('table', { name: 'Health checks for acme-prod' });
    expect(within(checks).getByRole('row', { name: /Worker restarts/ })).toHaveTextContent('Fail');
  });

  it('links each card to that environment’s pages, findings and alerts', async () => {
    renderPage();
    const test = await screen.findByRole('region', { name: 'acme-test' });
    expect(within(test).getByRole('link', { name: 'Bottlenecks' })).toHaveAttribute(
      'href',
      '#/bottlenecks?env=acme-test',
    );
    const prod = screen.getByRole('region', { name: 'acme-prod' });
    expect(within(prod).getByRole('link', { name: /REC-CAP-01/ })).toHaveAttribute(
      'href',
      '#/advisor?env=acme-prod',
    );
    expect(within(prod).getByRole('link', { name: '2 alerts firing' })).toHaveAttribute(
      'href',
      '#/alerts?env=acme-prod',
    );
  });

  it('FR-UI-05: every panel has an explanation', () => {
    for (const id of FLEET_PANELS) expect(FLEET_EXPLANATIONS[id]).toBeDefined();
  });

  it('HM-028: with too few checks the chip is a neutral "Partial: n of 9 checks", never "Healthy"', async () => {
    const importErrors = {
      id: 'import-errors',
      label: 'DAG import errors',
      state: 'fail',
      critical: false,
      weight: 5,
      threshold: '0 for 15 min',
      value: '1',
    } as const;
    renderPage({
      ...fleet,
      environments: [
        card({ health: { score: null, label: 'partial', evaluated: 1, total: 9, checks: [importErrors] } }),
      ],
    });
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    expect(within(prod).getByText('Partial: 1 of 9 checks')).toBeInTheDocument();
    expect(within(prod).queryByText('Healthy')).toBeNull();
    expect(within(prod).queryByText('95')).toBeNull();
  });

  it('§12.12: a self-managed Airflow says so in plain words, not "none (self-managed Airflow)"', async () => {
    renderPage({
      ...fleet,
      environments: [card({ composer_image: 'none (self-managed Airflow)', airflow_version: '2.11.1' })],
    });
    const prod = await screen.findByRole('region', { name: 'acme-prod' });
    expect(within(prod).getByText('Self-managed Airflow 2.11.1')).toBeInTheDocument();
    expect(within(prod).queryByText(/none \(/)).toBeNull();
  });
});
