/**
 * DAG league table (spec §12.4 S-11): every DAG ranked by its share of executor slot-seconds, with
 * concentration KPIs, filters, presets, a virtualised sortable table, a team → DAG treemap and CSV
 * export of the filtered rows.
 *
 * @implements FR-DAGX-01, FR-DAGX-02, FR-DAGX-03, FR-DAGX-04, FR-DAGX-07, FR-UI-05, FR-UI-07, FR-UI-08
 */
import { useDeferredValue, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { DagLeague, DagLeagueRow, Range } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import { PageHeader } from '../../components/PageHeader';
import { Kpi, KpiRow, Panel, ProvenanceFooter, QueryState } from '../../components/Panel';
import { formatInt, formatSlotHours } from '../../components/format';
import type { PageProps } from '../types';
import { DAG_EXPLANATIONS as E } from './explanations';
import {
  DEFAULT_SORT,
  PRESETS,
  facetValues,
  filterRows,
  leagueCsv,
  sortRows,
  type PresetId,
  type SortState,
} from './league';
import { LeagueTable, nextSort } from './LeagueTable';
import { RANGE_LABEL, formatUtc } from './time';
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

export function DagsPage({ api, envId, linkTo }: PageProps) {
  const [range, setRange] = useState<Range>('24h');
  const league = useQuery({
    queryKey: ['dag-league', envId, range],
    queryFn: () => api.getDagLeague(envId, range),
    // Keep the table while another range loads, but never show one environment's data for another.
    placeholderData: (previous, query) =>
      query?.queryKey[1] === envId ? keepPreviousData(previous) : undefined,
  });
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [team, setTeam] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [preset, setPreset] = useState<PresetId>('all');
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

  const data = league.data;
  const rows = data?.rows ?? NO_ROWS;
  const facets = useMemo(() => facetValues(rows), [rows]);
  const filtered = useMemo(
    () => filterRows(rows, { search: deferredSearch, team, tag, preset }),
    [rows, deferredSearch, team, tag, preset],
  );
  const sorted = useMemo(() => sortRows(filtered, sort), [filtered, sort]);
  const filtering = search !== '' || team !== null || tag !== null || preset !== 'all';
  const clear = () => {
    setSearch('');
    setTeam(null);
    setTag(null);
    setPreset('all');
  };
  const label = RANGE_LABEL[range];

  return (
    <Stack spacing={4}>
      <PageHeader
        title="DAG league table"
        subtitle={`Last ${label}, compared with the previous ${label}. Ranked by share of executor slot-hours.`}
        range={range}
        onRangeChange={setRange}
      />
      <QueryState isPending={league.isPending} error={league.error} what="the DAG league table" />

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
                    {facets.teams.map((t) => (
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
                    {facets.tags.map((t) => (
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
                    onSort={(key) => setSort((s) => nextSort(s, key))}
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

          <ProvenanceFooter
            dataAsOf={data.data_as_of}
            sources={data.sources}
            note={`Range ${formatUtc(data.range.from)} to ${formatUtc(data.range.to)}, compared with ${formatUtc(data.previous_range.from)} to ${formatUtc(data.previous_range.to)}`}
          />
        </>
      )}
    </Stack>
  );
}
