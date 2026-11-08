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
import { capacityApi, capacityFixture, unknownConcurrency } from './capacity-fixtures';

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

describe('S-04 capacity tab: limits, workers, workloads and pools (FR-ENV-02, HM-012, HM-032)', () => {
  /** The cells of the limits table row whose first cell is `name`. */
  const limitRow = async (name: string) => {
    const table = within(await panel('Limits and their sources')).getByRole('table', { name: 'Limits' });
    const row = within(table).getByText(name).closest('tr');
    if (!(row instanceof HTMLElement)) throw new Error(`No limit row ${name}`);
    return row;
  };

  it('HM-032: each limit shows its value and where DCAM read it', async () => {
    renderPage();
    expect(await limitRow('worker_concurrency')).toHaveTextContent(/12.*Configured/);
    expect(await limitRow('parallelism')).toHaveTextContent(
      /96 per scheduler.*Airflow configuration override/,
    );
    expect(await limitRow('Worker slots at max_count')).toHaveTextContent('72');
  });

  it('HM-032 / NFR-DATA-03: unknown limits read as unknown, never as zero', async () => {
    renderPage(capacityApi(unknownConcurrency));
    const concurrency = await limitRow('worker_concurrency');
    expect(concurrency).toHaveTextContent(/Unknown.*Unknown: DCAM could not read it/);
    expect(concurrency).not.toHaveTextContent(/\b0\b/);
    expect(await limitRow('Worker slots at max_count')).toHaveTextContent('Unknown');
    expect(await limitRow('parallelism × schedulers')).toHaveTextContent('Unknown');
    expect(await kpi('Capacity-bound minutes')).toHaveTextContent('Not known yet');
    expect(await kpi('Worker slot utilisation (p95)')).toHaveTextContent('Not known yet');
    expect(
      await alertWith(
        /^Capacity-bound periods are not evaluated for the last 24 hours: worker_concurrency is not known/,
      ),
    ).toBeInTheDocument();
    expect(await panel('Capacity-bound periods')).toHaveTextContent(
      /^Capacity-bound periods.*Not evaluated: /,
    );
  });

  it('HM-012: workers against min_count and max_count, with the scale events and the scale-up lag', async () => {
    renderPage();
    const p = await panel('Workers and scale events');
    expect(
      within(p).getByRole('img', {
        name: /Workers per 15-minute bucket against min_count 2 and max_count 6/,
      }),
    ).toBeInTheDocument();
    expect(p).toHaveTextContent('2 scale-ups and 2 scale-downs');
    expect(p).toHaveTextContent('Scale-up lag ≤ 3m (low sample: 4 episodes)');
    expect(p).toHaveTextContent('Worker counts from Cloud Monitoring samples.');
    const events = within(p).getByRole('table', { name: 'Scale events' });
    expect(within(events).getAllByRole('row')).toHaveLength(1 + 4);
    expect(within(events).getAllByRole('row')[1]).toHaveTextContent(/5 Nov, 03:05.*6 → 3.*Down/);
  });

  it('HM-012: without Cloud Monitoring samples scale events say why they are not evaluated', async () => {
    renderPage(
      capacityApi({
        ...capacityFixture,
        slots_source: 'hostnames',
        scale_events: {
          evaluated: false,
          not_evaluated_reason: 'Scale events need Cloud Monitoring worker counts.',
          up: 0,
          down: 0,
          items: [],
        },
      }),
    );
    const p = await panel('Workers and scale events');
    expect(p).toHaveTextContent('Not evaluated: Scale events need Cloud Monitoring worker counts.');
    expect(p).toHaveTextContent(/estimated from task instance hostnames: a lower bound/);
    expect(within(p).queryByRole('table', { name: 'Scale events' })).toBeNull();
  });

  it('FR-ENV-02: worker CPU and memory against their limits, and the workload types not collected', async () => {
    renderPage();
    const p = await panel('Worker CPU and memory');
    const row = within(p).getByText('Celery workers').closest('tr');
    expect(row).toHaveTextContent(/41%.*72%.*90%.*62%.*78%.*81%/);
    expect(p).toHaveTextContent('Not collected yet: scheduler, triggerer, DAG processor and web server.');
  });

  it('FR-ENV-08: pool slots against running and queued slots; a pool without snapshots has no data, not zero', async () => {
    renderPage();
    const p = await panel('Pool slots');
    const etl = within(p).getByText('acme_etl').closest('tr');
    expect(etl).toHaveTextContent(/24.*10.*24.*6.*35/);
    const api = within(p).getByText('acme_partner_api').closest('tr');
    expect(api).toHaveTextContent(/4.*No data.*No data.*No data.*No data/);
  });
});

