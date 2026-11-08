/**
 * One DAG in detail (spec §12.4 S-12): header with every limit that can throttle it, KPIs, a runs
 * timeline, the Gantt chart of one run with its critical path, per-task statistics, durations against
 * their baseline, and failures, retries and flakiness. The range comes from the context bar; the run shown
 * in the Gantt chart is in the URL (`run`), so a shared link opens the same run. "Open in" opens the DAG and
 * that run in the Airflow UI and the Cloud console, and each task row opens the task in that run. Every table
 * exports the rows it shows, in files named after the DAG (FR-STORE-04).
 *
 * @implements FR-DAGD-01, FR-DAGD-02, FR-DAGD-03, FR-DAGD-04, FR-TASK-01, HM-005, HM-007, HM-015, HM-016,
 *   FR-UI-01, FR-UI-02, FR-UI-04, FR-UI-05, FR-UI-07, FR-UI-08, FR-STORE-04
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { DagDetail } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import type { RunRef } from '../../components/deep-links';
import { triesWindow } from '../../components/open-in-links';
import { OpenInMenu } from '../../components/OpenInMenu';
import { quantileColumns, type CsvColumn } from '../../components/csv';
import { ExportCsvButton, ExportScope } from '../../components/ExportCsv';
import { PageHeader } from '../../components/PageHeader';
import { EXPLANATIONS } from '../../explanations';
import { Kpi, KpiRow, Panel, ProvenanceFooter } from '../../components/Panel';
import {
  clause,
  describeQuantile,
  formatDuration,
  formatSchedule,
  formatInt,
  formatQuantile,
  formatShare,
  formatSlotHours,
} from '../../components/format';
import { RANGE_PRESETS, loadingText } from '../../components/range';
import { usePageParam, useRefresh, useView } from '../../components/view';
import type { PageProps } from '../types';
import { ConcurrencyPanel } from './ConcurrencyPanel';
import { CriticalPathSummary } from './CriticalPathSummary';
import { DagFindingsPanel } from './DagFindingsPanel';
import { DurationPanel } from './DurationPanel';
import { DAG_EXPLANATIONS as E, type DagExplanationId } from './explanations';
import { ImpactPanel } from './ImpactPanel';
import { ReliabilityPanel } from './ReliabilityPanel';
import { RunComparisonPanel } from './RunComparisonPanel';
import { RunGantt } from './RunGantt';
import { RunsTimeline, STATE_LABEL } from './RunsTimeline';

const MONO = '"Roboto Mono", ui-monospace, monospace';

function Facts({ meta }: { meta: DagDetail['meta'] }) {
  const schedule = formatSchedule(meta.schedule);
  const facts: ReadonlyArray<readonly [string, ReactNode]> = [
    [
      'File',
      <Box component="code" sx={{ fontFamily: MONO, wordBreak: 'break-all' }}>
        {meta.fileloc}
      </Box>,
    ],
    [
      'Schedule',
      <>
        {schedule.code ? (
          <Box component="code" sx={{ fontFamily: MONO }} title={meta.schedule}>
            {schedule.text}
          </Box>
        ) : (
          <span title={meta.schedule}>{schedule.text}</span>
        )}
        {` · catchup ${meta.catchup ? 'on' : 'off'}`}
      </>,
    ],
    ['Team', meta.team],
    ['Owners', meta.owners.join(', ') || '—'],
    [
      'Tags',
      meta.tags.length === 0 ? (
        '—'
      ) : (
        <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
          {meta.tags.map((tag) => (
            <Chip key={tag} size="small" variant="outlined" label={tag} />
          ))}
        </Stack>
      ),
    ],
    ['State', meta.paused ? 'Paused: no new runs start' : 'Active'],
  ];
  return (
    <Box
      component="dl"
      sx={{
        display: 'grid',
        gridTemplateColumns: 'max-content 1fr',
        columnGap: 4,
        rowGap: 2,
        m: 0,
        minWidth: 0,
      }}
    >
      {facts.map(([term, value]) => (
        <Box key={term} sx={{ display: 'contents' }}>
          <Typography component="dt" variant="body2" color="text.secondary">
            {term}
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0, minWidth: 0 }}>
            {value}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

/** Shown for a limit with no override in the Composer configuration: DCAM does not assume a default (HM-032). */
const NOT_KNOWN = 'Not known yet';
const NOT_KNOWN_WHY = 'No override in the Composer configuration, and DCAM does not assume a default. ';

type DagLimits = DagDetail['meta']['limits'];

