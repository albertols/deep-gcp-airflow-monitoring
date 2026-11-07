/**
 * Runs timeline (FR-DAGD-02): one bar per run at its start time, its height the duration, its state
 * shown by colour and a mark. The bars form a radio group (arrow keys move) that picks the run shown
 * in the Gantt chart; a table view lists every run.
 *
 * Start delay (HM-002) is measured from the end of the data interval where DCAM can derive it; any
 * other basis is named next to the value.
 *
 * @implements FR-DAGD-02, HM-002
 */
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { DagDetail } from '@dcam/contracts';
import { tokens } from '@dcam/ui-kit';
import { formatDuration, formatInt } from '../../components/format';
import { formatClock, formatUtc } from './time';

type Run = DagDetail['runs'][number];

const W = 960;
const H = 220;
const M = { left: 60, right: 16, top: 18, bottom: 30 };
const STEPS = [60, 300, 600, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200, 86_400];

/** An axis maximum on a round duration, with at most four steps. */
function niceMax(seconds: number): { max: number; step: number } {
  const step = STEPS.find((s) => seconds / s <= 4) ?? Math.ceil(seconds / 4 / 86_400) * 86_400;
  return { max: Math.max(step, Math.ceil(seconds / step) * step), step };
}

/** HM-002: the start delay with what it is measured from, when that is not the data interval end. */
export function formatStartDelay(r: Pick<Run, 'start_delay_seconds' | 'start_delay_basis'>): string {
  if (r.start_delay_basis === 'not_scheduled') return 'Not a scheduled run';
  const value = formatDuration(r.start_delay_seconds);
  if (r.start_delay_seconds === null) return value;
  return r.start_delay_basis === 'logical_date' ? `${value} from logical date` : value;
}

/** Tooltip for the start delay: what it is measured from. */
export const START_DELAY_BASIS: Record<Run['start_delay_basis'], string> = {
  data_interval_end: 'First task start − the end of the data interval, from the DAG schedule.',
  trigger_time:
    'First task start − the logical date: the run started before its interval ended, so the timetable triggers at the logical date.',
  logical_date:
    'First task start − the logical date: DCAM cannot derive the data interval from this schedule, so the delay may include one interval.',
  not_scheduled: 'Manual, backfill or asset-triggered run: start delay counts scheduled runs only.',
};

export const STATE_LABEL: Record<Run['state'], string> = {
  success: 'Succeeded',
  failed: 'Failed',
  running: 'Running',
};

