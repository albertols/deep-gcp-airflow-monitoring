/**
 * DAG league table (spec §12.4 S-11): every DAG ranked by its share of executor slot-seconds, with
 * concentration KPIs, filters, presets, a virtualised sortable table, a team → DAG treemap and CSV
 * export of the filtered rows. The range comes from the context bar; search, team, tag, preset and sort
 * are in the URL, so a shared link opens the same table.
 *
 * @implements FR-DAGX-01, FR-DAGX-02, FR-DAGX-03, FR-DAGX-04, FR-DAGX-07, FR-UI-01, FR-UI-02, FR-UI-05,
 *   FR-UI-07, FR-UI-08
 */
import { useDeferredValue, useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { DagLeague, DagLeagueRow } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import { HistoryNote } from '../../components/backfill';
import { CoverageNote, PageHeader } from '../../components/PageHeader';
import { Kpi, KpiRow, Panel, ProvenanceFooter, QueryState } from '../../components/Panel';
import { formatInt, formatSlotHours } from '../../components/format';
import { RANGE_PRESETS } from '../../components/range';
import { usePageParams, useRefresh, useView } from '../../components/view';
import type { PageProps } from '../types';
import { DAG_EXPLANATIONS as E } from './explanations';
import {
  DEFAULT_SORT,
  PRESETS,
  facetValues,
  filterRows,
  leagueCsv,
  parsePreset,
  parseSort,
  sortParam,
  sortRows,
  type PresetId,
} from './league';
import { LeagueTable, nextSort } from './LeagueTable';
import { Treemap } from './Treemap';

const NO_ROWS: readonly DagLeagueRow[] = [];
const gini = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Saves text as a file in the browser; nothing leaves the machine. */
function download(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function giniHint(g: number): string {
  if (g >= 0.7) return 'Highly concentrated: a few DAGs dominate';
  if (g >= 0.4) return 'Moderately concentrated';
  return 'Load is spread fairly evenly';
}

function Kpis({ data }: { data: DagLeague }) {
  return (
    <KpiRow>
      <Kpi
        explanation={E['dagx-pareto']}
        value={`${formatInt(data.pareto_80_dag_count)} of ${formatInt(data.dag_count)}`}
        unit="DAGs"
        hint="use 80 % of executor slot-hours"
      />
      <Kpi explanation={E['dagx-gini']} value={gini.format(data.gini)} hint={giniHint(data.gini)} />
      <Kpi
        explanation={E['dagx-active-dags']}
        value={`${formatInt(data.active_dag_count)} of ${formatInt(data.dag_count)}`}
        unit="DAGs"
        hint="held a worker slot in the range"
      />
      <Kpi
        explanation={E['dagx-total-slot-hours']}
        value={formatSlotHours(data.total_executor_slot_seconds)}
        unit="slot-hours"
      />
    </KpiRow>
  );
}

/** A select's options, with a value from a shared link even when this environment does not have it. */
const withValue = (values: readonly string[], value: string | null) =>
  value === null || values.includes(value) ? values : [...values, value];

export function DagsPage({ api, envId, linkTo }: PageProps) {
  const { range, time } = useView();
  const league = useQuery({
    queryKey: ['dag-league', envId, range],
    queryFn: () => api.getDagLeague(envId, range),
    // Keep the table while another range loads, but never show one environment's data for another.
    placeholderData: (previous, query) =>
      query?.queryKey[1] === envId ? keepPreviousData(previous) : undefined,
    ...useRefresh(),
  });
  // Filters and sort live in the URL (FR-UI-02).
  const { params, set } = usePageParams();
  const search = params['q'] ?? '';
  const deferredSearch = useDeferredValue(search);
  const team = params['team'] ?? null;
  const tag = params['tag'] ?? null;
  const preset = parsePreset(params['preset']);
  const sort = parseSort(params['sort']);
  const setSearch = (q: string) => set({ q });
  const setTeam = (next: string | null) => set({ team: next });
  const setTag = (next: string | null) => set({ tag: next });
  const setPreset = (next: PresetId) => set({ preset: next === 'all' ? null : next });
  const setSort = (next: typeof sort) =>
    set({ sort: sortParam(next) === sortParam(DEFAULT_SORT) ? null : sortParam(next) });

  const data = league.data;
  const rows = data?.rows ?? NO_ROWS;
  const facets = useMemo(() => facetValues(rows), [rows]);
  const filtered = useMemo(
    () => filterRows(rows, { search: deferredSearch, team, tag, preset }),
    [rows, deferredSearch, team, tag, preset],
  );
  const sorted = useMemo(() => sortRows(filtered, sort), [filtered, sort]);
  const filtering = search !== '' || team !== null || tag !== null || preset !== 'all';
  const clear = () => set({ q: null, team: null, tag: null, preset: null });
  const rangeText = RANGE_PRESETS[range];

  return (
    <Stack spacing={4}>
      <PageHeader
        title="DAG league table"
        subtitle={`${rangeText.label}, compared with the previous ${rangeText.span}. Ranked by share of executor slot-hours.`}
      />
      <QueryState
        isPending={league.isPending}
        error={league.error}
        what="the DAG league table"
        range={range}
      />
      {data && <CoverageNote coverage={data.coverage} range={range} />}

      {data && (
        <>
          <Kpis data={data} />

          <Panel
            explanation={E['dagx-league']}
            actions={
              <Button
                size="small"
                variant="outlined"
                disabled={filtered.length === 0}
                onClick={() =>
                  download(
                    leagueCsv(sorted),
                    `dcam-dags-${data.env_id}-${range}-${data.data_as_of.slice(0, 16).replace(/:/g, '')}.csv`,
                  )
                }
              >
                Export CSV
              </Button>
            }
          >
            {rows.length === 0 ? (
              <Alert severity="info">
                No DAGs are known in this environment yet. They appear after DCAM's first inventory
                collection; check back in a few minutes, or pick another environment.
              </Alert>
            ) : (
              <Stack spacing={2}>
                <Stack direction="row" sx={{ gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                  <TextField
                    size="small"
                    label="Search DAGs"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    sx={{ minWidth: 220 }}
                  />
                  <TextField
                    select
                    size="small"
                    label="Team"
                    value={team ?? ''}
                    onChange={(e) => setTeam(e.target.value || null)}
                    sx={{ minWidth: 160 }}
                  >
                    <MenuItem value="">All teams</MenuItem>
                    {withValue(facets.teams, team).map((t) => (
                      <MenuItem key={t} value={t}>
                        {t}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    select
                    size="small"
                    label="Tag"
                    value={tag ?? ''}
                    onChange={(e) => setTag(e.target.value || null)}
                    sx={{ minWidth: 160 }}
                  >
                    <MenuItem value="">All tags</MenuItem>
                    {withValue(facets.tags, tag).map((t) => (
                      <MenuItem key={t} value={t}>
                        {t}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Stack direction="row" sx={{ alignItems: 'center' }}>
                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={preset}
                      aria-label="Presets"
                      onChange={(_e, next: PresetId | null) => setPreset(next ?? 'all')}
                    >
                      {PRESETS.map((p) => (
                        <ToggleButton key={p.id} value={p.id}>
                          {p.label}
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                    <InfoPopover explanation={E['dagx-presets']} />
                  </Stack>
                </Stack>
                <Typography variant="caption" color="text.secondary" role="status">
                  Showing {formatInt(filtered.length)} of {formatInt(rows.length)} DAGs
                </Typography>
                {filtered.length === 0 ? (
                  <Alert
                    severity="info"
                    action={
                      <Button color="inherit" size="small" onClick={clear}>
                        Clear filters
                      </Button>
                    }
                  >
                    No DAG matches these filters. Clear them, or choose another preset.
                  </Alert>
                ) : (
                  <LeagueTable
                    rows={sorted}
                    sort={sort}
                    onSort={(key) => setSort(nextSort(sort, key))}
                    linkTo={linkTo}
                    resetKey={JSON.stringify([sort, deferredSearch, team, tag, preset])}
                    previousCoverage={data.previous_coverage}
                  />
                )}
                {filtering && filtered.length > 0 && (
                  <Button size="small" onClick={clear} sx={{ alignSelf: 'flex-start' }}>
                    Clear filters
                  </Button>
                )}
              </Stack>
            )}
          </Panel>

          <Panel explanation={E['dagx-treemap']}>
            <Treemap rows={filtered} team={team} onTeam={setTeam} linkTo={linkTo} />
          </Panel>

          <HistoryNote
            api={api}
            envId={envId}
            rangeFrom={data.range.from}
            kinds={['task_instances']}
            healthHref={linkTo({ page: 'health' })}
          />
          <ProvenanceFooter
            dataAsOf={data.data_as_of}
            sources={data.sources}
            note={`Range ${time.dateTime(data.range.from)} to ${time.dateTime(data.range.to)}, compared with ${time.dateTime(data.previous_range.from)} to ${time.dateTime(data.previous_range.to)}`}
          />
        </>
      )}
    </Stack>
  );
}
