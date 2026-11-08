import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import type { EnvironmentOverview } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { ProvenanceFooter } from '../src/components/Panel';
import { OverviewPage } from '../src/OverviewPage';

const overview: EnvironmentOverview = {
  env_id: 'acme-emulator',
  range: { from: '2026-11-04T12:00:00.000Z', to: '2026-11-05T12:00:00.000Z' },
  data_as_of: '2026-11-05T12:00:00.000Z',
  sources: ['SRC-AF-API'],
  approximate: false,
  total_executor_slot_seconds: 36_000,
  peak_concurrency: 4,
  dag_count: 3,
  active_dag_count: 1,
  pareto_80_dag_count: 1,
  top_dags: [],
};
const reject = () => Promise.reject(new Error('not in this test'));
const api: DcamApi = {
  getMeta: reject,
  getOverview: async () => overview,
  getDagLeague: reject,
  getDagDetail: reject,
  getBottlenecks: reject,
  getSchedule: reject,
  getDagComparison: reject,
  getRunComparison: reject,
  getCapacity: reject,
  getForecast: reject,
  getFindings: reject,
  getAlerts: reject,
  getFleet: reject,
  getCollection: reject,
};
const wrap = (node: React.ReactNode) => (
  <ThemeProvider theme={createDcamTheme('dark')}>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {node}
    </QueryClientProvider>
  </ThemeProvider>
);

describe('FR-UI-08 provenance footers', () => {
  it('FR-UI-08: the overview footer names sources as the other pages do, never by ID', async () => {
    render(wrap(<OverviewPage api={api} envId="acme-emulator" />));
    const footer = await screen.findByRole('contentinfo');
    expect(footer).toHaveTextContent('Source: Airflow REST API');
    expect(footer).not.toHaveTextContent('SRC-AF-API');
  });

  it('FR-UI-08: a page without any contributing source says so', () => {
    render(wrap(<ProvenanceFooter dataAsOf={null} sources={[]} />));
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Source: none yet');
  });
});
