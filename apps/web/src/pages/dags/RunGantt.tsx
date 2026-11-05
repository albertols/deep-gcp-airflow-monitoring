/**
 * Run Gantt (FR-DAGD-03): every try of one run on a time axis, with the wait before the queue, the wait
 * in the queue and the running time in visually distinct, accessible styles (hatched, dotted, solid),
 * a legend, a text summary and a table view.
 *
 * @implements FR-DAGD-03
 */
import { useId, useState } from 'react';
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
import { formatClock } from './time';

type GanttRow = DagDetail['gantt']['rows'][number];
type Segment = 'pre-queue' | 'queued' | 'running';

const W = 960;
const LABEL_W = 210;
const ROW_H = 22;
const BAR_H = 14;
const AXIS_H = 26;
const MAX_ROWS = 300;
const MONO = '"Roboto Mono", ui-monospace, monospace';

const ms = (iso: string | null) => (iso === null ? null : Date.parse(iso));

interface Bar {
  readonly kind: Segment;
  readonly from: number;
  readonly to: number;
}

/** The three phases of one try; open phases end at "now" (`dataAsOf`). */
function segments(r: GanttRow, now: number): Bar[] {
  const ready = ms(r.ready_at);
  const queued = ms(r.queued_at);
  const start = ms(r.start);
  const end = ms(r.end);
  const bars: Bar[] = [];
  if (ready !== null) bars.push({ kind: 'pre-queue', from: ready, to: queued ?? start ?? now });
  if (queued !== null) bars.push({ kind: 'queued', from: queued, to: start ?? now });
  if (start !== null) bars.push({ kind: 'running', from: start, to: end ?? now });
  return bars.filter((b) => b.to > b.from);
}

const seconds = (b: Bar | undefined) => (b ? (b.to - b.from) / 1000 : null);

function rowLabel(r: GanttRow): string {
  return r.try_number > 1 ? `${r.task_id} · try ${r.try_number}` : r.task_id;
}

