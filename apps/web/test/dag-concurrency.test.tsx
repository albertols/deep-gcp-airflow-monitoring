import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { DagConcurrency, DagDetail } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { ConcurrencyPanel } from '../src/pages/dags/ConcurrencyPanel';
import { ImpactPanel } from '../src/pages/dags/ImpactPanel';
import { linkTo, type PageParams, type Route } from '../src/router';
import {
  BELOW_MINIMUM,
  CONCURRENCY,
  IMPACT,
  NOT_EVALUATED,
  NOT_THROTTLED,
  WITH_008,
  olderServer,
} from './dag-compare-fixtures';

const UI_TIMEOUT_MS = 30_000;
const reject = () => Promise.reject(new Error('not in this test'));
const api = { getCollection: reject } as unknown as DcamApi;
const link = (r: Route, p?: PageParams) => linkTo(r, 'acme-prod', undefined, p);

function wrap(node: ReactNode, mode: 'dark' | 'light' = 'dark') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider theme={createDcamTheme(mode)}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </ThemeProvider>,
  );
}
const concurrency = (detail: DagDetail, mode: 'dark' | 'light' = 'dark') =>
  wrap(<ConcurrencyPanel detail={detail} api={api} envId="acme-prod" linkTo={link} />, mode);
const impact = (detail: DagDetail) =>
  wrap(<ImpactPanel detail={detail} api={api} envId="acme-prod" linkTo={link} />);

