/**
 * The evidence panels of S-14 Compare DAGs (FR-DAGD-08): aligned KPIs, duration distributions on the
 * shared bins, hourly load profiles in UTC, resource shares and each environment's capacity context. Each
 * DAG keeps its letter, colour, dash and marker in every chart and table; every chart has a table view;
 * missing values are gaps, never zero.
 *
 * @implements FR-DAGD-08, HM-003, HM-011, NFR-DATA-03, FR-UI-05, FR-UI-07, FR-UI-08
 */
import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { CompareDag, CompareEnvironment, DagComparison } from '@dcam/contracts';
import {
  describeQuantile,
  formatDuration,
  formatInt,
  formatQuantile,
  formatSchedule,
  formatShare,
  formatSlotHours,
} from '../../components/format';
import { LineChart, type Line } from '../../components/line-chart';
import { Panel, ProvenanceFooter } from '../../components/Panel';
import type { SeriesStyle } from '../../components/series';
import { useTableView } from '../../components/view-toggle';
import { usePageParam, useTimeFormat } from '../../components/view';
import { COMPARE_EXPLANATIONS as E } from '../dags/compare-explanations';

const MONO = '"Roboto Mono", ui-monospace, monospace';
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const NOT_KNOWN = 'Not known yet';

/** One compared DAG with its series style and the link to its detail page in its own environment. */
export interface Styled {
  readonly dag: CompareDag;
  readonly style: SeriesStyle;
  readonly href: string;
}

function Swatch({ style }: { style: SeriesStyle }) {
  return (
    <svg width={22} height={10} aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 4 }}>
      <line x1={1} x2={21} y1={5} y2={5} stroke={style.color} strokeWidth={3} strokeDasharray={style.dash} />
    </svg>
  );
}

/** A DAG's column header: letter, line style, DAG ID linked to its detail page, environment. */
function DagHeader({ s }: { s: Styled }) {
  return (
    <TableCell align="right" sx={{ verticalAlign: 'bottom' }}>
      <Box component="span" sx={{ fontWeight: 500 }}>
        <Swatch style={s.style} />
        {s.style.letter}{' '}
      </Box>
      <Link href={s.href} sx={{ fontFamily: MONO }}>
        {s.dag.dag_id}
      </Link>
      <Typography variant="caption" color="text.secondary" component="div">
        {s.dag.env_id}
      </Typography>
    </TableCell>
  );
}

function RowHeader({ children }: { children: ReactNode }) {
  return (
    <TableCell component="th" scope="row" sx={{ whiteSpace: 'nowrap' }}>
      {children}
    </TableCell>
  );
}

const footer = (data: DagComparison, note: string) => (
  <ProvenanceFooter as="p" dataAsOf={data.data_as_of} sources={data.sources} note={note} />
);

