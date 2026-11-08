import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Finding, Findings } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { PageParamsContext } from '../src/components/view';
import { linkTo, type PageParams } from '../src/router';
import { AdvisorPage } from '../src/pages/advisor/AdvisorPage';
import { ADVISOR_EXPLANATIONS, ADVISOR_PANELS } from '../src/pages/advisor/explanations';

const AT = new Date(Date.UTC(2026, 10, 5, 11, 59, 30)).toISOString();
const GCLOUD = [
  '# Raise the worker maximum of acme-prod from 6 to 9 (REC-CAP-01).',
  'gcloud composer environments update acme-prod \\',
  '  --location LOCATION \\',
  '  --max-workers 9',
].join('\n');

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'acme-prod:REC-CAP-01:environment:acme-prod',
  rule_id: 'REC-CAP-01',
  title: 'Workers at maximum while tasks are queued',
  category: 'capacity',
  scope: { kind: 'environment', id: 'acme-prod' },
  severity: 'critical',
  status: 'open',
  impact: 3,
  confidence: 0.92,
  effort: 2,
  tier_weight: 1,
  priority_score: 1.38,
  observation:
    'Workers stayed at the maximum of 6 for 130 min in the last 24 h while up to 72 tasks were queued.',
  impact_text:
    'Tasks queued in those minutes waited up to 14m for a worker slot; 20 task-hours were spent queued.',
  action:
    'Stagger colliding schedules first. If the peaks are not schedule-driven, raise max_count from 6 to 9.',
  why: 'This rule fires when workers equal max_count (6) and at least 15 task instances are queued. Data used: worker samples.',
  evidence: [
    { label: 'Capacity-bound minutes in 24 h', value: '130 min', threshold: '≥ 15 min', source: 'DEMO' },
    { label: 'Worker settings', value: 'min_count 2, max_count 6', threshold: null, source: 'DEMO' },
  ],
  remediation: [
    { kind: 'gcloud', title: 'gcloud', language: 'bash', code: GCLOUD },
    { kind: 'terraform', title: 'Terraform', language: 'hcl', code: 'max_count = 9' },
  ],
  risks: ['Higher maximum increases peak cost.'],
  rollback: 'Restore max_count to 6 with the same command.',
  verify: 'Compare 7 days before and after the change.',
  affected_dags: ['orders_daily', 'billing_hourly'],
  links: {
    wiki: 'worker-scaling',
    docs: [
      {
        title: 'Managed Airflow (Gen 3): scale environments',
        url: 'https://docs.cloud.google.com/composer/docs/composer-3/scale-environments',
      },
    ],
  },
  detected_at: AT,
  ...over,
});

const many: Finding[] = [
  finding(),
  ...Array.from({ length: 11 }, (_, i) =>
    finding({
      id: `acme-prod:REC-CONC-02:pool:pool_${i}`,
      rule_id: 'REC-CONC-02',
      title: 'Pool starvation',
      category: 'concurrency',
      scope: { kind: 'pool', id: `pool_${i}` },
      severity: 'warning',
      effort: 1,
      priority_score: 3 - i * 0.1,
      affected_dags: [`partner_${i}_sync`],
    }),
  ),
];
const NOT_EVALUATED: Findings['not_evaluated'] = [
  {
    rule_id: 'REC-CAP-08',
    title: 'Workers under resource pressure',
    reason: 'Worker CPU and memory sizes are not collected in this version.',
  },
];
const fixture = (findings: Finding[], over: Partial<Findings> = {}): Findings => ({
  env_id: 'acme-prod',
  data_as_of: AT,
  sources: ['DEMO'],
  findings,
  not_evaluated: NOT_EVALUATED,
  ...over,
});

const reject = () => Promise.reject(new Error('not in this test'));
const apiWith = (findings: Finding[], over: Partial<Findings> = {}): DcamApi => ({
  getMeta: reject,
  getOverview: reject,
  getDagLeague: reject,
  getDagDetail: reject,
  getBottlenecks: reject,
  getSchedule: reject,
  getDagComparison: reject,
  getRunComparison: reject,
  getCapacity: reject,
  getForecast: reject,
  getFindings: async () => fixture(findings, over),
  getAlerts: reject,
  getFleet: reject,
  getCollection: reject,
});

