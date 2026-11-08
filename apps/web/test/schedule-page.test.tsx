import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import type { Finding, Findings, Meta, Schedule } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { App } from '../src/App';
import { linkTo, parseLocation, toHref } from '../src/router';
import { SchedulePage } from '../src/pages/schedule/SchedulePage';
import { SCHEDULE_EXPLANATIONS, SCHEDULE_PANELS } from '../src/pages/schedule/explanations';

const T = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 5, h, m)).toISOString();
const fixture: Schedule = {
  env_id: 'acme-prod',
  range: { from: T(0), to: T(24) },
  data_as_of: T(23, 59),
  sources: ['DEMO'],
  time_zone: 'UTC',
  collision: {
    index: 0.42,
    busiest_minute: 0,
    total_daily_starts: 3_120,
    threshold: 0.2,
    scheduled_dags: 205,
    unscheduled_dags: 3,
  },
  planned: {
    cells: [
      { hour: 0, minute: 0, starts_per_day: 120 },
      { hour: 1, minute: 0, starts_per_day: 64 },
      { hour: 2, minute: 30, starts_per_day: 5 },
    ],
  },
  actual: {
    runs: 2_900,
    days: 1,
    cells: [
      { hour: 0, minute: 1, runs: 98 },
      { hour: 1, minute: 30, runs: 12 },
    ],
  },
  top_minutes: [
    {
      minute: 0,
      starts_per_day: 1_310,
      share: 0.42,
      dags: 120,
      schedules: [
        { schedule: '0 * * * *', dags: 61 },
        { schedule: '@daily', dags: 20 },
      ],
      top_dags: ['orders_hourly', 'billing_hourly'],
    },
    { minute: 30, starts_per_day: 120, share: 0.04, dags: 9, schedules: [], top_dags: [] },
  ],
  top_schedules: [
    {
      schedule: '0 * * * *',
      dags: 61,
      starts_per_day: 1_464,
      minutes: [0],
      example_dags: ['billing_hourly', 'orders_hourly'],
    },
  ],
};

const recSched: Finding = {
  id: 'acme-prod:REC-SCHED-01:environment:acme-prod',
  rule_id: 'REC-SCHED-01',
  title: 'Schedule collisions',
  category: 'scheduling',
  scope: { kind: 'environment', id: 'acme-prod' },
  severity: 'warning',
  status: 'open',
  impact: 3,
  confidence: 0.9,
  effort: 5,
  tier_weight: 1,
  priority_score: 0.54,
  observation: '42% of the 3,120 daily scheduled starts fall in minute 0 of the hour (120 DAGs).',
  impact_text: '6 task-hours of waiting fell in those 15 minutes of each hour.',
  action: 'Move the start minute of the heaviest colliding DAGs a few minutes later.',
  why: 'This rule fires when at least 20% of daily scheduled starts fall in one minute-of-hour.',
  evidence: [],
  remediation: [],
  risks: [],
  rollback: 'Restore the previous schedule strings.',
  verify: 'Over 7 days the collision index falls below 20%.',
  affected_dags: ['orders_hourly'],
  links: { wiki: 'schedule-collisions', docs: [] },
  detected_at: T(23),
};
const findings = (list: Finding[]): Findings => ({
  env_id: 'acme-prod',
  data_as_of: T(23, 59),
  sources: ['DEMO'],
  findings: list,
  not_evaluated: [],
});