export function KpiPanel({ data, dags }: { data: DagComparison; dags: readonly Styled[] }) {
  const rows: ReadonlyArray<readonly [string, (d: CompareDag) => ReactNode]> = [
    ['Team', (d) => d.team],
    ['Schedule', (d) => formatSchedule(d.schedule).text],
    ['State', (d) => (d.paused ? 'Paused' : 'Active')],
    ['max_active_tasks', (d) => formatInt(d.max_active_tasks)],
    ['Runs', (d) => formatInt(d.kpis.runs)],
    ['Success rate', (d) => formatShare(d.kpis.success_rate)],
    ['Run duration p50', (d) => formatQuantile(d.kpis.run_duration_p50)],
    ['Run duration p95', (d) => formatQuantile(d.kpis.run_duration_p95)],
    ['Queue wait p95', (d) => formatQuantile(d.kpis.queue_wait_p95)],
    ['Tries', (d) => formatInt(d.kpis.tries)],
    ['Retries', (d) => formatInt(d.kpis.retries)],
    [
      'Flaky rate',
      (d) =>
        d.kpis.flaky_rate !== null && d.kpis.flaky_inferred > 0
          ? `≤ ${formatShare(d.kpis.flaky_rate)}`
          : formatShare(d.kpis.flaky_rate),
    ],
    ['Peak concurrency', (d) => formatInt(d.kpis.peak_concurrency)],
  ];
  const titles: Readonly<Record<string, (d: CompareDag) => string | undefined>> = {
    'Run duration p50': (d) => describeQuantile(d.kpis.run_duration_p50),
    'Run duration p95': (d) => describeQuantile(d.kpis.run_duration_p95),
    'Queue wait p95': (d) => describeQuantile(d.kpis.queue_wait_p95),
    'Flaky rate': (d) => (d.kpis.flaky_rate === null ? 'Fewer than 20 task instances' : undefined),
  };
  return (
    <Panel explanation={E['cmp-kpis']}>
      <Stack spacing={2}>
        <TableContainer>
          <Table size="small" aria-label="Aligned KPIs">
            <TableHead>
              <TableRow>
                <TableCell>KPI</TableCell>
                {dags.map((s) => (
                  <DagHeader key={`${s.dag.env_id}:${s.dag.dag_id}`} s={s} />
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(([label, value]) => (
                <TableRow key={label}>
                  <RowHeader>{label}</RowHeader>
                  {dags.map((s) => (
                    <TableCell
                      key={`${s.dag.env_id}:${s.dag.dag_id}`}
                      align="right"
                      title={titles[label]?.(s.dag)}
                      sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {value(s.dag)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        {footer(data, "the league table's statistics over the range (FR-DAGX-02)")}
      </Stack>
    </Panel>
  );
}

export function DurationPanel({ data, dags }: { data: DagComparison; dags: readonly Styled[] }) {
  const [asTable, toggle] = useTableView('durations');
  const edges = data.duration_bins_seconds;
  const bins = Math.max(0, edges.length - 1);
  const totals = dags.map((s) => s.dag.duration_histogram.reduce((a, b) => a + b, 0));
  const shareOf = (k: number, i: number) => {
    const total = totals[k] ?? 0;
    return total > 0 ? (dags[k]?.dag.duration_histogram[i] ?? 0) / total : null;
  };
  const binLabel = (i: number) => `${formatDuration(edges[i] ?? 0)} to ${formatDuration(edges[i + 1] ?? 0)}`;
  const lines: Line[] = dags.map((s, k) => ({
    key: `${s.dag.env_id}:${s.dag.dag_id}`,
    label: `${s.style.letter} ${s.dag.dag_id} (${s.dag.env_id})`,
    values: Array.from({ length: bins }, (_, i) => shareOf(k, i)),
    color: s.style.color,
    dash: s.style.dash,
    marker: s.style.marker,
  }));
  const medians = dags
    .map(
      (s) =>
        `${s.style.letter} median ${formatDuration(s.dag.duration.p50)}, p95 ${s.dag.duration.low_sample ? '≤ ' : ''}${formatDuration(s.dag.duration.p95)} from ${formatInt(s.dag.duration.samples)} runs`,
    )
    .join('; ');
  const description = `Duration distributions of ${dags.length} DAGs over ${bins} shared bins from ${formatDuration(edges[0] ?? 0)} to ${formatDuration(edges.at(-1) ?? 0)}: ${medians}.`;
  return (
    <Panel explanation={E['cmp-durations']} actions={bins > 0 && toggle}>
      <Stack spacing={2}>
        {bins === 0 ? (
          <Typography variant="body2" color="text.secondary">
            None of these DAGs had a successful run in the range, so there are no durations to compare. Pick a
            longer range.
          </Typography>
        ) : asTable ? (
          <TableContainer>
            <Table size="small" aria-label="Successful runs per duration bin">
              <TableHead>
                <TableRow>
                  <TableCell>Duration</TableCell>
                  {dags.map((s) => (
                    <DagHeader key={`${s.dag.env_id}:${s.dag.dag_id}`} s={s} />
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {Array.from({ length: bins }, (_, i) => (
                  <TableRow key={i}>
                    <RowHeader>{binLabel(i)}</RowHeader>
                    {dags.map((s, k) => (
                      <TableCell key={`${s.dag.env_id}:${s.dag.dag_id}`} align="right">
                        {`${formatInt(s.dag.duration_histogram[i] ?? 0)} (${formatShare(shareOf(k, i))})`}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <LineChart
            count={bins}
            lines={lines}
            tick={(i) => formatDuration(edges[i] ?? 0)}
            title={(i) => `Runs taking ${binLabel(i)}`}
            format={formatShare}
            label={description}
          />
        )}
        <Typography variant="caption" color="text.secondary">
          {medians}. Bins are log-spaced and shared by every DAG; each line is the share of its own successful
          runs.
        </Typography>
        {footer(data, 'successful runs only')}
      </Stack>
    </Panel>
  );
}

const hourText = (h: number) =>
  `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00 UTC`;

export function HourlyPanel({ data, dags }: { data: DagComparison; dags: readonly Styled[] }) {
  const time = useTimeFormat();
  const [asTable, toggle] = useTableView('hourly');
  const [metric, setMetric] = usePageParam('profile', 'running');
  const share = metric === 'share';
  const value = (d: CompareDag, h: number) => {
    const entry = d.hourly_profile.find((x) => x.hour === h);
    if (!entry || entry.covered_hours <= 0) return null;
    return share ? entry.share : entry.running_avg;
  };
  const lines: Line[] = dags.map((s) => ({
    key: `${s.dag.env_id}:${s.dag.dag_id}`,
    label: `${s.style.letter} ${s.dag.dag_id} (${s.dag.env_id})`,
    values: Array.from({ length: 24 }, (_, h) => value(s.dag, h)),
    color: s.style.color,
    dash: s.style.dash,
    marker: s.style.marker,
  }));
  const peaks = dags
    .map((s) => {
      let best: { h: number; v: number } | null = null;
      for (let h = 0; h < 24; h++) {
        const v = value(s.dag, h);
        if (v !== null && (best === null || v > best.v)) best = { h, v };
      }
      return `${s.style.letter} peaks at ${best === null ? '—' : `${String(best.h).padStart(2, '0')}:00 UTC`}`;
    })
    .join(', ');
  const format = share ? formatShare : (v: number) => `${oneDecimal.format(v)} tasks`;
  const zone = data.time_zone;
  return (
    <Panel
      explanation={E['cmp-hourly']}
      actions={
        <Stack direction="row" sx={{ gap: 2, alignItems: 'center' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={share ? 'share' : 'running'}
            aria-label="Hourly measure"
            onChange={(_e, next: string | null) => next && setMetric(next)}
          >
            <ToggleButton value="running">Running tasks</ToggleButton>
            <ToggleButton value="share">Share of its environment</ToggleButton>
          </ToggleButtonGroup>
          {toggle}
        </Stack>
      }
    >
      <Stack spacing={2}>
        <Typography variant="body2">
          Hours of the day in {zone} for every environment: DCAM does not collect the environments’ or the
          DAGs’ time zones, so it compares them all in {zone}.
          {time.zone === 'local' ? ` The context bar shows local time; this profile stays in ${zone}.` : ''}
        </Typography>
        {asTable ? (
          <TableContainer sx={{ maxHeight: 480 }}>
            <Table
              size="small"
              stickyHeader
              aria-label={
                share ? `Share of the environment per ${zone} hour` : `Mean running tasks per ${zone} hour`
              }
            >
              <TableHead>
                <TableRow>
                  <TableCell>Hour ({zone})</TableCell>
                  {dags.map((s) => (
                    <DagHeader key={`${s.dag.env_id}:${s.dag.dag_id}`} s={s} />
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {Array.from({ length: 24 }, (_, h) => (
                  <TableRow key={h}>
                    <RowHeader>{hourText(h)}</RowHeader>
                    {dags.map((s) => {
                      const entry = s.dag.hourly_profile.find((x) => x.hour === h);
                      const covered = entry !== undefined && entry.covered_hours > 0;
                      return (
                        <TableCell
                          key={`${s.dag.env_id}:${s.dag.dag_id}`}
                          align="right"
                          title={
                            covered
                              ? `Mean over ${oneDecimal.format(entry.covered_hours)} h of history at this hour`
                              : 'No history for this hour'
                          }
                        >
                          {!covered || entry.running_avg === null
                            ? '—'
                            : `${oneDecimal.format(entry.running_avg)} (${formatShare(entry.share)})`}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <LineChart
            count={24}
            lines={lines}
            tick={(h) => String(h).padStart(2, '0')}
            title={hourText}
            format={format}
            label={`Hourly load profile, ${share ? "share of each DAG's environment" : 'mean running tasks'} per ${zone} hour of the day: ${peaks}.`}
          />
        )}
        {footer(data, `hours of the day in ${zone}, over the hours with task history in the range`)}
      </Stack>
    </Panel>
  );
}

function ShareBar({ share, style }: { share: number | null; style: SeriesStyle }) {
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1, justifyContent: 'flex-end' }}>
      <Box aria-hidden sx={{ width: 80, height: 8, bgcolor: 'divider', borderRadius: '2px' }}>
        {share !== null && (
          <Box
            sx={{
              width: `${Math.min(1, share) * 100}%`,
              height: '100%',
              bgcolor: style.color,
              borderRadius: '2px',
            }}
          />
        )}
      </Box>
      <span>{formatShare(share)}</span>
    </Stack>
  );
}

export function ResourcePanel({ data, dags }: { data: DagComparison; dags: readonly Styled[] }) {
  return (
    <Panel explanation={E['cmp-resources']}>
      <Stack spacing={2}>
        <TableContainer>
          <Table size="small" aria-label="Resource shares">
            <TableHead>
              <TableRow>
                <TableCell>DAG</TableCell>
                <TableCell>Environment</TableCell>
                <TableCell align="right">Executor slot-hours</TableCell>
                <TableCell align="right">Share of its environment</TableCell>
                <TableCell>Pools (slot-hours, share of the pool)</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {dags.map((s) => (
                <TableRow key={`${s.dag.env_id}:${s.dag.dag_id}`}>
                  <TableCell>
                    <Swatch style={s.style} />
                    {s.style.letter}{' '}
                    <Link href={s.href} sx={{ fontFamily: MONO }}>
                      {s.dag.dag_id}
                    </Link>
                  </TableCell>
                  <TableCell>{s.dag.env_id}</TableCell>
                  <TableCell align="right">
                    {formatSlotHours(s.dag.resources.executor_slot_seconds)}
                  </TableCell>
                  <TableCell
                    align="right"
                    title={s.dag.resources.share === null ? 'Nothing ran in its environment' : undefined}
                  >
                    <ShareBar share={s.dag.resources.share} style={s.style} />
                  </TableCell>
                  <TableCell>
                    {s.dag.resources.pools.length === 0
                      ? '—'
                      : s.dag.resources.pools
                          .map(
                            (p) =>
                              `${p.pool} ${formatSlotHours(p.pool_slot_seconds)} slot-hours (${formatShare(p.share)})`,
                          )
                          .join(', ')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        {footer(
          data,
          'executor slot-seconds (HM-003) and pool slot-seconds, against each DAG’s own environment',
        )}
      </Stack>
    </Panel>
  );
}

export function CapacityPanel({ data, dags }: { data: DagComparison; dags: readonly Styled[] }) {
  const time = useTimeFormat();
  const known = (v: number | null) => (v === null ? NOT_KNOWN : formatInt(v));
  const letters = (e: CompareEnvironment) =>
    dags
      .filter((s) => s.dag.env_id === e.env_id)
      .map((s) => s.style.letter)
      .join(', ');
  const rows: ReadonlyArray<readonly [string, (e: CompareEnvironment) => ReactNode]> = [
    ['DAGs compared', letters],
    ['Tier', (e) => e.tier],
    ['Airflow version', (e) => e.airflow_version],
    ['Workers', (e) => `${formatInt(e.min_workers)} to ${formatInt(e.max_workers)}`],
    ['worker_concurrency', (e) => known(e.worker_concurrency)],
    ['Worker slots (maximum)', (e) => known(e.worker_slots)],
    ['parallelism × schedulers', (e) => known(e.parallelism)],
    ['Default max_active_tasks_per_dag', (e) => known(e.max_active_tasks_per_dag)],
    [
      'Pools',
      (e) => (e.pools.length === 0 ? '—' : e.pools.map((p) => `${p.name} ${formatInt(p.slots)}`).join(', ')),
    ],
    ['Executor slot-hours in the range', (e) => formatSlotHours(e.executor_slot_seconds)],
    ['Utilisation of the maximum slots', (e) => formatShare(e.utilisation)],
    [
      'Task history',
      (e) =>
        e.history_from === null
          ? 'None collected yet'
          : `${formatShare(e.coverage)} of the range, since ${time.dateTime(e.history_from)}`,
    ],
  ];
  return (
    <Panel explanation={E['cmp-capacity']}>
      <Stack spacing={2}>
        <TableContainer>
          <Table size="small" aria-label="Capacity context">
            <TableHead>
              <TableRow>
                <TableCell>Environment</TableCell>
                {data.environments.map((e) => (
                  <TableCell key={e.env_id} align="right" sx={{ fontFamily: MONO }}>
                    {e.env_id}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(([label, value]) => (
                <TableRow key={label}>
                  <RowHeader>{label}</RowHeader>
                  {data.environments.map((e) => (
                    <TableCell key={e.env_id} align="right">
                      {value(e)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        {footer(
          data,
          'utilisation = executor slot-seconds ÷ (maximum worker slots × covered time), a lower bound while workers autoscale',
        )}
      </Stack>
    </Panel>
  );
}
