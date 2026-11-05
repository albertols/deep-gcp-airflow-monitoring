import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import type { AlertEvent, AlertRule, Alerts, Meta } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { linkTo } from '../src/router';
import { AlertsPage } from '../src/pages/alerts/AlertsPage';
import { ALERT_EXPLANATIONS, ALERT_PANELS } from '../src/pages/alerts/explanations';

const T = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 5, h, m)).toISOString();
const meta: Meta = {
  name: 'DCAM',
  version: '0.0.0',
  mode: 'demo',
  environments: [
    { env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' },
    { env_id: 'acme-test', display_name: 'acme-test', tier: 'test' },
  ],
};
const base = {
  env_id: 'acme-prod',
  severity: 'warning',
  state: 'inactive',
  for_seconds: 0,
  threshold: null,
  value: null,
  unit: '',
  since: null,
  runbook: null,
  export_cloud_monitoring: 'no',
  fired_count_24h: 0,
} as const;
const rules: AlertRule[] = [
  {
    ...base,
    id: 'AL-01',
    name: 'Environment unhealthy',
    severity: 'critical',
    condition: 'Environment healthy < 90 % of the time over 4 h',
    threshold: 90,
    value: 99,
    unit: '%',
    summary: 'Healthy 99 % of the last 4 h.',
    runbook: 'RB-03',
    export_cloud_monitoring: 'yes',
  },
  {
    ...base,
    id: 'AL-05',
    name: 'Tasks queued while workers are at maximum',
    state: 'pending',
    condition: 'Workers at maximum and ≥ 10 tasks queued for 15 min',
    for_seconds: 900,
    threshold: 10,
    value: 14,
    unit: 'queued tasks',
    since: T(11, 52),
    summary: '14 tasks queued with 6 of 6 workers (maximum 6).',
    runbook: 'RB-01',
    export_cloud_monitoring: 'partial',
  },
  {
    ...base,
    id: 'AL-13',
    name: 'Triggerer saturated',
    state: 'unknown',
    condition: 'Triggerer ≥ 90 % of capacity for 15 min',
    for_seconds: 900,
    threshold: 90,
    unit: '%',
    summary: 'Triggerer capacity is not collected in this version.',
    runbook: 'RB-08',
    export_cloud_monitoring: 'partial',
  },
  {
    ...base,
    id: 'AL-15',
    name: 'Pool starvation',
    state: 'firing',
    condition: 'A pool has no open slots while tasks wait for it, for 30 min',
    threshold: 30,
    value: 34.5,
    unit: 'min',
    since: T(11, 40),
    summary: 'Pool external_api has had no open slots while tasks waited for it for 35 min.',
    runbook: 'RB-01',
    fired_count_24h: 2,
  },
  {
    ...base,
    id: 'AL-19',
    name: 'Worker restarts',
    state: 'firing',
    condition: '> 1 worker container restart in 24 h, excluding scale-down',
    threshold: 1,
    value: 3,
    unit: 'restarts',
    since: T(12),
    summary: '3 worker container restarts in the last 24 h.',
    runbook: 'RB-04',
    export_cloud_monitoring: 'yes',
    fired_count_24h: 1,
  },
  {
    ...base,
    id: 'AL-04',
    name: 'Import errors',
    env_id: 'acme-test',
    severity: 'info',
    state: 'firing',
    condition: 'Import errors > 0 for 15 min',
    threshold: 0,
    value: 2,
    unit: 'import errors',
    since: T(12),
    summary: '2 DAG import errors over the last 15 min.',
    runbook: 'RB-02',
    export_cloud_monitoring: 'yes',
    fired_count_24h: 1,
  },
];
const event = (
  id: string,
  rule_id: string,
  kind: AlertEvent['kind'],
  at: string,
  env_id = 'acme-prod',
): AlertEvent => ({
  id,
  rule_id,
  env_id,
  severity: env_id === 'acme-prod' ? 'warning' : 'info',
  kind,
  at,
  value: 1,
});
const events: AlertEvent[] = [
  event('e5', 'AL-04', 'fired', T(12), 'acme-test'),
  event('e4', 'AL-19', 'fired', T(12)),
  event('e3', 'AL-15', 'fired', T(11, 40)),
  event('e2', 'AL-15', 'resolved', T(9, 30)),
  event('e1', 'AL-15', 'fired', T(8, 0)),
];
const alertsFor = (envId?: string): Alerts => ({
  data_as_of: T(11, 59),
  sources: ['DEMO'],
  rules: rules.filter((r) => !envId || r.env_id === envId),
  events: events.filter((e) => !envId || e.env_id === envId),
});

const reject = () => Promise.reject(new Error('not in this test'));
function renderPage() {
  const getAlerts = vi.fn(async (envId?: string) => alertsFor(envId));
  const api: DcamApi = {
    getMeta: async () => meta,
    getOverview: reject,
    getDagLeague: reject,
    getDagDetail: reject,
    getBottlenecks: reject,
    getFindings: reject,
    getAlerts,
    getFleet: reject,
    getCollection: reject,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <AlertsPage
          api={api}
          envId="acme-prod"
          route={{ page: 'alerts' }}
          linkTo={(r) => linkTo(r, 'acme-prod')}
          navigate={() => {}}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { getAlerts };
}
const rulesTable = () => screen.findByRole('table', { name: 'Alert rules' });
const ruleIds = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getByText(/^AL-\d\d$/).textContent);

describe('S-24 alerts page (FR-ALRT-01/02/06)', () => {
  it('FR-ALRT-01: lists firing and pending rules first, then the rest', async () => {
    renderPage();
    expect(ruleIds(await rulesTable())).toEqual(['AL-15', 'AL-19', 'AL-05', 'AL-01', 'AL-13']);
  });

  it('FR-ALRT-01: shows each state with an icon and a label, never colour alone', async () => {
    renderPage();
    const table = await rulesTable();
    const firing = within(table).getByRole('row', { name: /AL-15/ });
    expect(within(firing).getByText('Firing')).toBeInTheDocument();
    expect(within(firing).getByTestId('state-icon-firing')).toBeInTheDocument();
    const unknown = within(table).getByRole('row', { name: /AL-13/ });
    expect(within(unknown).getByText('Unknown')).toBeInTheDocument();
    expect(
      within(unknown).getByText('Triggerer capacity is not collected in this version.'),
    ).toBeInTheDocument();
  });

  it('FR-ALRT-01: shows condition, current value with its unit, since, fires in 24 h, runbook and export', async () => {
    renderPage();
    const row = within(await rulesTable()).getByRole('row', { name: /AL-15/ });
    expect(row).toHaveTextContent('A pool has no open slots while tasks wait for it, for 30 min');
    expect(row).toHaveTextContent('34.5 min');
    expect(row).toHaveTextContent('Warning');
    expect(row).toHaveTextContent('acme-prod');
    expect(row).toHaveTextContent('11:40 UTC');
    expect(within(row).getByRole('cell', { name: '2' })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'RB-01' })).toHaveAttribute(
      'href',
      '#/wiki/rb-01-tasks-stuck?env=acme-prod',
    );
    expect(row).toHaveTextContent('Not exportable');
    const pending = within(await rulesTable()).getByRole('row', { name: /AL-05/ });
    expect(pending).toHaveTextContent('14 queued tasks');
    expect(pending).toHaveTextContent('for 15 min');
    expect(pending).toHaveTextContent('Partial');
  });

  it('FR-WIKI-06: a runbook without a wiki page yet is named, not linked', async () => {
    renderPage();
    const row = within(await rulesTable()).getByRole('row', { name: /AL-13/ });
    expect(row).toHaveTextContent('RB-08');
    expect(within(row).queryByRole('link', { name: /RB-08/ })).toBeNull();
  });

  it('defaults to the selected environment and offers all environments', async () => {
    const { getAlerts } = renderPage();
    await rulesTable();
    expect(getAlerts).toHaveBeenLastCalledWith('acme-prod');
    expect(screen.queryByText('AL-04')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Show alerts for'), 'All environments');
    await waitFor(() => expect(getAlerts).toHaveBeenLastCalledWith(undefined));
    expect(await within(await rulesTable()).findByRole('row', { name: /AL-04/ })).toHaveTextContent(
      'acme-test',
    );
  });

  it('filters rules by state', async () => {
    renderPage();
    await rulesTable();
    await userEvent.click(screen.getByRole('button', { name: /Unknown/ }));
    expect(ruleIds(await rulesTable())).toEqual(['AL-13']);
  });

  it('FR-ALRT-06: lists the 24 h history newest first, filterable by event', async () => {
    renderPage();
    const history = await screen.findByRole('table', { name: 'Alert history' });
    const rows = within(history).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByText(/^AL-\d\d$/).textContent)).toEqual([
      'AL-19',
      'AL-15',
      'AL-15',
      'AL-15',
    ]);
    expect(rows[0]).toHaveTextContent('Fired');
    await userEvent.click(screen.getByRole('button', { name: 'Resolved events' }));
    const resolved = within(screen.getByRole('table', { name: 'Alert history' }))
      .getAllByRole('row')
      .slice(1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toHaveTextContent('09:30 UTC');
  });

  it('§12.8: the firing timeline has an accessible description', async () => {
    renderPage();
    expect(await screen.findByRole('img', { name: /Firing periods over the last 24 h/ })).toBeInTheDocument();
  });

  it('§12.8: the timeline axis names its time zone and keeps the last time label inside the chart', async () => {
    renderPage();
    const chart = await screen.findByRole('img', { name: /Firing periods over the last 24 h/ });
    const labels = [...chart.querySelectorAll('text')].filter((t) => /\d\d:\d\d/.test(t.textContent ?? ''));
    expect(labels[0]).toHaveTextContent(/UTC$/);
    expect(labels.at(-1)).toHaveAttribute('text-anchor', 'end');
  });

  it('§12.12: a value of one takes the singular unit', async () => {
    renderPage();
    const row = within(await rulesTable()).getByRole('row', { name: /AL-19/ });
    expect(row).toHaveTextContent('3 restarts');
    expect(row).toHaveTextContent('threshold 1 restart');
    expect(row).not.toHaveTextContent('threshold 1 restarts');
  });

  it('§16.7: shows fires in 24 h and the mean time to resolve', async () => {
    renderPage();
    await rulesTable();
    const kpi = (title: string) => screen.getByRole('heading', { name: title }).closest('.MuiPaper-root');
    expect(kpi('Mean time to resolve')).toHaveTextContent('1h 30m');
    expect(kpi('Fired in 24 h')).toHaveTextContent('3');
    expect(kpi('Firing now')).toHaveTextContent('2');
  });

  it('FR-ALRT-07: says alerts are local, not paging, and that Cloud Monitoring export comes later as copy-only', async () => {
    renderPage();
    const note = await screen.findByText(/only while DCAM runs/);
    expect(note).toHaveTextContent(/does not page anyone/);
    expect(note).toHaveTextContent(/copy-only/);
  });

  it('FR-UI-05 / FR-UI-08: every panel has an explanation and the page has a provenance footer', async () => {
    for (const id of ALERT_PANELS) expect(ALERT_EXPLANATIONS[id]).toBeDefined();
    renderPage();
    await rulesTable();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/Data as of .* Source: demo data/);
  });
});