const reject = () => Promise.reject(new Error('not in this test'));
const meta: Meta = {
  name: 'DCAM',
  version: '0.0.0-test',
  mode: 'demo',
  environments: [{ env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' }],
};
const apiFor = (data: Schedule, found: Finding[] = [recSched]): DcamApi => ({
  getMeta: async () => meta,
  getOverview: reject,
  getDagLeague: reject,
  getDagDetail: reject,
  getDagComparison: reject,
  getRunComparison: reject,
  getBottlenecks: reject,
  getSchedule: async () => data,
  getFindings: async () => findings(found),
  getAlerts: reject,
  getFleet: reject,
  getCollection: reject,
});

const wrap = (node: React.ReactNode) => (
  <ThemeProvider theme={createDcamTheme('dark')}>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {node}
    </QueryClientProvider>
  </ThemeProvider>
);
function renderPage(data: Schedule = fixture, found?: Finding[]) {
  return render(
    wrap(
      <SchedulePage
        api={apiFor(data, found)}
        envId="acme-prod"
        route={{ page: 'schedule' }}
        linkTo={(r) => linkTo(r, 'acme-prod')}
        navigate={() => {}}
      />,
    ),
  );
}
const panel = (title: string) => screen.findByRole('region', { name: title });

describe('S-17 schedule intelligence (FR-BOTL-03, HM-009)', () => {
  it('S-17: the page has its own route and a navigation entry', async () => {
    expect(parseLocation('/schedule', '?env=acme-prod')).toMatchObject({
      route: { page: 'schedule' },
      envId: 'acme-prod',
    });
    expect(toHref({ page: 'schedule' }, 'acme-prod')).toBe('/schedule?env=acme-prod');
    render(wrap(<App api={apiFor(fixture)} />));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const link = within(nav).getByRole('link', { name: /Schedule intelligence/ });
    // The environment joins the link once the workspace metadata has loaded.
    await waitFor(() => expect(link).toHaveAttribute('href', '#/schedule?env=acme-prod'));
  });

  it('HM-009: states the collision index against the REC-SCHED-01 threshold, and the busiest minute', async () => {
    renderPage();
    const kpi = (await screen.findByRole('heading', { name: 'Collision index' })).closest('.MuiPaper-root');
    expect(kpi).toHaveTextContent('42%');
    expect(kpi).toHaveTextContent(/REC-SCHED-01 fires at 20%/);
    expect(
      (await screen.findByRole('heading', { name: 'Busiest minute' })).closest('.MuiPaper-root'),
    ).toHaveTextContent(':00');
  });

  it('FR-BOTL-03: a planned and an actual start heatmap, each with an accessible description and a table view', async () => {
    renderPage();
    const p = await panel('Start heatmap');
    expect(
      within(p).getByRole('img', { name: /Planned starts per day by hour and minute \(UTC\)/ }),
    ).toBeInTheDocument();
    await userEvent.click(within(p).getByRole('button', { name: 'Actual' }));
    expect(
      within(p).getByRole('img', { name: /Runs that started by hour and minute \(UTC\)/ }),
    ).toBeInTheDocument();
    await userEvent.click(within(p).getByRole('button', { name: 'View as a table' }));
    const table = within(p).getByRole('table', { name: 'Busiest cells' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 2);
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('00:01');
  });

  it('HM-009: actual starts say where the history starts, so earlier hours read as missing, not zero', async () => {
    renderPage({
      ...fixture,
      actual: { ...fixture.actual, days: 0.25, history_from: T(18), coverage: 0.25 },
    });
    const p = await panel('Start heatmap');
    await userEvent.click(within(p).getByRole('button', { name: 'Actual' }));
    expect(within(p).getByText(/No history before 5 Nov, 18:00 UTC/)).toBeInTheDocument();
  });

  it('FR-BOTL-03: the most colliding minutes and the schedules most DAGs share', async () => {
    renderPage();
    const minutes = await panel('Most colliding minutes');
    const zero = within(minutes).getByRole('row', { name: /:00/ });
    expect(zero).toHaveTextContent('42%');
    expect(zero).toHaveTextContent('0 * * * *');
    expect(within(zero).getByRole('link', { name: 'orders_hourly' })).toHaveAttribute(
      'href',
      '#/dags/orders_hourly?env=acme-prod',
    );
    const shared = await panel('Shared schedules');
    expect(within(shared).getByRole('row', { name: /0 \* \* \* \*/ })).toHaveTextContent('61');
  });

  it('REC-SCHED-01: lists the schedule-collision findings and links to the advisor', async () => {
    renderPage();
    const p = await panel('Schedule findings');
    expect(await within(p).findByText('Schedule collisions')).toBeInTheDocument();
    expect(within(p).getByRole('link', { name: /Open the advisor/ })).toHaveAttribute(
      'href',
      '#/advisor?env=acme-prod',
    );
  });

  it('FR-UI-07: says what is missing when there is no finding, no schedule and no run', async () => {
    renderPage(
      {
        ...fixture,
        data_as_of: null,
        sources: [],
        collision: {
          ...fixture.collision,
          index: 0,
          busiest_minute: null,
          total_daily_starts: 0,
          scheduled_dags: 0,
        },
        planned: { cells: [] },
        actual: { runs: 0, days: 1, cells: [] },
        top_minutes: [],
        top_schedules: [],
      },
      [],
    );
    expect(await panel('Start heatmap')).toHaveTextContent(/No DAG has a cron schedule yet/);
    expect(await panel('Schedule findings')).toHaveTextContent(/No schedule-collision finding/);
    expect(await screen.findByRole('contentinfo')).toHaveTextContent('No data collected yet');
  });

  it('FR-UI-05 / FR-UI-08: every panel has an explanation and the page has a provenance footer in UTC', async () => {
    renderPage();
    for (const id of SCHEDULE_PANELS) {
      const x = SCHEDULE_EXPLANATIONS[id];
      expect(x).toBeDefined();
      expect(await screen.findByRole('button', { name: `About ${x.title}` })).toBeInTheDocument();
    }
    expect(await screen.findByRole('contentinfo')).toHaveTextContent(/times in UTC/);
  });
});