describe('S-12 concurrency profile (FR-DAGD-05)', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-DAGD-05: running, in flight and ready per bucket against max_active_tasks, with a table view', async () => {
    concurrency(WITH_008);
    const panel = screen.getByRole('region', { name: 'Concurrency profile' });
    expect(
      within(panel).getByRole('img', { name: /peak 4 running at once against max_active_tasks 4/ }),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/max_active_tasks 4, set by the DAG/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'View as table' }));
    const table = within(panel).getByRole('table', { name: 'Concurrency per bucket' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const cells = (r: HTMLElement) =>
      within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    expect(cells(rows[0] as HTMLElement).slice(1, 6)).toEqual(['3.5', '4', '4', '8', '11m']);
    // A bucket without a live snapshot is a gap, never zero (NFR-DATA-03).
    expect(cells(rows[1] as HTMLElement).slice(3, 6)).toEqual(['—', '—', '—']);
    expect(within(rows[1] as HTMLElement).getAllByTitle('No live snapshot in this bucket')).toHaveLength(3);
  });

  it('FR-DAGD-05: says when max_active_tasks is the default rather than the DAG’s own', () => {
    concurrency({ ...WITH_008, concurrency: NOT_THROTTLED });
    const panel = screen.getByRole('region', { name: 'Concurrency profile' });
    expect(
      within(panel).getByText(/max_active_tasks 16, the default: the DAG does not set its own/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/\[core\] max_active_tasks_per_dag/)).toBeInTheDocument();
  });

  it('FR-DAGD-05 / REC-DAG-01: at the limit for more than 10 % of its active time flags REC-DAG-01 and links the finding', () => {
    concurrency(WITH_008);
    const panel = screen.getByRole('region', { name: 'Concurrency profile' });
    const flag = within(panel).getByTestId('self-throttling');
    expect(flag).toHaveTextContent(/At its max_active_tasks limit for 43% of its active time/);
    expect(flag).toHaveTextContent(/above the 10% threshold of REC-DAG-01/);
    expect(flag).toHaveTextContent(/free worker slots in 80% of those moments/);
    expect(within(flag).getByRole('link', { name: 'Open the REC-DAG-01 finding' })).toHaveAttribute(
      'href',
      '#/advisor?env=acme-prod&finding=acme-prod%3AREC-DAG-01%3Adag%3Aorders_daily',
    );
  });

  it('REC-DAG-01: below the threshold there is no flag; raised without an open finding it says why', () => {
    concurrency({ ...WITH_008, concurrency: NOT_THROTTLED });
    const below = screen.getByTestId('self-throttling');
    expect(below).toHaveTextContent(/2% of its active time: below the 10% threshold of REC-DAG-01/);
    expect(within(below).queryByRole('link')).toBeNull();
    cleanup();

    const raised = { ...CONCURRENCY.self_throttling, finding_id: null };
    concurrency({ ...WITH_008, concurrency: { ...CONCURRENCY, self_throttling: raised } });
    const flag = screen.getByTestId('self-throttling');
    expect(flag).toHaveTextContent(/The advisor has no open REC-DAG-01 finding for this DAG/);
    expect(within(flag).queryByRole('link')).toBeNull();
  });

  it('FR-DAGD-05: pool lines: the slots this DAG held against every DAG and the pool size', async () => {
    concurrency(WITH_008);
    const panel = screen.getByRole('region', { name: 'Concurrency profile' });
    expect(
      within(panel).getByRole('img', { name: /Pool etl: this DAG held up to 8 of 24 slots/ }),
    ).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'View as table' }));
    const table = within(panel).getByRole('table', { name: 'Concurrency per bucket' });
    expect(
      within(table).getByRole('columnheader', { name: 'Pool etl: this DAG / all DAGs' }),
    ).toBeInTheDocument();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).getByText('8 / 24')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('6 / —')).toBeInTheDocument();
  });

  it('FR-UI-07: an older server and a range without snapshots say so instead of drawing zeros', () => {
    concurrency(olderServer(WITH_008, 'concurrency'));
    expect(screen.getByText(/does not report the concurrency profile yet/)).toBeInTheDocument();
    cleanup();

    const empty = {
      ...CONCURRENCY,
      snapshots: 0,
      snapshot_interval_seconds: null,
      peak_running: null,
      peak_in_flight: null,
      series: CONCURRENCY.series.map((s) => ({
        ...s,
        running_avg: null,
        running_max: null,
        in_flight_max: null,
        ready_max: null,
        at_limit_seconds: null,
      })),
      pools: [],
      self_throttling: { ...CONCURRENCY.self_throttling, at_limit_share: null, raises_rec_dag_01: false },
    };
    concurrency({ ...WITH_008, concurrency: empty });
    const panel = screen.getByRole('region', { name: 'Concurrency profile' });
    expect(within(panel).getByText(/No task of this DAG ran in this range/)).toBeInTheDocument();
    expect(within(panel).queryByRole('img')).toBeNull();
  });

  it('FR-DAGD-05 / NFR-DATA-03: with task history but no live snapshot, time at the limit is not known, never 0s', () => {
    const noSnapshots: DagConcurrency = {
      ...CONCURRENCY,
      snapshots: 0,
      snapshot_interval_seconds: null,
      peak_in_flight: null,
      series: CONCURRENCY.series.map((s) => ({
        ...s,
        in_flight_max: null,
        ready_max: null,
        at_limit_seconds: null,
      })),
      self_throttling: {
        ...CONCURRENCY.self_throttling,
        at_limit_share: null,
        raises_rec_dag_01: false,
        finding_id: null,
      },
    };
    concurrency({ ...WITH_008, concurrency: noSnapshots });
    const panel = screen.getByRole('region', { name: 'Concurrency profile' });
    const notKnown = 'Time at the limit is not known: no live snapshot in this range.';
    const chart = within(panel).getByRole('img', { name: /peak 4 running at once/ });
    expect(chart.getAttribute('aria-label')).toContain(notKnown);
    expect(chart.getAttribute('aria-label')).not.toMatch(/at the limit for 0s/);
    expect(within(panel).getByText(notKnown)).toBeInTheDocument();
    expect(within(panel).queryByRole('img', { name: /in total/ })).toBeNull();
    expect(panel).not.toHaveTextContent(/\b0s\b/);
  });

  it('FR-UI-08: the panel has a provenance footer with the method', () => {
    concurrency(WITH_008, 'light');
    const panel = screen.getByRole('region', { name: 'Concurrency profile' });
    expect(within(panel).getByText(/Source: demo data/)).toHaveTextContent(/HM-005\/snapshots/);
  });
});