export function RunsTimeline({
  runs,
  range,
  dataAsOf,
  selectedRunId,
  onSelect,
}: {
  runs: readonly Run[];
  range: DagDetail['range'];
  dataAsOf: string;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const theme = useTheme();
  const t = tokens[theme.palette.mode];
  const descId = useId();
  const bars = useRef<Array<SVGRectElement | null>>([]);
  const [asTable, setAsTable] = useState(false);
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const now = Date.parse(dataAsOf);
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = (ms: number) => M.left + ((ms - from) / Math.max(1, to - from)) * plotW;
  const seconds = (r: Run) => r.duration_seconds ?? Math.max(0, (now - Date.parse(r.start)) / 1000);
  const { max, step } = niceMax(Math.max(60, ...runs.map(seconds)));
  const y = (s: number) => M.top + plotH - (s / max) * plotH;
  const barW = Math.min(18, Math.max(3, (plotW / Math.max(runs.length, 1)) * 0.6));
  const colour: Record<Run['state'], string> = {
    success: t.statusOk,
    failed: t.statusError,
    running: t.statusInfo,
  };
  const counts = { success: 0, failed: 0, running: 0 };
  for (const r of runs) counts[r.state]++;
  const selectedIndex = Math.max(
    0,
    runs.findIndex((r) => r.run_id === selectedRunId),
  );
  const label = (r: Run) =>
    `${formatUtc(r.start)}: ${STATE_LABEL[r.state].toLowerCase()}, ${
      r.duration_seconds === null
        ? `running for ${formatDuration(seconds(r))}`
        : formatDuration(r.duration_seconds)
    }, start delay ${formatStartDelay(r)}`;

  const move = (index: number) => {
    const run = runs[index];
    if (!run) return;
    onSelect(run.run_id);
    bars.current[index]?.focus();
  };
  const onKey = (index: number) => (e: KeyboardEvent) => {
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? index + 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? index - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? runs.length - 1
              : null;
    if (next !== null) {
      e.preventDefault();
      move(Math.min(runs.length - 1, Math.max(0, next)));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      move(index);
    }
  };

  if (runs.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        No run of this DAG started in the range. Pick a longer range, or check that the DAG is not paused.
      </Typography>
    );

  const timeTicks = Array.from({ length: 5 }, (_, i) => from + ((to - from) * i) / 4);
  const durationTicks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);

  return (
    <Stack spacing={2}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}
      >
        <Box
          component="ul"
          aria-label="Run states"
          sx={{ display: 'flex', gap: 3, listStyle: 'none', m: 0, p: 0 }}
        >
          {(['success', 'failed', 'running'] as const).map((s) => (
            <Box component="li" key={s} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box
                aria-hidden
                sx={{
                  width: 12,
                  height: 12,
                  bgcolor: s === 'running' ? 'transparent' : colour[s],
                  border: `2px ${s === 'running' ? 'dashed' : 'solid'} ${colour[s]}`,
                }}
              />
              <Typography variant="caption">
                {STATE_LABEL[s]}
                {s === 'failed' ? ' (✕)' : ''}
              </Typography>
            </Box>
          ))}
        </Box>
        <Button size="small" variant="outlined" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'View runs as chart' : 'View runs as table'}
        </Button>
      </Stack>
      <Typography id={descId} variant="caption" color="text.secondary">
        {formatInt(runs.length)} runs: {formatInt(counts.success)} succeeded, {formatInt(counts.failed)}{' '}
        failed, {formatInt(counts.running)} running. Bar height is the run duration; pick a run to show it in
        the Gantt chart.
      </Typography>

      {asTable ? (
        <TableContainer sx={{ maxHeight: 360 }}>
          <Table size="small" stickyHeader aria-label="Runs">
            <TableHead>
              <TableRow>
                <TableCell>Start</TableCell>
                <TableCell>State</TableCell>
                <TableCell align="right">Duration</TableCell>
                <TableCell align="right">Start delay</TableCell>
                <TableCell align="right">Tries</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {[...runs].reverse().map((r) => (
                <TableRow key={r.run_id} selected={r.run_id === selectedRunId}>
                  <TableCell title={r.run_id}>{formatUtc(r.start)}</TableCell>
                  <TableCell>{STATE_LABEL[r.state]}</TableCell>
                  <TableCell align="right">{formatDuration(r.duration_seconds)}</TableCell>
                  <TableCell align="right" title={START_DELAY_BASIS[r.start_delay_basis]}>
                    {formatStartDelay(r)}
                  </TableCell>
                  <TableCell align="right">{formatInt(r.tries)}</TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => onSelect(r.run_id)}
                      disabled={r.run_id === selectedRunId}
                    >
                      Show in Gantt
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          aria-describedby={descId}
          style={{ width: '100%', height: 'auto', display: 'block', fontFamily: theme.typography.fontFamily }}
        >
          {durationTicks.map((s) => (
            <g key={s} aria-hidden="true">
              <line x1={M.left} x2={W - M.right} y1={y(s)} y2={y(s)} stroke={t.borderSubtle} />
              <text x={M.left - 6} y={y(s) + 4} fontSize={11} textAnchor="end" fill={t.textSecondary}>
                {s === 0 ? '0' : formatDuration(s)}
              </text>
            </g>
          ))}
          {timeTicks.map((ms, i) => (
            <text
              key={ms}
              aria-hidden="true"
              x={x(ms)}
              y={H - 10}
              fontSize={11}
              textAnchor="middle"
              fill={t.textSecondary}
            >
              {/* The time zone sits on the first tick: a label at the end collided with the last one. */}
              {i === 0 ? `${formatClock(ms)} UTC` : formatClock(ms)}
            </text>
          ))}
          <g role="radiogroup" aria-label="Runs">
            {runs.map((r, i) => {
              const s = seconds(r);
              const selected = i === selectedIndex;
              const top = y(s);
              const left = x(Date.parse(r.start)) - barW / 2;
              return (
                <g key={r.run_id}>
                  <rect
                    ref={(el) => {
                      bars.current[i] = el;
                    }}
                    role="radio"
                    aria-checked={selected}
                    aria-label={label(r)}
                    tabIndex={selected ? 0 : -1}
                    x={left}
                    y={top}
                    width={barW}
                    height={Math.max(1, y(0) - top)}
                    fill={r.state === 'running' ? 'transparent' : colour[r.state]}
                    stroke={selected ? t.accentPrimary : colour[r.state]}
                    strokeWidth={selected ? 3 : r.state === 'running' ? 2 : 0}
                    strokeDasharray={r.state === 'running' ? '4 2' : undefined}
                    onClick={() => onSelect(r.run_id)}
                    onKeyDown={onKey(i)}
                    style={{ cursor: 'pointer' }}
                  >
                    <title>{label(r)}</title>
                  </rect>
                  {r.state === 'failed' && (
                    <text
                      aria-hidden="true"
                      x={left + barW / 2}
                      y={top - 4}
                      fontSize={11}
                      textAnchor="middle"
                      fill={colour.failed}
                    >
                      ✕
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </Stack>
  );
}
