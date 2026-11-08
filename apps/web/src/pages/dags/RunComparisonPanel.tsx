/**
 * Compare two runs of the DAG (FR-DAGD-09, S-13 run comparison): the run shown in the Gantt chart (B)
 * against another run (A, by default the latest successful run before it; `vs` in the URL). Per task, the
 * change in duration and queue wait, ranked by its contribution to the change in run duration, as the
 * server ranks them: the change in its time on the critical path (HM-007/timing, an estimate). With a run
 * still in progress there is no path, and the panel says that tasks rank by their duration change instead.
 * The task table exports the rows it shows, the first 25 or all of them (FR-STORE-04).
 *
 * @implements FR-DAGD-09, HM-007, HM-001, FR-UI-02, FR-UI-05, FR-UI-07, FR-UI-08, FR-STORE-04
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
import { useTheme } from '@mui/material/styles';
import type { DagDetail, RunComparison, TaskInRun } from '@dcam/contracts';
import { InfoPopover, tokens } from '@dcam/ui-kit';
import type { DcamApi } from '../../api';
import type { CsvColumn, CsvValue } from '../../components/csv';
import { ExportCsvButton } from '../../components/ExportCsv';
import { clause, formatDuration, formatInt } from '../../components/format';
import { Panel, ProvenanceFooter } from '../../components/Panel';
import { loadingText } from '../../components/range';
import { usePageParam, useRefresh, useTimeFormat, useView } from '../../components/view';
import { COMPARE_EXPLANATIONS as E, type CompareExplanationId } from './compare-explanations';
import { STATE_LABEL } from './RunsTimeline';

type Run = DagDetail['runs'][number];
type TaskRow = RunComparison['tasks'][number];

const MONO = '"Roboto Mono", ui-monospace, monospace';
/** Rows shown before "Show all tasks". */
const FIRST_ROWS = 25;
const TASK_TABLE = 'Tasks by contribution to the duration difference';

/** `+10m`, `−1m`, `0s`. */
export const signed = (seconds: number | null) =>
  seconds === null
    ? '—'
    : Math.round(seconds) === 0
      ? '0s'
      : `${seconds < 0 ? '−' : '+'}${formatDuration(Math.abs(seconds))}`;

/**
 * The run compared with `b` by default: the latest successful run before it, else the latest successful
 * other run, else the run before it, else any other run. `runs` are in start order.
 */
export function defaultReference(runs: readonly Run[], b: string): string | null {
  const at = runs.findIndex((r) => r.run_id === b);
  const before = at === -1 ? runs : runs.slice(0, at);
  const others = runs.filter((r) => r.run_id !== b);
  const success = (list: readonly Run[]) => [...list].reverse().find((r) => r.state === 'success');
  return (success(before) ?? success(others) ?? before.at(-1) ?? others.at(-1))?.run_id ?? null;
}

function mapNote(t: TaskInRun | null, run: 'A' | 'B'): string | null {
  if (!t) return null;
  const parts: string[] = [];
  if (t.map_indexes > 1)
    parts.push(
      `longest of ${formatInt(t.map_indexes)} map indexes${t.map_index === null ? '' : ` (index ${t.map_index})`}`,
    );
  if (t.tries > 1) parts.push(`${formatInt(t.tries)} tries`);
  return parts.length ? `${run}: ${parts.join(', ')}` : null;
}

function Pair({
  a,
  b,
  pick,
  notes,
}: {
  a: TaskInRun | null;
  b: TaskInRun | null;
  pick: (t: TaskInRun) => number | null;
  notes?: readonly (string | null)[];
}) {
  const value = (t: TaskInRun | null) => (t ? formatDuration(pick(t)) : '—');
  const missing = !a ? 'Not in run A' : !b ? 'Not in run B' : null;
  const lines = [missing, ...(notes ?? [])].filter((x): x is string => x !== null);
  return (
    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
      {`${value(a)} → ${value(b)}`}
      {lines.map((line) => (
        <Typography key={line} variant="caption" color="text.secondary" component="div">
          {line}
        </Typography>
      ))}
    </TableCell>
  );
}

function ContributionBar({ t, max }: { t: TaskRow; max: number }) {
  const theme = useTheme();
  const k = tokens[theme.palette.mode];
  const c = t.contribution_seconds;
  const width = c === null || max <= 0 ? 0 : (Math.abs(c) / max) * 50;
  const split =
    c === null
      ? 'No critical path: a run is in progress'
      : `Queue wait ${signed(t.contribution_wait_seconds)}, running ${signed(t.contribution_running_seconds)}`;
  return (
    <TableCell align="right" title={split} sx={{ whiteSpace: 'nowrap', minWidth: 160 }}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, justifyContent: 'flex-end' }}>
        <Box aria-hidden sx={{ position: 'relative', width: 80, height: 10 }}>
          <Box
            sx={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: '1px', bgcolor: 'divider' }}
          />
          {width > 0 && c !== null && (
            <Box
              sx={{
                position: 'absolute',
                top: 1,
                bottom: 1,
                width: `${width}%`,
                ...(c > 0 ? { left: '50%' } : { right: '50%' }),
                bgcolor: c > 0 ? k.statusError : k.statusOk,
              }}
            />
          )}
        </Box>
        <span>{signed(c)}</span>
      </Stack>
    </TableCell>
  );
}