/** One limit that can throttle the DAG, as the table shows it and as its CSV row. */
interface LimitRow {
  readonly limit: string;
  /** Task instances, runs or slots; `null` when not known (HM-032) or the pool is not defined. */
  readonly value: number | null;
  /** For a pool: the slots each task of this DAG takes. */
  readonly slotsPerTask: number | null;
  readonly shown: string;
  readonly counts: string;
}

function limitRows(limits: DagLimits): LimitRow[] {
  const known = (value: number | null) => (value === null ? NOT_KNOWN : formatInt(value));
  const why = (value: number | null) => (value === null ? NOT_KNOWN_WHY : '');
  return [
    {
      limit: 'max_active_tasks',
      value: limits.max_active_tasks,
      slotsPerTask: null,
      shown: formatInt(limits.max_active_tasks),
      counts: 'Running + queued task instances of this DAG, all runs together',
    },
    {
      limit: 'max_active_runs',
      value: limits.max_active_runs,
      slotsPerTask: null,
      shown: formatInt(limits.max_active_runs),
      counts: 'Active runs of this DAG',
    },
    ...limits.pools.map((p) => ({
      limit: `Pool ${p.name}`,
      value: p.slots > 0 ? p.slots : null,
      slotsPerTask: p.pool_slots,
      shown:
        p.slots > 0
          ? `${formatInt(p.pool_slots)} of ${formatInt(p.slots)} slots per task`
          : 'Pool not defined',
      counts: 'Shared with every DAG that uses the pool',
    })),
    {
      limit: '[core] parallelism × schedulers',
      value: limits.parallelism,
      slotsPerTask: null,
      shown: known(limits.parallelism),
      counts: `${why(limits.parallelism)}Running + queued task instances in the environment`,
    },
    {
      limit: 'Worker slots',
      value: limits.worker_slots,
      slotsPerTask: null,
      shown: known(limits.worker_slots),
      counts: `${why(limits.worker_slots)}Maximum workers × worker_concurrency`,
    },
  ];
}

const LIMIT_CSV: readonly CsvColumn<LimitRow>[] = [
  { name: 'limit', value: (r) => r.limit },
  { name: 'value', value: (r) => r.value },
  { name: 'pool_slots_per_task', value: (r) => r.slotsPerTask },
  { name: 'counts', value: (r) => r.counts },
];

