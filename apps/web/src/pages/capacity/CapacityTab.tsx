/**
 * S-04 capacity tab: the answer (capacity-bound or not, and the longest stretch), KPIs, worker slots against
 * running and queued task instances with the capacity-bound buckets highlighted, the capacity-bound periods
 * listed, then workers and scale events, limits, worker CPU and memory, and pools. Times follow the context
 * bar's zone; chart or table views are in the URL.
 *
 * @implements FR-ENV-02, HM-011, HM-012, NFR-DATA-03, FR-UI-05, FR-UI-07
 */
import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { Capacity } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import { bucketLabels } from '../../components/charts';
import { clause, formatInt, formatShare } from '../../components/format';
import { Kpi, KpiRow, Panel } from '../../components/Panel';
import { usePageParam, useTimeFormat } from '../../components/view';
import type { PageProps } from '../types';
import { LimitsPanel, PoolSlotsPanel, WorkersPanel, WorkloadsPanel } from './CapacityDetails';
import { capacityColours } from './colours';
import { CAPACITY_EXPLANATIONS as X } from './explanations';
import { NO_DATA, bucketName, formatCount, formatRatio, periodText, spreadP95 } from './format';
import { ChartKey, LineKey, SwatchKey, TimeChart, type ChartLimit } from './TimeChart';

type Bucket = Capacity['series'][number];

/** Queued task instances that make a minute at max_count capacity-bound (HM-011), with the slots at max. */
export function boundThreshold(c: Capacity): number {
  const atMax = c.limits.worker_slots_at_max;
  const { min_queued: min, queued_ratio: ratio } = c.capacity_bound;
  return atMax === null ? min : Math.max(min, Math.ceil(ratio * atMax));
}

function longestPeriod(c: Capacity) {
  return c.capacity_bound.periods.reduce<Capacity['capacity_bound']['periods'][number] | undefined>(
    (best, p) => (!best || p.minutes >= best.minutes ? p : best),
    undefined,
  );
}

function Answer({
  c,
  span,
  linkTo,
  onForecast,
}: {
  c: Capacity;
  span: string;
  linkTo: PageProps['linkTo'];
  onForecast: () => void;
}) {
  const time = useTimeFormat();
  const cb = c.capacity_bound;
  const action = <InfoPopover explanation={X['cap-answer']} />;
  if (!cb.evaluated)
    return (
      <Alert severity="info" action={action}>
        Capacity-bound periods are not evaluated for the last {span}: {clause(cb.not_evaluated_reason ?? '')}.{' '}
        <Link href={linkTo({ page: 'health' })}>Open DCAM health</Link> to see what DCAM collects.
      </Alert>
    );
  const minutes = c.summary.capacity_bound_minutes ?? 0;
  const longest = longestPeriod(c);
  if (minutes === 0 || !longest)
    return (
      <Alert severity="success" action={action}>
        Not capacity-bound in the last {span}: workers were never at the maximum of {c.limits.max_workers}{' '}
        with at least {formatInt(boundThreshold(c))} task instances queued (the larger of{' '}
        {formatInt(cb.min_queued)} and {formatShare(cb.queued_ratio)} of the{' '}
        {formatCount(c.limits.worker_slots_at_max)} worker slots).
      </Alert>
    );
  return (
    <Alert severity="warning" action={action}>
      Capacity-bound for {formatInt(minutes)} min in the last {span} (
      {formatShare(c.summary.capacity_bound_share)} of the observed minutes). The longest stretch was{' '}
      {formatInt(longest.minutes)} min from {time.dateTime(longest.start)}: workers at the maximum of{' '}
      {longest.workers} with up to {formatInt(longest.queued_peak)} task instances queued. See which DAGs
      waited on the <Link href={linkTo({ page: 'bottlenecks' })}>bottlenecks page</Link>, and whether it comes
      back in the{' '}
      <Link component="button" type="button" onClick={onForecast} sx={{ verticalAlign: 'baseline' }}>
        forecast
      </Link>
      .
    </Alert>
  );
}

