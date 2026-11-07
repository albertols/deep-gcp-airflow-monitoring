/**
 * Duration against baseline (FR-TASK-01, HM-016): the DAG's run duration and each task's duration
 * distribution in the range, over the band of the 28 days before it, with the regression verdict in words.
 * Partial and missing baselines say so; a server without these fields says the panel is not available.
 *
 * @implements FR-TASK-01, HM-016, FR-DAGD-04 (baseline delta), FR-UI-05, FR-UI-07, FR-UI-08
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import HelpOutlineOutlined from '@mui/icons-material/HelpOutlineOutlined';
import TrendingUpOutlined from '@mui/icons-material/TrendingUpOutlined';
import { useTheme } from '@mui/material/styles';
import type { DagDetail, DurationDistribution, DurationRegression } from '@dcam/contracts';
import { InfoPopover, tokens } from '@dcam/ui-kit';
import type { DcamApi } from '../../api';
import { HistoryNote } from '../../components/backfill';
import { Panel, ProvenanceFooter } from '../../components/Panel';
import { formatDuration, formatInt } from '../../components/format';
import { DEPTH_EXPLANATIONS as E, type DepthExplanationId } from './depth-explanations';
import { TaskHistoryFreshness } from './TaskHistoryFreshness';
import { formatUtc } from './time';

const MONO = '"Roboto Mono", ui-monospace, monospace';
const BASELINE_DAYS = 28;
const days = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

type Status = DurationRegression['status'];

const STATUS: Readonly<Record<Status, { label: string; rank: number }>> = {
  regression: { label: 'Regression', rank: 0 },
  within_baseline: { label: 'Within baseline', rank: 1 },
  low_sample: { label: 'Too few runs', rank: 2 },
  no_baseline: { label: 'No baseline yet', rank: 3 },
};

export const formatRatio = (ratio: number | null) => (ratio === null ? '—' : `×${ratio.toFixed(1)}`);

function StatusLabel({ status }: { status: Status }) {
  const Icon =
    status === 'regression'
      ? TrendingUpOutlined
      : status === 'within_baseline'
        ? CheckCircleOutlined
        : HelpOutlineOutlined;
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <Icon fontSize="small" color={status === 'regression' ? 'error' : 'inherit'} aria-hidden="true" />
      <span>{STATUS[status].label}</span>
    </Stack>
  );
}

const describe = (d: DurationDistribution, what: string) =>
  d.samples === 0
    ? `${what}: no successful tries`
    : `${what}: median ${formatDuration(d.p50)}, p95 ${d.low_sample ? '≤ ' : ''}${formatDuration(d.p95)} from ${formatInt(d.samples)} tries`;

const W = 180;
const H = 22;

/** One row's distribution now (box, median, whisker to p95) over the baseline band (p25–p75, dashed p95). */
function BoxAgainstBand({ v }: { v: DurationRegression }) {
  const theme = useTheme();
  const t = tokens[theme.palette.mode];
  const { current: c, baseline: b } = v;
  const values = [c.p75, c.p95, b.p75, b.p95].filter((x): x is number => x !== null);
  const label = `${describe(c, 'Now')}. ${describe(b, 'Baseline')}.`;
  if (values.length === 0 || c.samples === 0) return <span title={label}>—</span>;
  const top = Math.max(...values, 1) * 1.15;
  const x = (s: number | null) => 4 + ((s ?? 0) / top) * (W - 8);
  const stroke = v.status === 'regression' ? t.statusError : t.accentPrimary;
  return (
    <svg
      role="img"
      aria-label={label}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: 'block' }}
    >
      <title>{label}</title>
      {b.samples > 0 && (
        <>
          <rect
            x={x(b.p25)}
            y={2}
            width={Math.max(1, x(b.p75) - x(b.p25))}
            height={H - 4}
            fill={t.borderSubtle}
            opacity={0.8}
          />
          <line
            x1={x(b.p95)}
            x2={x(b.p95)}
            y1={1}
            y2={H - 1}
            stroke={t.textSecondary}
            strokeDasharray="3 2"
          />
        </>
      )}
      <line x1={x(c.min ?? c.p25)} x2={x(c.p95)} y1={H / 2} y2={H / 2} stroke={stroke} />
      <rect
        x={x(c.p25)}
        y={6}
        width={Math.max(1, x(c.p75) - x(c.p25))}
        height={H - 12}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
      />
      <line x1={x(c.p50)} x2={x(c.p50)} y1={5} y2={H - 5} stroke={stroke} strokeWidth={2} />
    </svg>
  );
}

/** The DAG's run duration verdict as one sentence (observation, then what it means). */
function runSentence(v: DurationRegression): string {
  const now = `p95 ${v.current.low_sample ? '≤ ' : ''}${formatDuration(v.current.p95)} now`;
  const before = `${formatDuration(v.baseline.p95)} in the baseline`;
  const counts = `${formatInt(v.current.samples)} successful runs now, ${formatInt(v.baseline.samples)} in the baseline`;
  switch (v.status) {
    case 'regression':
      return `Runs are slower than their baseline: ${now} against ${before} (${formatRatio(v.ratio)}, ${counts}). Look at the tasks marked as a regression below.`;
    case 'within_baseline':
      return `Runs are within their baseline: ${now} against ${before} (${formatRatio(v.ratio)}, ${counts}).`;
    case 'low_sample':
      return `Too few successful runs in this range to compare with the baseline (${formatInt(v.current.samples)}; at least 10 needed). Pick a longer range.`;
    case 'no_baseline':
      return `Baseline not available yet: ${formatInt(v.baseline.samples)} successful runs in the 28 days before this range, and a p95 needs 20.`;
  }
}