const yesNo = (t: TaskInRun | null) => (t ? (t.on_critical_path ? 'Yes' : 'No') : '—');

interface RankedTask {
  readonly rank: number;
  readonly task: TaskRow;
}

/** A value of the task in run A and in run B; a task not in that run has an empty cell, never 0. */
const bothRuns = (name: string, get: (t: TaskInRun) => CsvValue): CsvColumn<RankedTask>[] =>
  (['a', 'b'] as const).map((side) => ({
    name: name.replace('{run}', side),
    value: (x: RankedTask) => {
      const t = x.task[side];
      return t ? get(t) : null;
    },
  }));

/**
 * The task table as CSV, in its row and column order, unrounded: the durations and waits in both runs, the
 * changes and the contribution with its split, then what the captions say (map indexes, tries) and the runs.
 */
const taskCsv = (c: RunComparison): readonly CsvColumn<RankedTask>[] => [
  { name: 'rank', value: (x) => x.rank },
  { name: 'task_id', value: (x) => x.task.task_id },
  ...bothRuns('duration_{run}_seconds', (t) => t.duration_seconds),
  { name: 'duration_delta_seconds', value: (x) => x.task.duration_delta_seconds },
  ...bothRuns('queue_wait_{run}_seconds', (t) => t.queue_wait_seconds),
  { name: 'queue_wait_delta_seconds', value: (x) => x.task.queue_wait_delta_seconds },
  { name: 'contribution_seconds', value: (x) => x.task.contribution_seconds },
  { name: 'contribution_wait_seconds', value: (x) => x.task.contribution_wait_seconds },
  { name: 'contribution_running_seconds', value: (x) => x.task.contribution_running_seconds },
  ...bothRuns('on_critical_path_{run}', (t) => t.on_critical_path),
  ...bothRuns('map_indexes_{run}', (t) => t.map_indexes),
  ...bothRuns('tries_{run}', (t) => t.tries),
  { name: 'run_id_a', value: () => c.a.run_id },
  { name: 'run_id_b', value: () => c.b.run_id },
  { name: 'method', value: () => c.method },
];

const COLUMNS: ReadonlyArray<{ id: CompareExplanationId | null; label: string; numeric: boolean }> = [
  { id: null, label: '#', numeric: true },
  { id: 'dagd-rc-col-task', label: 'Task', numeric: false },
  { id: 'dagd-rc-col-duration', label: 'Duration A → B', numeric: true },
  { id: null, label: 'Change', numeric: true },
  { id: 'dagd-rc-col-queue', label: 'Queue wait A → B', numeric: true },
  { id: null, label: 'Change', numeric: true },
  { id: 'dagd-rc-col-contribution', label: 'Contribution', numeric: true },
  { id: 'dagd-rc-col-path', label: 'Critical path A / B', numeric: false },
];