function Kpis({ c }: { c: Capacity }) {
  const s = c.summary;
  const noFigures = s.observed_minutes === 0;
  const bound =
    s.capacity_bound_minutes !== null
      ? {
          value: formatInt(s.capacity_bound_minutes),
          unit: 'min',
          hint: `${formatShare(s.capacity_bound_share)} of the observed minutes, ${formatInt(c.capacity_bound.period_count)} period${c.capacity_bound.period_count === 1 ? '' : 's'}`,
        }
      : noFigures
        ? { value: NO_DATA, hint: 'No worker figures in this range' }
        : { value: 'Not known yet', hint: 'worker_concurrency is not known, so full slots cannot be told' };
  const util = spreadP95(s.utilisation, (v) => formatShare(v));
  return (
    <KpiRow>
      <Kpi explanation={X['cap-bound-minutes']} {...bound} />
      <Kpi
        explanation={X['cap-at-max']}
        value={s.minutes_at_max_workers === null ? NO_DATA : formatInt(s.minutes_at_max_workers)}
        unit={s.minutes_at_max_workers === null ? undefined : 'min'}
        hint={`max_count ${c.limits.max_workers}, min_count ${c.limits.min_workers}`}
      />
      <Kpi
        explanation={X['cap-utilisation']}
        value={util.value ?? (c.limits.worker_concurrency === null ? 'Not known yet' : NO_DATA)}
        hint={
          util.lowSample && util.value !== null
            ? `Low sample: ${formatInt(s.utilisation.samples)} minutes, so this is the maximum`
            : util.value === null
              ? c.limits.worker_concurrency === null
                ? 'Needs worker_concurrency'
                : 'No worker figures in this range'
              : `p50 ${formatRatio(s.utilisation.p50)}`
        }
      />
      <Kpi
        explanation={X['cap-queued-peak']}
        value={formatCount(s.queued_peak)}
        unit={s.queued_peak === null ? undefined : 'task instances'}
        hint={s.running_peak === null ? undefined : `Peak running ${formatInt(s.running_peak)}`}
      />
    </KpiRow>
  );
}

/** The chart's accessible description: peaks and every capacity-bound period (the five longest beyond five). */
function slotsDescription(c: Capacity, periods: string[]): string {
  const s = c.summary;
  const peak =
    s.running_peak === null
      ? 'No worker figures in this range.'
      : `Peak ${formatInt(s.running_peak)} running and ${formatInt(s.queued_peak ?? 0)} queued.`;
  const bound = periods.length ? ` Capacity-bound: ${periods.join('; ')}.` : ' No capacity-bound minute.';
  return `Worker slots against running and queued task instances per ${bucketName(c.bucket_seconds)} bucket. ${peak}${bound}`;
}