function BaselineNote({ baseline }: { baseline: NonNullable<DagDetail['baseline']> }) {
  if (baseline.coverage <= 0)
    return (
      <Alert severity="info" variant="outlined" sx={{ py: 0 }}>
        Baseline not available yet: DCAM has no task history before this range. It builds up as DCAM collects;
        when DCAM adds an environment, it reads the last 7 days.
      </Alert>
    );
  if (baseline.coverage >= 1)
    return (
      <Typography variant="caption" color="text.secondary">
        Baseline: {formatUtc(baseline.from)} to {formatUtc(baseline.to)}, the 28 days before this range.
      </Typography>
    );
  return (
    <Typography variant="caption" color="text.secondary">
      Partial baseline: DCAM has history for {days.format(baseline.coverage * BASELINE_DAYS)} of its 28 days
      {baseline.history_from ? ` (since ${formatUtc(baseline.history_from)})` : ''}. Verdicts compare with
      that part only.
    </Typography>
  );
}

const COLUMNS: ReadonlyArray<{ id: DepthExplanationId; numeric: boolean }> = [
  { id: 'dagd-dur-col-task', numeric: false },
  { id: 'dagd-dur-col-distribution', numeric: false },
  { id: 'dagd-dur-col-p50', numeric: true },
  { id: 'dagd-dur-col-p95', numeric: true },
  { id: 'dagd-dur-col-baseline', numeric: true },
  { id: 'dagd-dur-col-change', numeric: true },
  { id: 'dagd-dur-col-verdict', numeric: false },
];

type TaskRow = DagDetail['tasks'][number] & { duration_regression: DurationRegression };

/** Regressions first (largest change first), then within baseline, then the ones DCAM cannot judge. */
function ordered(tasks: DagDetail['tasks']): TaskRow[] {
  return tasks
    .filter((t): t is TaskRow => t.duration_regression !== undefined)
    .sort(
      (a, b) =>
        STATUS[a.duration_regression.status].rank - STATUS[b.duration_regression.status].rank ||
        (b.duration_regression.ratio ?? 0) - (a.duration_regression.ratio ?? 0) ||
        a.task_id.localeCompare(b.task_id),
    );
}

const p95 = (d: DurationDistribution) =>
  d.p95 === null ? '—' : `${d.low_sample ? '≤ ' : ''}${formatDuration(d.p95)}`;

function TaskTable({ rows }: { rows: readonly TaskRow[] }) {
  return (
    <TableContainer sx={{ maxHeight: 480 }}>
      <Table size="small" stickyHeader aria-label="Task durations against baseline">
        <TableHead>
          <TableRow>
            {COLUMNS.map((c) => (
              <TableCell key={c.id} align={c.numeric ? 'right' : 'left'} sx={{ whiteSpace: 'nowrap' }}>
                {E[c.id].title}
                <InfoPopover explanation={E[c.id]} />
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(({ task_id, duration_regression: v }) => (
            <TableRow key={task_id} hover>
              <TableCell sx={{ fontFamily: MONO }}>{task_id}</TableCell>
              <TableCell>
                <BoxAgainstBand v={v} />
              </TableCell>
              <TableCell align="right">{formatDuration(v.current.p50)}</TableCell>
              <TableCell align="right" title={`${formatInt(v.current.samples)} successful tries`}>
                {p95(v.current)}
              </TableCell>
              <TableCell align="right" title={`${formatInt(v.baseline.samples)} successful tries`}>
                {p95(v.baseline)}
              </TableCell>
              <TableCell align="right">{formatRatio(v.ratio)}</TableCell>
              <TableCell>
                <StatusLabel status={v.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function DurationPanel({
  detail,
  api,
  envId,
  healthHref,
}: {
  detail: DagDetail;
  api: DcamApi;
  envId: string;
  healthHref: string;
}) {
  const { baseline, regression } = detail;
  const rows = ordered(detail.tasks);
  return (
    <Panel
      explanation={E['dagd-duration-baseline']}
      actions={<TaskHistoryFreshness api={api} envId={envId} />}
    >
      {baseline === undefined || regression === undefined ? (
        <Typography variant="body2" color="text.secondary">
          This DCAM server does not report this yet. Update DCAM to compare durations with their baseline.
        </Typography>
      ) : (
        <Stack spacing={2}>
          <BaselineNote baseline={baseline} />
          <HistoryNote
            api={api}
            envId={envId}
            rangeFrom={baseline.from}
            kinds={['task_instances']}
            healthHref={healthHref}
          />
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            <Box sx={{ pt: 0.25 }}>
              <StatusLabel status={regression.status} />
            </Box>
            <Typography variant="body2">{runSentence(regression)}</Typography>
          </Stack>
          {rows.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No task of this DAG ran in the range. Pick a longer range to compare durations.
            </Typography>
          ) : (
            <TaskTable rows={rows} />
          )}
          <ProvenanceFooter
            dataAsOf={detail.data_as_of}
            sources={detail.sources}
            note={`Successful tries only · range ${formatUtc(detail.range.from)} to ${formatUtc(detail.range.to)}`}
          />
        </Stack>
      )}
    </Panel>
  );
}