function Limits({ rows }: { rows: readonly LimitRow[] }) {
  return (
    <TableContainer sx={{ minWidth: 0 }}>
      <Table size="small" aria-label="Limits that can throttle this DAG">
        <TableHead>
          <TableRow>
            <TableCell>Limit</TableCell>
            <TableCell align="right">Value</TableCell>
            <TableCell>Counts</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.limit}>
              <TableCell sx={{ fontFamily: MONO }}>{r.limit}</TableCell>
              <TableCell align="right">{r.shown}</TableCell>
              <TableCell>
                <Typography variant="caption" color="text.secondary">
                  {r.counts}
                </Typography>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function Kpis({ stats }: { stats: DagDetail['stats'] }) {
  const throttled = stats.self_throttled_ratio;
  return (
    <KpiRow>
      <Kpi
        explanation={E['dagd-share']}
        value={formatShare(stats.share)}
        hint={`${formatSlotHours(stats.executor_slot_seconds)} slot-hours`}
      />
      <Kpi explanation={E['dagd-runs']} value={formatInt(stats.runs)} />
      <Kpi explanation={E['dagd-success']} value={formatShare(stats.success_rate)} />
      <Kpi
        explanation={E['dagd-duration']}
        value={formatQuantile(stats.run_duration_p95)}
        hint={describeQuantile(stats.run_duration_p95)}
      />
      <Kpi
        explanation={E['dagd-queue']}
        value={formatQuantile(stats.queue_wait_p95)}
        hint={describeQuantile(stats.queue_wait_p95)}
      />
      <Kpi
        explanation={E['dagd-self-throttled']}
        value={formatShare(throttled)}
        hint={
          throttled === null
            ? 'DCAM saw no work of this DAG in the range'
            : throttled >= 0.1
              ? 'Often held back by its own max_active_tasks'
              : 'Rarely held back by its own limits'
        }
      />
    </KpiRow>
  );
}

const TASK_COLUMNS: ReadonlyArray<{ id: DagExplanationId; numeric: boolean }> = [
  { id: 'dagd-col-task', numeric: false },
  { id: 'dagd-col-tries', numeric: true },
  { id: 'dagd-col-p50', numeric: true },
  { id: 'dagd-col-p95', numeric: true },
  { id: 'dagd-col-queue', numeric: true },
  { id: 'dagd-col-retries', numeric: true },
  { id: 'dagd-col-failure', numeric: true },
  { id: 'dagd-col-share', numeric: true },
  { id: 'dagd-col-contribution', numeric: true },
];

type Task = DagDetail['tasks'][number];

/** The tasks table as CSV: every statistic with its unit and sample count. */
const TASK_CSV: readonly CsvColumn<Task>[] = [
  { name: 'task_id', value: (t) => t.task_id },
  { name: 'tries', value: (t) => t.tries },
  ...quantileColumns<Task>('duration_p50', (t) => t.duration_p50),
  ...quantileColumns<Task>('duration_p95', (t) => t.duration_p95),
  ...quantileColumns<Task>('queue_wait_p95', (t) => t.queue_wait_p95),
  { name: 'retries', value: (t) => t.retries },
  { name: 'failure_rate_ratio', value: (t) => t.failure_rate },
  { name: 'slot_seconds_share_ratio', value: (t) => t.slot_seconds_share },
  { name: 'contribution_seconds', value: (t) => t.contribution_seconds },
  { name: 'critical_path_runs', value: (t) => t.critical_path_runs },
  { name: 'critical_path_share_ratio', value: (t) => t.critical_path_share },
];

/**
 * The run shown in the Gantt chart, as the "Open in" links select it; `null` without one. For a custom run
 * ID the server sends the run's first start as its logical date (`dags.ts`), so a logical date equal to the
 * start, to the millisecond, is that stand-in.
 */
function selectedRun(d: DagDetail): RunRef | null {
  const run = d.runs.find((r) => r.run_id === d.gantt.run_id);
  if (!run) return null;
  return {
    runId: run.run_id,
    logicalDate: run.logical_date,
    ...(run.logical_date === run.start ? { logicalDateEstimated: true } : {}),
  };
}

function Tasks({ detail }: { detail: DagDetail }) {
  const tasks = detail.tasks;
  const run = selectedRun(detail);
  // The Gantt rows per task, grouped once (a run can have hundreds of tries).
  const rowsByTask = new Map<string, DagDetail['gantt']['rows'][number][]>();
  for (const r of detail.gantt.rows) {
    const rows = rowsByTask.get(r.task_id);
    if (rows) rows.push(r);
    else rowsByTask.set(r.task_id, [r]);
  }
  if (tasks.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        No task of this DAG ran in the range. Pick a longer range to see task statistics.
      </Typography>
    );
  return (
    <TableContainer sx={{ maxHeight: 480 }}>
      <Table size="small" stickyHeader aria-label="Tasks">
        <TableHead>
          <TableRow>
            {TASK_COLUMNS.map((c) => (
              <TableCell key={c.id} align={c.numeric ? 'right' : 'left'} sx={{ whiteSpace: 'nowrap' }}>
                {E[c.id].title}
                <InfoPopover explanation={E[c.id]} />
              </TableCell>
            ))}
            <TableCell sx={{ whiteSpace: 'nowrap' }}>
              In the selected run
              <InfoPopover explanation={EXPLANATIONS['open-in']} />
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {tasks.map((task) => (
            <TableRow key={task.task_id} hover>
              <TableCell sx={{ fontFamily: MONO }}>{task.task_id}</TableCell>
              <TableCell align="right">{formatInt(task.tries)}</TableCell>
              <TableCell align="right" title={describeQuantile(task.duration_p50)}>
                {formatQuantile(task.duration_p50)}
              </TableCell>
              <TableCell align="right" title={describeQuantile(task.duration_p95)}>
                {formatQuantile(task.duration_p95)}
              </TableCell>
              <TableCell align="right" title={describeQuantile(task.queue_wait_p95)}>
                {formatQuantile(task.queue_wait_p95)}
              </TableCell>
              <TableCell align="right">{formatInt(task.retries)}</TableCell>
              <TableCell align="right">{formatShare(task.failure_rate)}</TableCell>
              <TableCell align="right">{formatShare(task.slot_seconds_share)}</TableCell>
              <TableCell align="right">{formatDuration(task.contribution_seconds)}</TableCell>
              <TableCell>
                <OpenInMenu
                  target={{
                    page: 'task',
                    dagId: detail.dag_id,
                    taskId: task.task_id,
                    run,
                    tries: triesWindow(rowsByTask.get(task.task_id) ?? [], detail.range.to),
                  }}
                  timeWindow={detail.range}
                  label={`Open in: ${task.task_id}`}
                  info={false}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function DagDetailPage({ api, envId, route, linkTo }: PageProps) {
  const dagId = route.page === 'dag' ? route.dagId : '';
  const { range, time } = useView();
  // The picked run is in the URL; the shell drops it when the range or environment changes, because a
  // run belongs to one range. Without one, the page shows the latest run.
  const [run, setRun] = usePageParam('run');
  const runId = run === '' ? undefined : run;
  const detail = useQuery({
    queryKey: ['dag-detail', envId, dagId, range, runId ?? null],
    queryFn: () => api.getDagDetail(envId, dagId, range, runId),
    // Keep the page while another run of the same DAG loads.
    placeholderData: (previous, query) =>
      query?.queryKey[1] === envId && query.queryKey[2] === dagId && query.queryKey[3] === range
        ? previous
        : undefined,
    ...useRefresh(),
  });
  const d = detail.data;
  const select = (id: string) => setRun(id);
  const rangeLabel = RANGE_PRESETS[range].label;
  const latestFirst = d ? [...d.runs].reverse() : [];

  return (
    <Stack spacing={4}>
      <Link href={linkTo({ page: 'dags' })} variant="body2" sx={{ alignSelf: 'flex-start' }}>
        ← DAG league table
      </Link>
      <PageHeader
        title={dagId}
        subtitle={d ? `Team ${d.meta.team} · ${rangeLabel.toLowerCase()}` : rangeLabel}
      >
        {d && (
          <OpenInMenu target={{ page: 'dag', dagId: d.dag_id, run: selectedRun(d) }} timeWindow={d.range} />
        )}
      </PageHeader>

      {detail.error && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" href={linkTo({ page: 'dags' })}>
              Open the league table
            </Button>
          }
        >
          Couldn't load this DAG: {clause(detail.error.message)}. Check the DAG ID, or pick a DAG from the
          league table.
        </Alert>
      )}
      {detail.isPending && (
        <Skeleton variant="rounded" height={240} aria-label={loadingText('the DAG', range)} />
      )}

      {d && (
        <ExportScope
          subject={`dag-${dagId}`}
          envId={d.env_id}
          range={range}
          asOf={d.data_as_of}
          rangeEnd={d.range.to}
        >
          <Button
            size="small"
            variant="outlined"
            href={linkTo({ page: 'compare-dags' }, { dags: `${envId}:${dagId}` })}
            sx={{ alignSelf: 'flex-start' }}
          >
            Compare with other DAGs
          </Button>

          <Panel
            explanation={E['dagd-limits']}
            actions={
              <ExportCsvButton
                view="limits"
                what="Limits that can throttle this DAG"
                rows={limitRows(d.meta.limits)}
                columns={LIMIT_CSV}
              />
            }
          >
            <Stack direction={{ xs: 'column', lg: 'row' }} sx={{ gap: 6, alignItems: { lg: 'flex-start' } }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Facts meta={d.meta} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Limits rows={limitRows(d.meta.limits)} />
              </Box>
            </Stack>
          </Panel>

          <Kpis stats={d.stats} />

          <DagFindingsPanel detail={d} linkTo={linkTo} />

          <Panel explanation={E['dagd-runs-timeline']}>
            <RunsTimeline runs={d.runs} range={d.range} selectedRunId={d.gantt.run_id} onSelect={select} />
          </Panel>

          <Panel
            explanation={E['dagd-gantt']}
            actions={
              latestFirst.length > 0 && (
                <TextField
                  select
                  size="small"
                  label="Run"
                  value={d.gantt.run_id ?? ''}
                  onChange={(e) => select(e.target.value)}
                  sx={{ minWidth: 260 }}
                >
                  {latestFirst.map((r) => (
                    <MenuItem key={r.run_id} value={r.run_id}>
                      {time.dateTime(r.start)} · {STATE_LABEL[r.state]}
                    </MenuItem>
                  ))}
                </TextField>
              )
            }
          >
            <RunGantt gantt={d.gantt} now={d.range.to} />
            <CriticalPathSummary detail={d} />
          </Panel>

          <RunComparisonPanel detail={d} api={api} envId={envId} />

          <Panel
            explanation={E['dagd-tasks']}
            actions={<ExportCsvButton view="tasks" what="Tasks" rows={d.tasks} columns={TASK_CSV} />}
          >
            <Tasks detail={d} />
          </Panel>

          <DurationPanel detail={d} api={api} envId={envId} healthHref={linkTo({ page: 'health' })} />

          <ReliabilityPanel detail={d} api={api} envId={envId} />

          <ConcurrencyPanel detail={d} api={api} envId={envId} linkTo={linkTo} />

          <ImpactPanel detail={d} api={api} envId={envId} linkTo={linkTo} />

          <ProvenanceFooter
            dataAsOf={d.data_as_of}
            sources={d.sources}
            note={`Range ${time.dateTime(d.range.from)} to ${time.dateTime(d.range.to)}`}
          />
        </ExportScope>
      )}
    </Stack>
  );
}