function SlotsPanel({ c }: { c: Capacity }) {
  const theme = useTheme();
  const time = useTimeFormat();
  const colours = capacityColours(theme.palette.mode);
  const [view, setView] = usePageParam('slots', 'chart');
  const asTable = view === 'table';
  const bucketMs = c.bucket_seconds * 1000;
  const labels = bucketLabels(time, c.series.length, bucketMs);
  const starts = useMemo(() => c.series.map((b) => Date.parse(b.start)), [c.series]);
  const pick = (f: (b: Bucket) => number | null) => c.series.map(f);
  const highlights = c.series.flatMap((b, index) =>
    (b.capacity_bound_minutes ?? 0) > 0
      ? [
          {
            index,
            title: `Capacity-bound ${labels.range(Date.parse(b.start))}: ${formatInt(b.capacity_bound_minutes ?? 0)} min`,
          },
        ]
      : [],
  );
  const periods = [...c.capacity_bound.periods]
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 5)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((p) => periodText(time, p.start, p.end, p.minutes));
  const more = c.capacity_bound.period_count - periods.length;
  const dataMax = Math.max(
    0,
    ...c.series.map((b) => Math.max(b.worker_slots_mean ?? 0, (b.running_mean ?? 0) + (b.queued_mean ?? 0))),
  );
  const limits: ChartLimit[] = [];
  const hidden: string[] = [];
  const addLimit = (key: string, label: string, value: number | null, dash: string) => {
    if (value === null) return;
    if (dataMax > 0 && value > dataMax * 1.5) hidden.push(`${label} ${formatInt(value)}`);
    else
      limits.push({
        key,
        label: `${label} ${formatInt(value)}`,
        value,
        color: theme.palette.text.secondary,
        dash,
      });
  };
  addLimit('at-max', 'Slots at max_count', c.limits.worker_slots_at_max, '6 4');
  addLimit('parallelism', 'parallelism × schedulers', c.limits.parallelism_total, '2 3');

  return (
    <Panel
      explanation={X['cap-slots']}
      actions={
        <Button size="small" onClick={() => setView(asTable ? 'chart' : 'table')}>
          {asTable ? 'View as a chart' : 'View as a table'}
        </Button>
      }
    >
      <Stack spacing={2}>
        <ChartKey label="Legend: worker slots and use">
          <SwatchKey color={colours.running} label="Running" />
          <SwatchKey color={colours.queued} label="Queued" />
          <LineKey color={theme.palette.text.primary} label="Worker slots" />
          <LineKey color={colours.secondary} dash="3 3" label="Running tries (task history)" />
          <SwatchKey color={colours.bound} hatched label="Capacity-bound" />
        </ChartKey>
        <Typography variant="caption" color="text.secondary">
          Task instances per {bucketName(c.bucket_seconds)} bucket (mean of its minutes).
          {hidden.length ? ` Above the chart, not drawn: ${hidden.join(', ')} task instances.` : ''}
          {more > 0 && !asTable
            ? ` ${formatInt(more)} shorter capacity-bound periods are in the list below.`
            : ''}
        </Typography>
        {asTable ? (
          <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
            <Table size="small" stickyHeader aria-label="Worker slots per bucket">
              <TableHead>
                <TableRow>
                  <TableCell>{`Bucket start (${time.zoneName(starts[0])})`}</TableCell>
                  <TableCell align="right">Workers</TableCell>
                  <TableCell align="right">Worker slots</TableCell>
                  <TableCell align="right">Running</TableCell>
                  <TableCell align="right">Queued</TableCell>
                  <TableCell align="right">Running tries (history)</TableCell>
                  <TableCell align="right">Utilisation</TableCell>
                  <TableCell align="right">Capacity-bound minutes</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {c.series.map((b) => {
                  const bound = b.capacity_bound_minutes ?? 0;
                  return (
                    <TableRow key={b.start}>
                      <TableCell>{time.dayClock(b.start)}</TableCell>
                      <TableCell align="right">{formatCount(b.workers_mean)}</TableCell>
                      <TableCell align="right">{formatCount(b.worker_slots_mean)}</TableCell>
                      <TableCell align="right">{formatCount(b.running_mean)}</TableCell>
                      <TableCell align="right">{formatCount(b.queued_mean)}</TableCell>
                      <TableCell align="right">{formatCount(b.running_tries_mean)}</TableCell>
                      <TableCell align="right">{formatRatio(b.utilisation_mean)}</TableCell>
                      <TableCell align="right">
                        {b.capacity_bound_minutes === null ? (
                          NO_DATA
                        ) : bound > 0 ? (
                          <Stack
                            direction="row"
                            sx={{ gap: 1, justifyContent: 'flex-end', alignItems: 'center' }}
                          >
                            <Chip size="small" color="error" variant="outlined" label="Capacity-bound" />
                            {formatInt(bound)}
                          </Stack>
                        ) : (
                          '0'
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        ) : (
          <TimeChart
            starts={starts}
            bucketMs={bucketMs}
            label={slotsDescription(c, periods)}
            format={(v) => formatCount(v)}
            bars={[
              {
                key: 'running',
                label: 'Running',
                color: colours.running,
                values: pick((b) => b.running_mean),
              },
              { key: 'queued', label: 'Queued', color: colours.queued, values: pick((b) => b.queued_mean) },
            ]}
            lines={[
              {
                key: 'slots',
                label: 'Worker slots',
                color: theme.palette.text.primary,
                values: pick((b) => b.worker_slots_mean),
              },
              {
                key: 'tries',
                label: 'Running tries (task history)',
                color: colours.secondary,
                dash: '3 3',
                values: pick((b) => b.running_tries_mean),
              },
            ]}
            limits={limits}
            highlights={highlights}
            highlightColor={colours.bound}
          />
        )}
      </Stack>
    </Panel>
  );
}

function PeriodsPanel({ c }: { c: Capacity }) {
  const time = useTimeFormat();
  const cb = c.capacity_bound;
  const rows = [...cb.periods].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  return (
    <Panel explanation={X['cap-periods']}>
      {!cb.evaluated ? (
        <Typography variant="body2" color="text.secondary">
          Not evaluated: {cb.not_evaluated_reason}
        </Typography>
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No capacity-bound period in this range.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {cb.period_count > rows.length && (
            <Typography variant="caption" color="text.secondary">
              The newest {formatInt(rows.length)} of {formatInt(cb.period_count)} periods.
            </Typography>
          )}
          <Box sx={{ maxHeight: 360, overflow: 'auto' }}>
            <Table size="small" stickyHeader aria-label="Capacity-bound periods">
              <TableHead>
                <TableRow>
                  <TableCell>{`Start (${time.zoneName(rows[0]?.start)})`}</TableCell>
                  <TableCell>End</TableCell>
                  <TableCell align="right">Length</TableCell>
                  <TableCell align="right">Peak queued</TableCell>
                  <TableCell align="right">Workers</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.start}>
                    <TableCell>{time.dayClock(p.start)}</TableCell>
                    <TableCell>
                      {time.day(p.end) === time.day(p.start) ? time.clock(p.end) : time.dayClock(p.end)}
                    </TableCell>
                    <TableCell align="right">{formatInt(p.minutes)} min</TableCell>
                    <TableCell align="right">{formatInt(p.queued_peak)}</TableCell>
                    <TableCell align="right">
                      {p.workers} of {c.limits.max_workers}
                      {p.workers >= c.limits.max_workers ? ' (max)' : ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Stack>
      )}
    </Panel>
  );
}

export function CapacityTab({
  c,
  span,
  linkTo,
  onForecast,
}: {
  c: Capacity;
  /** "24 hours": the range shown, inside sentences. */
  span: string;
  linkTo: PageProps['linkTo'];
  onForecast: () => void;
}) {
  return (
    <Stack spacing={4}>
      <Answer c={c} span={span} linkTo={linkTo} onForecast={onForecast} />
      <Kpis c={c} />
      <SlotsPanel c={c} />
      <PeriodsPanel c={c} />
      <WorkersPanel c={c} />
      <Stack direction={{ xs: 'column', lg: 'row' }} sx={{ gap: 4 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <LimitsPanel c={c} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <WorkloadsPanel c={c} />
        </Box>
      </Stack>
      <PoolSlotsPanel c={c} />
    </Stack>
  );
}