function TaskTable({ c }: { c: RunComparison }) {
  const [all, setAll] = useState(false);
  const rows = all ? c.tasks : c.tasks.slice(0, FIRST_ROWS);
  const max = c.tasks.reduce((m, t) => Math.max(m, Math.abs(t.contribution_seconds ?? 0)), 0);
  return (
    <Stack spacing={1}>
      <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
        <ExportCsvButton
          view="run-comparison"
          what={TASK_TABLE}
          rows={rows.map((task, i) => ({ rank: i + 1, task }))}
          columns={taskCsv(c)}
        />
      </Stack>
      <TableContainer sx={{ maxHeight: 560 }}>
        <Table size="small" stickyHeader aria-label={TASK_TABLE}>
          <TableHead>
            <TableRow>
              {COLUMNS.map((col, i) => (
                <TableCell key={i} align={col.numeric ? 'right' : 'left'} sx={{ whiteSpace: 'nowrap' }}>
                  {col.label}
                  {col.id && <InfoPopover explanation={E[col.id]} />}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((t, i) => (
              <TableRow key={t.task_id} hover>
                <TableCell align="right">{i + 1}</TableCell>
                <TableCell sx={{ fontFamily: MONO }}>{t.task_id}</TableCell>
                <Pair
                  a={t.a}
                  b={t.b}
                  pick={(x) => x.duration_seconds}
                  notes={[mapNote(t.a, 'A'), mapNote(t.b, 'B')]}
                />
                <TableCell align="right">{signed(t.duration_delta_seconds)}</TableCell>
                <Pair a={t.a} b={t.b} pick={(x) => x.queue_wait_seconds} />
                <TableCell align="right">{signed(t.queue_wait_delta_seconds)}</TableCell>
                <ContributionBar t={t} max={max} />
                <TableCell>{`${yesNo(t.a)} / ${yesNo(t.b)}`}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {c.tasks.length > FIRST_ROWS && (
        <Button size="small" onClick={() => setAll((v) => !v)} sx={{ alignSelf: 'flex-start' }}>
          {all ? `Show the first ${FIRST_ROWS} tasks` : `Show all ${formatInt(c.tasks.length)} tasks`}
        </Button>
      )}
    </Stack>
  );
}

function Summary({ c }: { c: RunComparison }) {
  if (c.ranking === 'duration_delta') {
    const running = c.b.state === 'running' ? 'B' : 'A';
    return (
      <Typography variant="body2">
        {running} is still running, so it has no critical path yet: tasks are ranked by the change in their
        duration instead. Contributions appear when both runs have finished.
      </Typography>
    );
  }
  const delta = c.duration_delta_seconds;
  const durations = `(${formatDuration(c.a.duration_seconds)} against ${formatDuration(c.b.duration_seconds)})`;
  const headline =
    delta === null
      ? 'DCAM cannot tell how much longer one run took.'
      : Math.round(delta) === 0
        ? `B took as long as A ${durations}.`
        : `B took ${formatDuration(Math.abs(delta))} ${delta > 0 ? 'longer' : 'less'} than A ${durations}.`;
  const explained = c.explained_seconds;
  const partial =
    explained !== null && delta !== null && Math.abs(explained - delta) >= 1
      ? ` of the ${signed(delta)}: a skipped task ended one of the runs, so its critical path ends earlier`
      : '';
  return (
    <Typography variant="body2">
      {headline} Tasks are ranked by their contribution: the change in their time on the critical path (
      {c.method}, an estimate from timing); together they explain {signed(explained)}
      {partial}.
    </Typography>
  );
}

export function RunComparisonPanel({
  detail,
  api,
  envId,
}: {
  detail: DagDetail;
  api: DcamApi;
  envId: string;
}) {
  const { range } = useView();
  const time = useTimeFormat();
  const [vs, setVs] = usePageParam('vs');
  const b = detail.gantt.run_id;
  const others = detail.runs.filter((r) => r.run_id !== b);
  const a = b === null ? null : others.some((r) => r.run_id === vs) ? vs : defaultReference(detail.runs, b);
  const compared = useQuery({
    queryKey: ['run-compare', envId, detail.dag_id, range, a, b],
    queryFn: () => api.getRunComparison(envId, detail.dag_id, a ?? '', b ?? '', range),
    enabled: a !== null && b !== null,
    ...useRefresh(),
  });
  const runB = detail.runs.find((r) => r.run_id === b);
  const label = (r: Run) =>
    `${time.dateTime(r.start)} · ${STATE_LABEL[r.state]}${r.duration_seconds === null ? '' : ` · ${formatDuration(r.duration_seconds)}`}`;
  const c = compared.data;

  return (
    <Panel explanation={E['dagd-run-compare']}>
      {b === null || detail.runs.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No run of this DAG started in the range. Pick a longer range to compare two runs.
        </Typography>
      ) : others.length === 0 || a === null ? (
        <Typography variant="body2" color="text.secondary">
          Only one run of this DAG in the range. Pick a longer range to compare two runs.
        </Typography>
      ) : (
        <Stack spacing={2}>
          <Stack direction="row" sx={{ gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
            <Typography variant="body2">B: {runB ? label(runB) : b}, the run in the Gantt chart</Typography>
            <TextField
              select
              size="small"
              label="Compared with (A)"
              value={a}
              onChange={(e) => setVs(e.target.value)}
              sx={{ minWidth: 300 }}
            >
              {[...others].reverse().map((r) => (
                <MenuItem key={r.run_id} value={r.run_id}>
                  {label(r)}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          {compared.error && (
            <Alert severity="error">
              Couldn't compare these runs: {clause(compared.error.message)}. Pick another run to compare with,
              or a longer range.
            </Alert>
          )}
          {compared.isPending && (
            <Skeleton variant="rounded" height={160} aria-label={loadingText('the run comparison', range)} />
          )}
          {c && (
            <>
              <Summary c={c} />
              {c.tasks.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No task ran in either run, so there is nothing to compare. Pick other runs.
                </Typography>
              ) : (
                <TaskTable c={c} />
              )}
              <ProvenanceFooter
                as="p"
                dataAsOf={c.data_as_of}
                sources={c.sources}
                note={`method ${c.method}: critical path estimated from timing; mapped tasks collapse to their longest map index; retries add`}
              />
            </>
          )}
        </Stack>
      )}
    </Panel>
  );
}
