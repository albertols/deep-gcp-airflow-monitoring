/**
 * S-14 Compare DAGs (FR-DAGD-08): 2 to 4 DAGs from the same or different environments, side by side over
 * the context bar's range: aligned KPIs, duration distributions on shared bins, hourly load profiles,
 * resource shares and each environment's capacity context. The selection is in the URL (`dags`,
 * `env:dag` items), so a shared link opens the same comparison (FR-UI-02). The API compares every
 * environment in UTC; times on this page follow the context bar's zone, and the hourly profile says UTC.
 * Its exports name the range and the comparison's data as of; no environment, as it spans several.
 *
 * @implements FR-DAGD-08, FR-UI-01, FR-UI-02, FR-UI-05, FR-UI-07, FR-UI-08, FR-STORE-04
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import { useTheme } from '@mui/material/styles';
import { ApiError } from '../../api';
import { ExportScope } from '../../components/ExportCsv';
import { clause } from '../../components/format';
import { PageHeader } from '../../components/PageHeader';
import { ProvenanceFooter } from '../../components/Panel';
import { RANGE_PRESETS, loadingText } from '../../components/range';
import { seriesStyle } from '../../components/series';
import { usePageParam, useRefresh, useView } from '../../components/view';
import { linkTo as hrefTo } from '../../router';
import type { PageProps } from '../types';
import {
  CapacityPanel,
  DurationPanel,
  HourlyPanel,
  KpiPanel,
  ResourcePanel,
  type Styled,
} from './ComparePanels';
import { CompareSelection } from './CompareSelection';
import {
  addToSelection,
  canCompare,
  formatSelection,
  itemKey,
  parseSelection,
  removeFromSelection,
  type CompareItem,
} from './selection';

export function CompareDagsPage({ api, envId }: PageProps) {
  const { range, tz, paused, time } = useView();
  const mode = useTheme().palette.mode;
  const [param, setParam] = usePageParam('dags');
  const items = parseSelection(param);
  const dags = formatSelection(items);
  const styles = items.map((_, i) => seriesStyle(mode, i));
  // A DAG's detail page in its own environment, keeping the context bar's range and zone.
  const hrefOf = (item: CompareItem) =>
    hrefTo({ page: 'dag', dagId: item.dagId }, item.envId, { range, tz, paused });
  const comparison = useQuery({
    queryKey: ['dag-compare', dags, range],
    queryFn: () => api.getDagComparison(dags, range),
    enabled: canCompare(items),
    placeholderData: keepPreviousData,
    ...useRefresh(),
  });
  const data = canCompare(items) ? comparison.data : undefined;
  const styled: Styled[] =
    data?.dags.map((dag, i) => {
      const at = items.findIndex((x) => itemKey(x) === `${dag.env_id}:${dag.dag_id}`);
      return {
        dag,
        style: styles[at === -1 ? i : at] ?? seriesStyle(mode, i),
        href: hrefOf({ envId: dag.env_id, dagId: dag.dag_id }),
      };
    }) ?? [];
  const error = comparison.error;
  const badRequest = error instanceof ApiError && error.status < 500;

  return (
    <Stack spacing={4}>
      <PageHeader
        title="Compare DAGs"
        subtitle={`${RANGE_PRESETS[range].label}. 2 to 4 DAGs from any environment, side by side; times in ${time.zoneName()}, hours of the day in UTC.`}
      />
      <CompareSelection
        api={api}
        envId={envId}
        items={items}
        styles={styles}
        hrefOf={hrefOf}
        onAdd={(item) => setParam(formatSelection(addToSelection(items, item)))}
        onRemove={(item) => setParam(formatSelection(removeFromSelection(items, item)))}
      />
      {canCompare(items) && error && (
        <Alert severity="error">
          Couldn't compare these DAGs: {clause(error.message)}.{' '}
          {badRequest
            ? 'Remove it, or pick another DAG from the list above.'
            : 'Check that DCAM is still running, then reload the page.'}
        </Alert>
      )}
      {canCompare(items) && comparison.isPending && (
        <Skeleton variant="rounded" height={320} aria-label={loadingText('the comparison', range)} />
      )}
      {data && (
        <ExportScope envId={null} range={range} asOf={data.data_as_of} rangeEnd={data.range.to}>
          <KpiPanel data={data} dags={styled} />
          <DurationPanel data={data} dags={styled} />
          <HourlyPanel data={data} dags={styled} />
          <ResourcePanel data={data} dags={styled} />
          <CapacityPanel data={data} dags={styled} />
          <ProvenanceFooter
            dataAsOf={data.data_as_of}
            sources={data.sources}
            note={`Range ${time.dateTime(data.range.from)} to ${time.dateTime(data.range.to)}; hours of the day in ${data.time_zone}`}
          />
        </ExportScope>
      )}
    </Stack>
  );
}