describe('S-04 saturation heatmap (FR-ENV-02, FR-UI-06, FR-UI-02)', () => {
  const grid = async (name: RegExp) => within(await panel('Saturation heatmap')).getByRole('group', { name });

  it('FR-ENV-02: one cell per UTC day and hour, named with its figures, capacity-bound hours marked', async () => {
    renderPage();
    const g = await grid(
      /^Worker slot utilisation by UTC day and hour\. Busiest: 5 Nov, 02:00 UTC at 100%\./,
    );
    expect(within(g).getAllByRole('button')).toHaveLength(24);
    const nightly = within(g).getByRole('button', { name: /^5 Nov, 02:00 UTC: utilisation 100%/ });
    expect(nightly).toHaveAccessibleName(
      '5 Nov, 02:00 UTC: utilisation 100%, 60 min at max workers, 52 capacity-bound min',
    );
    expect(nightly).toHaveAttribute('data-bound', 'true');
    expect(within(g).getByRole('button', { name: /^5 Nov, 05:00 UTC/ })).not.toHaveAttribute('data-bound');
  });

  it('FR-UI-06: the cells re-theme: the busiest hour is bright in the dark theme and dark in the light theme', async () => {
    const { unmount } = renderPage(capacityApi(), { mode: 'dark' });
    const busiest = (await grid(/Worker slot utilisation/)).querySelector('[aria-label^="5 Nov, 02:00 UTC"]');
    expect(busiest).toHaveStyle({ backgroundColor: 'rgb(253, 231, 37)' });
    unmount();
    renderPage(capacityApi(), { mode: 'light' });
    const light = (await grid(/Worker slot utilisation/)).querySelector('[aria-label^="5 Nov, 02:00 UTC"]');
    expect(light).toHaveStyle({ backgroundColor: 'rgb(68, 1, 84)' });
  });

  it('FR-ENV-02: colours by utilisation, minutes at max workers or capacity-bound minutes', async () => {
    renderPage();
    const p = await panel('Saturation heatmap');
    await userEvent.click(within(p).getByRole('button', { name: 'Capacity-bound minutes' }));
    expect(
      await grid(/^Capacity-bound minutes by UTC day and hour\. Busiest: 5 Nov, 02:00 UTC at 52 min\./),
    ).toBeInTheDocument();
  });

  it('NFR-DATA-03: hours without worker figures are empty and say so, not the lowest colour', async () => {
    const gap: Capacity = {
      ...capacityFixture,
      heatmap: {
        time_zone: 'UTC',
        cells: capacityFixture.heatmap.cells.map((c, i) =>
          i === 0
            ? {
                ...c,
                observed_minutes: 0,
                utilisation_mean: null,
                minutes_at_max: null,
                capacity_bound_minutes: null,
              }
            : c,
        ),
      },
    };
    renderPage(capacityApi(gap));
    const empty = within(await grid(/Worker slot utilisation/)).getByRole('button', {
      name: '4 Nov, 12:00 UTC: no data, not observed',
    });
    expect(empty).toHaveAttribute('data-empty', 'true');
    expect(empty.style.backgroundColor).toBe('transparent');
  });

  it('HM-032: without worker_concurrency utilisation is unknown, and the panel offers minutes at max workers', async () => {
    renderPage(capacityApi(unknownConcurrency));
    const p = await panel('Saturation heatmap');
    expect(p).toHaveTextContent(
      'Utilisation needs worker_concurrency, which is not known. Colour by minutes at max workers instead.',
    );
    expect(
      within(await grid(/Worker slot utilisation/)).getByRole('button', {
        name: /^5 Nov, 02:00 UTC: utilisation unknown/,
      }),
    ).toBeInTheDocument();
  });

  it('NFR-A11Y-01: the heatmap has a table view with every observed hour', async () => {
    renderPage();
    const p = await panel('Saturation heatmap');
    await userEvent.click(within(p).getByRole('button', { name: 'View as a table' }));
    const table = within(p).getByRole('table', { name: 'Saturation by UTC day and hour' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 24);
    expect(within(table).getByText('5 Nov, 02:00').closest('tr')).toHaveTextContent(/100%.*60.*52/);
  });

  it('FR-UI-02: the selected cell is in the URL, shows its figures, and a shared link restores it', async () => {
    window.location.hash = '#/capacity?env=acme-prod&cell=2026-11-05T02';
    renderApp();
    const p = await panel('Saturation heatmap');
    expect(within(p).getByRole('button', { name: /^5 Nov, 02:00 UTC/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(p).toHaveTextContent(
      'Selected: 5 Nov, 02:00–03:00 UTC. 60 of 60 minutes observed; utilisation 100%; 60 min at max workers; 52 capacity-bound min.',
    );
    await userEvent.click(within(p).getByRole('button', { name: /^4 Nov, 19:00 UTC/ }));
    await waitFor(() => expect(window.location.hash).toContain('cell=2026-11-04T19'));
  });
});

describe('S-04 load by DAG and hour of day (FR-DAGX-06)', () => {
  async function openDagLoad(api: DcamApi = capacityApi()) {
    renderPage(api);
    await userEvent.click(await screen.findByRole('tab', { name: 'Load by DAG' }));
    return panel('Load by DAG and hour of day');
  }

  it('FR-DAGX-06: a DAG × hour-of-day heatmap of the top DAGs, the busiest named in its description', async () => {
    const p = await openDagLoad();
    const g = within(p).getByRole('group', {
      name: /^Mean worker slots by DAG and UTC hour of day: the top 3 of 120 DAGs\. Busiest: acme_orders_nightly at 02:00 UTC with 48 slots\./,
    });
    expect(within(g).getAllByRole('button')).toHaveLength(3 * 24);
    expect(
      within(g).getByRole('button', { name: 'acme_orders_nightly, 02:00 UTC: 48 slots on average' }),
    ).toBeInTheDocument();
    expect(p).toHaveTextContent('Each cell averages 1 hour of task history in this range.');
  });

  it('NFR-DATA-03: hours of the day without task history are empty, not zero', async () => {
    const c = capacityFixture;
    const p = await openDagLoad(
      capacityApi({
        ...c,
        dag_load: {
          ...c.dag_load,
          covered_hours: c.dag_load.covered_hours.map((h, i) => (i === 5 ? 0 : h)),
          dags: c.dag_load.dags.map((d) => ({ ...d, hours: d.hours.map((v, i) => (i === 5 ? null : v)) })),
        },
      }),
    );
    const empty = within(p).getByRole('button', { name: 'acme_payments_hourly, 05:00 UTC: no task history' });
    expect(empty).toHaveAttribute('data-empty', 'true');
    expect(p).toHaveTextContent(
      '1 hour of the day has no task history in this range: its cells are empty, not zero.',
    );
  });

  it('FR-UI-02 / FR-DAGX-06: a selected cell shows the DAG’s figures and links to the DAG', async () => {
    const p = await openDagLoad();
    await userEvent.click(within(p).getByRole('button', { name: /^acme_orders_nightly, 02:00 UTC/ }));
    expect(within(p).getByRole('button', { name: /^acme_orders_nightly, 02:00 UTC/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(p).toHaveTextContent(
      'Selected: acme_orders_nightly, 02:00–03:00 UTC. 48 slots on average; the DAG holds 30% of the executor slot time in this range.',
    );
    expect(within(p).getByRole('link', { name: 'Open acme_orders_nightly' })).toHaveAttribute(
      'href',
      '#/dags/acme_orders_nightly?env=acme-prod',
    );
  });

  it('NFR-A11Y-01: the heatmap has a table view with one row per DAG and a column per hour', async () => {
    const p = await openDagLoad();
    await userEvent.click(within(p).getByRole('button', { name: 'View as a table' }));
    const table = within(p).getByRole('table', { name: 'Load by DAG and UTC hour' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 3);
    expect(within(table).getByText('acme_orders_nightly').closest('tr')).toHaveTextContent(/30%.*150\.0.*48/);
  });

  it('FR-UI-07: says why the heatmap is empty and what to do', async () => {
    const p = await openDagLoad(
      capacityApi({ ...capacityFixture, dag_load: { ...capacityFixture.dag_load, dag_count: 0, dags: [] } }),
    );
    expect(p).toHaveTextContent(
      'No DAG held a worker slot in this range. Widen the range, or check the task instance collector on DCAM health.',
    );
  });
});
