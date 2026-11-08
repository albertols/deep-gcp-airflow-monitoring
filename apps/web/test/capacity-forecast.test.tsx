import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { useCallback, useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { Forecast, Range } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import { timeFormat } from '../src/components/time';
import { DEFAULT_PAGE_VIEW, PageParamsContext, ViewContext, type View } from '../src/components/view';
import { linkTo, type PageParams } from '../src/router';
import { CapacityPage } from '../src/pages/capacity/CapacityPage';
import { capacityApi, forecastFixture } from './capacity-fixtures';

/** Page parameters held in state, as the shell holds them in the URL. */
function Params({ initial, children }: { initial: PageParams; children: ReactNode }) {
  const [params, setParams] = useState<PageParams>(initial);
  const set = useCallback((patch: Readonly<Record<string, string | null>>) => {
    setParams((current) => {
      const next: Record<string, string> = { ...current };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') delete next[k];
        else next[k] = v;
      }
      return next;
    });
  }, []);
  return <PageParamsContext.Provider value={{ params, set }}>{children}</PageParamsContext.Provider>;
}

function renderForecast(
  forecast: Forecast = forecastFixture,
  range: Range = '24h',
  view: Partial<View> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <ViewContext.Provider value={{ ...DEFAULT_PAGE_VIEW, range, ...view }}>
          <Params initial={{ tab: 'forecast' }}>
            <CapacityPage
              api={capacityApi(undefined, forecast)}
              envId="acme-prod"
              route={{ page: 'capacity' }}
              linkTo={(r) => linkTo(r, 'acme-prod')}
              navigate={() => {}}
            />
          </Params>
        </ViewContext.Provider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const panel = (title: string) => screen.findByRole('region', { name: title });
async function alertWith(text: RegExp) {
  const alert = (await screen.findByText(text)).closest('[role="alert"]');
  if (!(alert instanceof HTMLElement)) throw new Error(`No alert says ${String(text)}`);
  return alert;
}
async function kpi(title: string) {
  const card = (await screen.findByRole('heading', { name: title })).closest('.MuiPaper-root');
  if (!(card instanceof HTMLElement)) throw new Error(`No KPI card for ${title}`);
  return card;
}
const rowOf = (scope: HTMLElement, text: string) => {
  const row = within(scope).getByText(text).closest('tr');
  if (!(row instanceof HTMLElement)) throw new Error(`No row with ${text}`);
  return row;
};

describe('S-04 forecast tab (HM-010, FR-BOTL-05)', () => {
  it('HM-010: says it is the next 24 hours from now, built from history, whatever the time range', async () => {
    renderForecast(forecastFixture, '30d');
    expect(
      await screen.findByText(
        'Forecast for the next 24 hours from now: 5 Nov, 12:00 to 6 Nov, 12:00 UTC, built from 2 days of task history (3 Nov, 11:00 to 5 Nov, 12:00 UTC). It does not follow the time range.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Capacity covers the last/)).toBeNull();
  });

  it('HM-010: low confidence is stated first and prominently, with what it rests on', async () => {
    renderForecast();
    const alert = await alertWith(/^Low confidence: 3 of 3 DAGs have less than 14 days of history/);
    expect(alert).toHaveClass('MuiAlert-colorWarning');
    expect(alert).toHaveTextContent(
      '1 DAG has planned runs but no profiled run: its demand is unknown, not zero, and not in the forecast.',
    );
    expect(await kpi('History used')).toHaveTextContent(/2\s*days/);
    expect(await kpi('History used')).toHaveTextContent(
      '14 days needed; 28 read at most; 4,829 runs profiled',
    );
  });

  it('HM-010: a normal-confidence forecast says so without a warning', async () => {
    renderForecast({
      ...forecastFixture,
      confidence: {
        ...forecastFixture.confidence,
        level: 'normal',
        summary: 'Every DAG in the forecast has at least 14 days of history.',
        low_confidence_dags: 0,
        dags_without_history: 0,
        low_confidence_share: 0,
      },
    });
    const alert = await alertWith(/^Every DAG in the forecast has at least 14 days of history\./);
    expect(alert).not.toHaveClass('MuiAlert-colorWarning');
  });

  it('FR-BOTL-05: KPIs for the predicted saturation windows, the peak demand and the planned runs', async () => {
    renderForecast();
    expect(await kpi('Predicted saturation windows')).toHaveTextContent(/^Predicted saturation windows.*1/);
    expect(await kpi('Predicted saturation windows')).toHaveTextContent('First 6 Nov, 02:00 UTC for 46 min');
    expect(await kpi('Peak forecast demand')).toHaveTextContent(/131\.4\s*slots/);
    expect(await kpi('Peak forecast demand')).toHaveTextContent('Worker slots at max_count: 72');
    expect(await kpi('Planned runs')).toHaveTextContent('2 DAGs without a cron schedule are in the baseline');
  });

  it('FR-BOTL-05: the demand chart is an estimate with its band, and highlights the saturation and risk windows', async () => {
    renderForecast();
    const p = await panel('Forecast slot demand');
    expect(within(p).getByText('Estimate')).toBeInTheDocument();
    const chart = within(p).getByRole('img', { name: /^Forecast slot demand per 5-minute step/ });
    expect(chart).toHaveAccessibleName(
      'Forecast slot demand per 5-minute step for the next 24 hours, an estimate. Peak p50 131.4 slots against 72 worker slots at max_count. Predicted saturation: 6 Nov, 02:00–02:46 UTC (46 min). Risk (p90 above capacity): 6 Nov, 01:50–03:00 UTC (70 min).',
    );
    expect(within(chart).getAllByText(/^Predicted saturation /)).toHaveLength(10);
    expect(within(chart).getAllByText(/^Risk /)).toHaveLength(4);
  });

  it('NFR-A11Y-01: the demand chart has a table view per step', async () => {
    renderForecast();
    const p = await panel('Forecast slot demand');
    await userEvent.click(within(p).getByRole('button', { name: 'View as a table' }));
    const table = await within(p).findByRole('table', { name: 'Forecast per 5-minute step' });
    expect(rowOf(table, '6 Nov, 02:00')).toHaveTextContent(/90.*131\.4.*150.*5.*Saturation/);
    expect(rowOf(table, '6 Nov, 01:50')).toHaveTextContent(/Risk/);
  });

  it('HM-010 / FR-BOTL-05: lists the saturation and risk windows with their top DAGs and confidence', async () => {
    renderForecast();
    const p = await panel('Saturation and risk windows');
    const sat = within(p).getByRole('table', { name: 'Predicted saturation windows (p50)' });
    expect(rowOf(sat, '6 Nov, 02:00')).toHaveTextContent(
      /02:46.*46 min.*131\.4.*72.*Low confidence.*acme_orders_nightly 45%.*acme_billing_nightly 32%/,
    );
    const risk = within(p).getByRole('table', { name: 'Risk windows (p90)' });
    expect(rowOf(risk, '6 Nov, 01:50')).toHaveTextContent(/03:00.*70 min.*150/);
    expect(within(sat).getByRole('link', { name: 'acme_orders_nightly' })).toHaveAttribute(
      'href',
      '#/dags/acme_orders_nightly?env=acme-prod',
    );
  });

  it('HM-010: says why saturation is not evaluated when capacity is unknown', async () => {
    const reason =
      'worker_concurrency is not known, so the worker slots at max_count are not known (HM-032).';
    renderForecast({
      ...forecastFixture,
      capacity: {
        ...forecastFixture.capacity,
        worker_slots_at_max: null,
        worker_concurrency_source: 'unknown',
      },
      saturation: {
        ...forecastFixture.saturation,
        evaluated: false,
        not_evaluated_reason: reason,
        windows: [],
      },
      risk: { ...forecastFixture.risk, evaluated: false, not_evaluated_reason: reason, windows: [] },
    });
    expect(await panel('Saturation and risk windows')).toHaveTextContent(`Not evaluated: ${reason}`);
    expect(await kpi('Predicted saturation windows')).toHaveTextContent('Not known yet');
    expect(await kpi('Peak forecast demand')).toHaveTextContent('Worker slots at max_count: unknown');
  });

  it('HM-010: DAGs with their history and confidence; a DAG without a profiled run has unknown demand', async () => {
    renderForecast();
    const p = await panel('DAGs in the forecast');
    expect(rowOf(p, 'acme_orders_nightly')).toHaveTextContent(
      /30 1 \* \* \*.*1.*2.*2 days.*Low confidence.*1,200.*60/,
    );
    expect(rowOf(p, 'acme_new_export')).toHaveTextContent(/No history.*Low confidence.*Unknown.*Unknown/);
  });

  it('HM-010: pool demand against pool sizes; a pool without a forecast has no data', async () => {
    renderForecast();
    const p = await panel('Pool demand forecast');
    expect(rowOf(p, 'acme_etl')).toHaveTextContent(/24.*30.*6 Nov, 02:15.*30 min/);
    expect(rowOf(p, 'default_pool')).toHaveTextContent(/128.*No data.*No data.*No data/);
  });

  it('FR-UI-01: the pool table names the zone of its peak times, as every other time column does', async () => {
    const local = timeFormat('local', 'America/New_York');
    renderForecast(forecastFixture, '24h', { tz: 'local', time: local });
    const p = await panel('Pool demand forecast');
    const peakAt = forecastFixture.pools[0]?.peak_at ?? '';
    expect(
      within(p).getByRole('columnheader', { name: `Peak at (${local.zoneName(peakAt)})` }),
    ).toBeInTheDocument();
    expect(rowOf(p, 'acme_etl')).toHaveTextContent(local.dayClock(peakAt));
  });

  it('FR-UI-07: without history the forecast says why and what happens next', async () => {
    renderForecast({
      ...forecastFixture,
      evaluated: false,
      not_evaluated_reason: 'No task history for this environment yet.',
      data_as_of: null,
      history: { ...forecastFixture.history, from: null, days: 0, runs_profiled: 0 },
      confidence: {
        ...forecastFixture.confidence,
        summary:
          'No forecast yet: DCAM has no task history for this environment. It starts after the first collection cycles.',
      },
      series: [],
      saturation: { ...forecastFixture.saturation, evaluated: false, windows: [] },
      risk: { ...forecastFixture.risk, evaluated: false, windows: [] },
      dags: [],
      pools: [],
    });
    expect(await alertWith(/^No forecast yet: DCAM has no task history/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Forecast slot demand' })).toBeNull();
    expect(await screen.findByRole('contentinfo')).toHaveTextContent('No data collected yet');
  });
});