describe('S-12 impact on the environment (FR-DAGD-06)', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-DAGD-06: the DAG’s share of the environment’s load over time, with a table view', async () => {
    impact(WITH_008);
    const panel = screen.getByRole('region', { name: 'Impact on the environment' });
    expect(within(panel).getByRole('img', { name: /peak 10% at/ })).toBeInTheDocument();
    // 3,600 of 49,500 slot-seconds over the buckets with history.
    expect(within(panel).getByText(/7.3% of the environment’s executor slot-hours/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'View as table' }));
    const table = within(panel).getByRole('table', { name: 'Share of the environment per bucket' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('10%')).toBeInTheDocument();
    // Before the history start: a gap, not 0 %.
    expect(within(rows[1] as HTMLElement).queryByText('0%')).toBeNull();
    expect(within(rows[1] as HTMLElement).getAllByTitle('No history for this bucket').length).toBeGreaterThan(
      0,
    );
  });

  it('FR-DAGD-06: shows the noisy-neighbour score with its 95 % interval and confidence', () => {
    impact(WITH_008);
    const score = screen.getByTestId('noisy-neighbour');
    expect(score).toHaveTextContent('+45s');
    expect(score).toHaveTextContent('95 % interval +25s to +1m 10s');
    expect(within(score).getByText('High confidence')).toBeInTheDocument();
    expect(score).toHaveTextContent(/associated with/i);
    expect(score).toHaveTextContent(/5 Nov, 10:00–10:24 UTC/);
  });

  it('FR-DAGD-06 / HM-017: a score not evaluated gives its reason and the minimums, never a zero', () => {
    impact({ ...WITH_008, impact: { ...IMPACT, noisy_neighbour: NOT_EVALUATED } });
    const block = screen.getByTestId('noisy-neighbour');
    expect(block).toHaveTextContent(/Not scored/);
    expect(block).toHaveTextContent(/does not know the executor slots in this range/);
    const minimums = within(block).getByRole('table', { name: 'What the score needs' });
    const active = within(minimums).getByText('Active minutes (≥ 10% of the executor slots)').closest('tr');
    expect(active).toHaveTextContent('60');
    expect(active).toHaveTextContent('Not measured');
    expect(block).not.toHaveTextContent(/\+0s|confidence/i);
  });

  it('HM-017: below a minimum, the counts are shown against what is needed', () => {
    impact({ ...WITH_008, impact: { ...IMPACT, noisy_neighbour: BELOW_MINIMUM, slots_source: 'hostnames' } });
    const minimums = screen.getByRole('table', { name: 'What the score needs' });
    const active = within(minimums).getByText('Active minutes (≥ 10% of the executor slots)').closest('tr');
    expect(active).toHaveTextContent('42');
    expect(active).toHaveTextContent('Not met');
    const tries = within(minimums).getByText("Other DAGs' tries queued while it was active").closest('tr');
    expect(tries).toHaveTextContent('Met');
    // Worker counts from hostnames: the share of slots is an estimate.
    expect(screen.getByRole('region', { name: 'Impact on the environment' })).toHaveTextContent(/Estimate/);
  });

  it('FR-UI-07 / FR-UI-08: an older server says so; the panel shows its provenance', () => {
    impact(WITH_008);
    expect(
      within(screen.getByRole('region', { name: 'Impact on the environment' })).getByText(
        /Source: demo data/,
      ),
    ).toHaveTextContent(/HM-017\/range/);
    cleanup();
    impact(olderServer(WITH_008, 'impact'));
    expect(screen.getByText(/does not report the impact on the environment yet/)).toBeInTheDocument();
  });
});