export function RunGantt({ gantt, dataAsOf }: { gantt: DagDetail['gantt']; dataAsOf: string }) {
  const theme = useTheme();
  const t = tokens[theme.palette.mode];
  const uid = useId().replace(/:/g, '');
  const hatch = `gantt-hatch-${uid}`;
  const dots = `gantt-dots-${uid}`;
  const descId = `gantt-desc-${uid}`;
  const [asTable, setAsTable] = useState(false);
  const now = Date.parse(dataAsOf);

  if (gantt.run_id === null || gantt.rows.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        No tries to show yet. Pick a run in the timeline above, or a longer range.
      </Typography>
    );

  const rows = gantt.rows.slice(0, MAX_ROWS);
  const bars = rows.map((r) => segments(r, now));
  const all = bars.flat();
  const t0 = Math.min(...all.map((b) => b.from));
  const t1 = Math.max(t0 + 1_000, ...all.map((b) => b.to));
  const x = (v: number) => LABEL_W + ((v - t0) / (t1 - t0)) * (W - LABEL_W - 12);
  const height = rows.length * ROW_H + AXIS_H;
  const fill: Record<Segment, string> = {
    'pre-queue': `url(#${hatch})`,
    queued: `url(#${dots})`,
    running: t.accentPrimary,
  };
  const longest = (kind: Segment) => {
    let best: { row: GanttRow; s: number } | null = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const s = seconds(bars[i]?.find((b) => b.kind === kind)) ?? 0;
      if (row && s > (best?.s ?? 0)) best = { row, s };
    }
    return best;
  };
  const summary = (['pre-queue', 'queued', 'running'] as const)
    .map((kind) => {
      const l = longest(kind);
      const what =
        kind === 'pre-queue' ? 'wait before the queue' : kind === 'queued' ? 'queue wait' : 'running time';
      return l ? `longest ${what} ${formatDuration(l.s)} (${rowLabel(l.row)})` : null;
    })
    .filter(Boolean)
    .join('; ');
  const tasks = new Set(gantt.rows.map((r) => r.task_id)).size;
  const description = `${formatInt(gantt.rows.length)} tries of ${formatInt(tasks)} tasks${
    gantt.rows.length > MAX_ROWS ? `, the first ${MAX_ROWS} drawn` : ''
  }. ${summary ? `${summary[0]?.toUpperCase()}${summary.slice(1)}.` : ''}`;
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);

  return (
    <Stack spacing={2}>
      {/* Pattern definitions shared by the chart and the legend. */}
      <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
        <defs>
          <pattern
            id={hatch}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill={t.bgRaised} />
            <line x1="0" y1="0" x2="0" y2="6" stroke={t.statusWarning} strokeWidth="3" />
          </pattern>
          <pattern id={dots} width="5" height="5" patternUnits="userSpaceOnUse">
            <rect width="5" height="5" fill={t.bgRaised} />
            <circle cx="2.5" cy="2.5" r="1.4" fill={t.statusInfo} />
          </pattern>
        </defs>
      </svg>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}
      >
        <Box
          component="ul"
          aria-label="Gantt legend"
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, listStyle: 'none', m: 0, p: 0 }}
        >
          {(
            [
              ['Ready, waiting to be queued', fill['pre-queue'], t.statusWarning],
              ['Queued, waiting for a worker', fill.queued, t.statusInfo],
              ['Running', fill.running, t.accentPrimary],
              ['Failed try', t.statusError, t.statusError],
            ] as const
          ).map(([text, swatch, stroke]) => (
            <Box component="li" key={text} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <svg width="18" height="12" aria-hidden="true">
                <rect x="0.5" y="0.5" width="17" height="11" fill={swatch} stroke={stroke} />
              </svg>
              <Typography variant="caption">{text}</Typography>
            </Box>
          ))}
        </Box>
        <Button size="small" variant="outlined" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'View Gantt as chart' : 'View Gantt as table'}
        </Button>
      </Stack>
      <Typography id={descId} variant="caption" color="text.secondary">
        {description}
      </Typography>

      {asTable ? (
        <TableContainer sx={{ maxHeight: 420 }}>
          <Table size="small" stickyHeader aria-label={`Gantt of run ${gantt.run_id}`}>
            <TableHead>
              <TableRow>
                <TableCell>Task</TableCell>
                <TableCell align="right">Try</TableCell>
                <TableCell>State</TableCell>
                <TableCell>Ready</TableCell>
                <TableCell align="right">Wait before queue</TableCell>
                <TableCell align="right">Queue wait</TableCell>
                <TableCell align="right">Running</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {gantt.rows.map((r, i) => {
                const b = segments(r, now);
                const ready = ms(r.ready_at);
                return (
                  <TableRow key={`${r.task_id}-${r.try_number}-${i}`}>
                    <TableCell sx={{ fontFamily: MONO }}>{r.task_id}</TableCell>
                    <TableCell align="right">{r.try_number}</TableCell>
                    <TableCell>{r.state ?? '—'}</TableCell>
                    <TableCell>{ready === null ? '—' : `${formatClock(ready)} UTC`}</TableCell>
                    <TableCell align="right">
                      {formatDuration(seconds(b.find((s) => s.kind === 'pre-queue')))}
                    </TableCell>
                    <TableCell align="right">
                      {formatDuration(seconds(b.find((s) => s.kind === 'queued')))}
                    </TableCell>
                    <TableCell align="right">
                      {formatDuration(seconds(b.find((s) => s.kind === 'running')))}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <svg
          role="img"
          aria-label={`Gantt of run ${gantt.run_id}`}
          aria-describedby={descId}
          viewBox={`0 0 ${W} ${height}`}
          style={{ width: '100%', height: 'auto', display: 'block', fontFamily: theme.typography.fontFamily }}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={x(v)} x2={x(v)} y1={0} y2={height - AXIS_H} stroke={t.borderSubtle} />
              <text x={x(v)} y={height - 8} fontSize={11} textAnchor="middle" fill={t.textSecondary}>
                {formatClock(v)}
              </text>
            </g>
          ))}
          <text x={W - 12} y={height - 8} fontSize={11} textAnchor="end" fill={t.textSecondary}>
            UTC
          </text>
          {rows.map((r, i) => {
            const top = i * ROW_H;
            const failed = r.state === 'failed';
            const text = rowLabel(r);
            return (
              <g key={`${r.task_id}-${r.try_number}-${i}`}>
                <text x={4} y={top + 15} fontSize={11} fill={t.textPrimary} fontFamily={MONO}>
                  {text.length > 30 ? `${text.slice(0, 29)}…` : text}
                </text>
                {(bars[i] ?? []).map((b) => (
                  <rect
                    key={b.kind}
                    data-segment={b.kind}
                    x={x(b.from)}
                    y={top + (ROW_H - BAR_H) / 2}
                    width={Math.max(1, x(b.to) - x(b.from))}
                    height={BAR_H}
                    fill={b.kind === 'running' && failed ? t.statusError : fill[b.kind]}
                    stroke={
                      b.kind === 'running' ? 'none' : b.kind === 'pre-queue' ? t.statusWarning : t.statusInfo
                    }
                    strokeWidth={1}
                  >
                    <title>
                      {`${text}: ${
                        b.kind === 'pre-queue'
                          ? 'waiting to be queued'
                          : b.kind === 'queued'
                            ? 'queued'
                            : (r.state ?? 'running')
                      } for ${formatDuration((b.to - b.from) / 1000)}, from ${formatClock(b.from)} UTC`}
                    </title>
                  </rect>
                ))}
              </g>
            );
          })}
        </svg>
      )}
    </Stack>
  );
}
