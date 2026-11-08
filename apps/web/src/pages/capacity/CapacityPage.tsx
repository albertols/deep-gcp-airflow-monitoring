/**
 * S-04 capacity (Q-04 "Is the environment out of capacity?"): worker slots against the task instances that use
 * them, the DAGs that load each hour of the day, and the next 24 hours' forecast, in three tabs whose choice is
 * in the URL. Capacity follows the context bar's range, mapped to the nearest range it analyses (1 hour to 7
 * days) with a note that says so; the forecast has no range. Each tab has its loading, empty, partial, stale
 * and error states and a provenance footer.
 *
 * @implements FR-ENV-02, FR-DAGX-06, HM-010, FR-UI-01, FR-UI-02, FR-UI-07, FR-UI-08
 */
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { HistoryNote } from '../../components/backfill';
import { PageHeader } from '../../components/PageHeader';
import { ProvenanceFooter, QueryState } from '../../components/Panel';
import { RANGE_PRESETS } from '../../components/range';
import { usePageParam, useRefresh, useView } from '../../components/view';
import type { PageProps } from '../types';
import { CapacityFreshness, CapacityNotes } from './CapacityNotes';
import { CapacityTab } from './CapacityTab';
import { DagLoadPanel } from './DagLoadPanel';
import { ForecastTab } from './ForecastTab';
import { bucketName } from './format';
import { capacityRangeOf } from './range';

const TABS = ['capacity', 'dags', 'forecast'] as const;
type CapacityTabId = (typeof TABS)[number];
const isTab = (v: string): v is CapacityTabId => (TABS as readonly string[]).includes(v);

const SUBTITLE: Readonly<Record<CapacityTabId, (span: string) => string>> = {
  capacity: (label) =>
    `${label}. Worker slots against the task instances that run and queue in them, and when the environment ran out of capacity.`,
  dags: (label) => `${label}. The DAGs that hold the most worker slots, by hour of the day (UTC).`,
  forecast: () =>
    'Expected slot demand against capacity, from the DAG schedules and how their past runs used worker slots.',
};

export function CapacityPage({ api, envId, linkTo }: PageProps) {
  const { range } = useView();
  const [tabParam, setTab] = usePageParam('tab', 'capacity');
  const tab: CapacityTabId = isTab(tabParam) ? tabParam : 'capacity';
  const choice = capacityRangeOf(range);
  const refresh = useRefresh();
  const capacity = useQuery({
    queryKey: ['capacity', envId, choice.range],
    queryFn: () => api.getCapacity(envId, choice.range),
    enabled: tab !== 'forecast',
    ...refresh,
  });
  const forecast = useQuery({
    queryKey: ['forecast', envId],
    queryFn: () => api.getForecast(envId),
    enabled: tab === 'forecast',
    ...refresh,
  });

  return (
    <Stack spacing={4}>
      <PageHeader title="Capacity" subtitle={SUBTITLE[tab](RANGE_PRESETS[choice.range].label)}>
        <CapacityFreshness api={api} envId={envId} />
      </PageHeader>
      {choice.note && tab !== 'forecast' && (
        <Alert severity="info" variant="outlined">
          {choice.note}
        </Alert>
      )}
      <Tabs
        value={tab}
        onChange={(_e, next: CapacityTabId) => setTab(next)}
        aria-label="Capacity views"
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab value="capacity" label="Capacity" />
        <Tab value="dags" label="Load by DAG" />
        <Tab value="forecast" label="Forecast" />
      </Tabs>
      {tab === 'forecast' ? (
        <QueryState isPending={forecast.isPending} error={forecast.error} what="the forecast" />
      ) : (
        <QueryState
          isPending={capacity.isPending}
          error={capacity.error}
          what="the capacity analysis"
          range={choice.range}
        />
      )}
      {tab !== 'forecast' && capacity.data && (
        <HistoryNote
          api={api}
          envId={envId}
          rangeFrom={capacity.data.range.from}
          kinds={tab === 'dags' ? ['task_instances'] : ['task_instances', 'metrics']}
          healthHref={linkTo({ page: 'health' })}
        />
      )}
      {tab === 'capacity' && capacity.data && (
        <>
          <CapacityNotes c={capacity.data} span={RANGE_PRESETS[choice.range].span} linkTo={linkTo} />
          <CapacityTab
            c={capacity.data}
            span={RANGE_PRESETS[choice.range].span}
            linkTo={linkTo}
            onForecast={() => setTab('forecast')}
          />
          <ProvenanceFooter
            dataAsOf={capacity.data.data_as_of}
            sources={capacity.data.sources}
            note={`${bucketName(capacity.data.bucket_seconds)} buckets; worker figures from Cloud Monitoring samples, else live snapshots; heatmaps in UTC`}
          />
        </>
      )}
      {tab === 'dags' && capacity.data && (
        <>
          <DagLoadPanel c={capacity.data} linkTo={linkTo} />
          <ProvenanceFooter
            dataAsOf={capacity.data.data_as_of}
            sources={capacity.data.sources}
            note={`computed from task tries (${capacity.data.dag_load.method}); hours in UTC`}
          />
        </>
      )}
      {tab === 'forecast' && forecast.data && <ForecastTab f={forecast.data} linkTo={linkTo} />}
    </Stack>
  );
}