function renderPage(findings: Finding[] = many, over: Partial<Findings> = {}, params: PageParams = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <PageParamsContext.Provider value={{ params, set: () => {} }}>
          <AdvisorPage
            api={apiWith(findings, over)}
            envId="acme-prod"
            route={{ page: 'advisor' }}
            linkTo={(r) => linkTo(r, 'acme-prod')}
            navigate={() => {}}
          />
        </PageParamsContext.Provider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const original = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
afterEach(() => {
  if (original) Object.defineProperty(window.navigator, 'clipboard', original);
  else Reflect.deleteProperty(window.navigator, 'clipboard');
});
const mockClipboard = (writeText: ((text: string) => Promise<void>) | undefined) =>
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });

async function openFirst() {
  const top = await screen.findByRole('list', { name: 'Top actions' });
  const first = within(top).getAllByRole('listitem')[0] as HTMLElement;
  await userEvent.click(within(first).getByRole('button', { name: /Workers at maximum/ }));
  return first;
}

describe('S-18 advisor page (FR-ADV-01..04, FR-ADV-08)', () => {
  it('FR-ADV-03: states that DCAM never applies changes', async () => {
    renderPage();
    expect(await screen.findByText(/DCAM never applies changes/)).toBeInTheDocument();
  });

  it('FR-ADV-04: shows at most 10 top actions in ranked order, with severity as icon and label and every factor', async () => {
    renderPage();
    const top = await screen.findByRole('list', { name: 'Top actions' });
    const items = within(top).getAllByRole('listitem');
    expect(items).toHaveLength(10);
    const first = items[0] as HTMLElement;
    expect(within(first).getByText('Critical')).toBeInTheDocument();
    expect(within(first).getByTestId('severity-icon-critical')).toBeInTheDocument();
    expect(first).toHaveTextContent('Environment acme-prod');
    expect(first).toHaveTextContent('Impact 3/5');
    expect(first).toHaveTextContent('Confidence 0.92');
    expect(first).toHaveTextContent('Effort 2 (sizing)');
    expect(first).toHaveTextContent('Priority 1.38');
    expect(within(items[1] as HTMLElement).getByText('Warning')).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('Pool pool_0');
    const others = screen.getByRole('list', { name: 'Other findings' });
    expect(within(others).getAllByRole('listitem')).toHaveLength(2);
  });

  it('FR-ADV-08: a finding expands to observation, impact, action, evidence and "Why am I seeing this?"', async () => {
    renderPage();
    const first = await openFirst();
    expect(first).toHaveTextContent('Workers stayed at the maximum of 6 for 130 min');
    expect(first).toHaveTextContent('20 task-hours were spent queued');
    expect(first).toHaveTextContent('raise max_count from 6 to 9');
    const evidence = within(first).getByRole('table', { name: 'Evidence' });
    const row = within(evidence).getByRole('row', { name: /Capacity-bound minutes/ });
    expect(row).toHaveTextContent('130 min');
    expect(row).toHaveTextContent('≥ 15 min');
    expect(row).toHaveTextContent('demo data');
    expect(within(first).getByText(/This rule fires when workers equal max_count/)).toBeInTheDocument();
    expect(first).toHaveTextContent('Priority 1.38 = tier weight 1 × impact 3 × confidence 0.92 ÷ effort 2');
    expect(first).toHaveTextContent('Higher maximum increases peak cost.');
    expect(first).toHaveTextContent('Restore max_count to 6');
    expect(first).toHaveTextContent('Compare 7 days before and after');
  });

  it('FR-ADV-03: snippets are shown in monospace blocks and copied to the clipboard', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    renderPage();
    const first = await openFirst();
    const code = within(first).getByText(/gcloud composer environments update acme-prod/);
    expect(code.closest('pre')).not.toBeNull();
    mockClipboard(writeText);
    fireEvent.click(within(first).getByRole('button', { name: 'Copy gcloud snippet' }));
    expect(await within(first).findByText('Copied to the clipboard.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(GCLOUD);
  });

  it('FR-ADV-03: says how to copy by hand when the clipboard is not available', async () => {
    renderPage();
    const first = await openFirst();
    mockClipboard(undefined);
    fireEvent.click(within(first).getByRole('button', { name: 'Copy Terraform snippet' }));
    expect(await within(first).findByText(/select the text and copy it/)).toBeInTheDocument();
  });

  it('FR-UI-06: links affected DAGs to their page, the wiki in the same tab and docs in a new tab', async () => {
    renderPage();
    const first = await openFirst();
    expect(within(first).getByRole('link', { name: 'orders_daily' })).toHaveAttribute(
      'href',
      '#/dags/orders_daily?env=acme-prod',
    );
    expect(within(first).getByRole('link', { name: /wiki/i })).toHaveAttribute(
      'href',
      '#/wiki/advisor-rules?env=acme-prod',
    );
    const doc = within(first).getByRole('link', { name: /scale environments/ });
    expect(doc).toHaveAttribute('target', '_blank');
    expect(doc).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('FR-WIKI-06: links the wiki page the finding names when it exists, else the rule catalogue', async () => {
    const known = finding({ links: { wiki: 'pools', docs: [] } });
    renderPage([known]);
    const first = await openFirst();
    expect(within(first).getByRole('link', { name: /wiki/i })).toHaveAttribute(
      'href',
      '#/wiki/pools?env=acme-prod',
    );
  });

  it('FR-UI-07: shows an empty state with the next step when there are no findings', async () => {
    renderPage([], { not_evaluated: [] });
    expect(await screen.findByText(/No findings for acme-prod/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Top actions' })).toBeNull();
  });

  it('§13.2: lists the rules that could not be evaluated, with the reason', async () => {
    renderPage();
    const panel = await screen.findByRole('list', { name: 'Rules not evaluated' });
    expect(panel).toHaveTextContent('REC-CAP-08');
    expect(panel).toHaveTextContent('Worker CPU and memory sizes are not collected in this version.');
  });

  it('§13.2: with no findings, does not claim that nothing is wrong when some rules could not run', async () => {
    renderPage([]);
    const empty = await screen.findByText(/No findings for acme-prod/);
    expect(empty).toHaveTextContent('1 rule could not be evaluated');
    expect(empty).not.toHaveTextContent("no rule's condition held");
  });

  it('§8.1: says no data was collected instead of showing a data time', async () => {
    renderPage([], { data_as_of: null });
    const footer = await screen.findByText((_text, el) => el?.tagName === 'FOOTER');
    expect(footer).toHaveTextContent('No data collected yet');
  });

  it('FR-UI-08: shows where the findings come from and how fresh they are', async () => {
    renderPage();
    const footer = await screen.findByText(
      (_text, el) => el?.tagName === 'FOOTER' && /Data as of .* Source: demo data/.test(el.textContent ?? ''),
    );
    expect(footer).toHaveTextContent('last 24 hours');
  });

  it('FR-ADV-02: a link to one finding (from DAG detail) opens that finding', async () => {
    const linked = 'acme-prod:REC-CONC-02:pool:pool_3';
    renderPage(many, {}, { finding: linked });
    const item = (await screen.findByRole('button', { name: /pool_3/ })).closest('li') as HTMLElement;
    expect(within(item).getByRole('button', { name: /pool_3/ })).toHaveAttribute('aria-expanded', 'true');
    const other = screen.getByRole('button', { name: /pool_4/ });
    expect(other).toHaveAttribute('aria-expanded', 'false');
  });

  it('FR-ADV-02: a link to a finding that is no longer open says so', async () => {
    renderPage(many, {}, { finding: 'acme-prod:REC-DAG-01:dag:orders_daily' });
    expect(await screen.findByText(/The finding you opened is no longer open/)).toBeInTheDocument();
  });

  it('FR-UI-05: every panel and ranking factor has an explanation', () => {
    for (const id of ADVISOR_PANELS) {
      expect(ADVISOR_EXPLANATIONS[id].summary.length).toBeGreaterThan(10);
      expect(ADVISOR_EXPLANATIONS[id].sources.length).toBeGreaterThan(0);
    }
    expect(ADVISOR_EXPLANATIONS['adv-priority'].formula).toContain(
      'tier weight × impact × confidence ÷ effort',
    );
  });
});
