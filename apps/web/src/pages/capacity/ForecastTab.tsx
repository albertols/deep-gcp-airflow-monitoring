/**
 * Forecast tab (HM-010, FR-BOTL-05): the next 24 hours from now, built from the task history, never from the
 * context bar's range. It states its confidence first (low confidence prominently: with DCAM's default 7-day
 * backfill most DAGs have less than the 14 days HM-010 needs), then the predicted saturation and risk windows,
 * the demand band against the worker slots at max_count, the DAGs and the pools. Every number is an estimate and
 * says so; unknown demand is unknown, never zero. Each table exports the rows it shows (FR-STORE-04), the
 * demand per step with the forecast's method.
 *
 * @implements HM-010, FR-BOTL-05, NFR-DATA-03, NFR-DATA-04, FR-UI-05, FR-UI-07, FR-UI-08, FR-STORE-04
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
import type { Forecast, ForecastCheck } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import { bucketLabels } from '../../components/charts';
import { csvList, isoUtc, type CsvColumn } from '../../components/csv';
import { ExportCsvButton } from '../../components/ExportCsv';
import { formatInt, formatSchedule, formatShare } from '../../components/format';
import { Kpi, KpiRow, Panel, ProvenanceFooter } from '../../components/Panel';
import { usePageParam, useTimeFormat } from '../../components/view';
import type { PageProps } from '../types';
import { capacityColours } from './colours';
import { FORECAST_EXPLANATIONS as X } from './explanations';
import { NO_DATA, UNKNOWN, formatCount, periodText } from './format';
import { ChartKey, LineKey, SwatchKey, TimeChart, type ChartHighlight, type ChartLimit } from './TimeChart';

type Window = ForecastCheck['windows'][number];
type Step = Forecast['series'][number];
type ForecastDag = Forecast['dags'][number];
type ForecastPool = Forecast['pools'][number];

const MONO = { fontFamily: '"Roboto Mono", ui-monospace, monospace' } as const;
const upToOne = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const daysText = (d: number) => `${upToOne.format(d)} day${upToOne.format(d) === '1' ? '' : 's'}`;

/** Steps of the series that overlap a window. */
function stepsIn(f: Forecast, windows: readonly Window[]): Set<number> {
  const stepMs = f.step_seconds * 1000;
  const out = new Set<number>();
  f.series.forEach((s, i) => {
    const start = Date.parse(s.start);
    if (windows.some((w) => start < Date.parse(w.end) && start + stepMs > Date.parse(w.start))) out.add(i);
  });
  return out;
}

/** The demand table as CSV: slots per step, an estimate by the forecast's method; a step outside history is empty. */
const demandCsv = (
  f: Forecast,
  saturated: ReadonlySet<number>,
  risky: ReadonlySet<number>,
): readonly CsvColumn<{ step: Step; index: number }>[] => [
  { name: 'step_start_utc', value: (x) => isoUtc(x.step.start) },
  { name: 'step_seconds', value: () => f.step_seconds },
  { name: 'demand_p10_slots', value: (x) => x.step.p10 },
  { name: 'demand_p50_slots', value: (x) => x.step.p50 },
  { name: 'demand_p90_slots', value: (x) => x.step.p90 },
  { name: 'baseline_slots', value: (x) => x.step.baseline },
  {
    name: 'window',
    value: (x) => (saturated.has(x.index) ? 'saturation' : risky.has(x.index) ? 'risk' : null),
  },
  { name: 'method', value: () => f.method },
];

const WINDOW_CSV: readonly CsvColumn<Window>[] = [
  { name: 'start_utc', value: (w) => isoUtc(w.start) },
  { name: 'end_utc', value: (w) => isoUtc(w.end) },
  { name: 'length_minutes', value: (w) => w.minutes },
  { name: 'peak_demand_slots', value: (w) => w.peak_slots },
  { name: 'worker_slots_at_max', value: (w) => w.capacity_slots },
  { name: 'low_confidence', value: (w) => w.low_confidence },
  { name: 'top_dags', value: (w) => csvList(w.top_dags.map((d) => d.dag_id)) },
  { name: 'top_dags_share_ratio', value: (w) => csvList(w.top_dags.map((d) => String(d.share))) },
];

const DAG_CSV: readonly CsvColumn<ForecastDag>[] = [
  { name: 'dag_id', value: (d) => d.dag_id },
  { name: 'schedule', value: (d) => d.schedule },
  { name: 'planned_runs', value: (d) => d.planned_runs },
  { name: 'runs_profiled', value: (d) => d.runs_profiled },
  { name: 'history_days', value: (d) => d.history_days },
  { name: 'low_confidence', value: (d) => d.low_confidence },
  { name: 'slot_minutes', value: (d) => d.slot_minutes },
  { name: 'peak_slots_one_run', value: (d) => d.peak_slots },
];

const POOL_CSV: readonly CsvColumn<ForecastPool>[] = [
  { name: 'pool', value: (p) => p.name },
  { name: 'slots', value: (p) => p.slots },
  { name: 'peak_demand_p50_slots', value: (p) => p.peak_slots },
  { name: 'peak_at_utc', value: (p) => isoUtc(p.peak_at) },
  { name: 'over_size_minutes', value: (p) => p.minutes_over },
];

function HorizonText({ f }: { f: Forecast }) {
  const time = useTimeFormat();
  const zone = time.zoneName(f.horizon.from);
  const h = f.history;
  const history =
    h.from === null
      ? 'with no task history yet'
      : `built from ${daysText(h.days)} of task history (${time.dayClock(h.from)} to ${time.dayClock(h.to)} ${time.zoneName(h.to)})`;
  return (
    <Typography variant="body2" color="text.secondary">
      {`Forecast for the next 24 hours from now: ${time.dayClock(f.horizon.from)} to ${time.dayClock(f.horizon.to)} ${zone}, ${history}. It does not follow the time range.`}
    </Typography>
  );
}

function ConfidenceAlert({ f }: { f: Forecast }) {
  const c = f.confidence;
  const low = c.level === 'low';
  const details: string[] = [];
  if (c.dags_without_history > 0)
    details.push(
      c.dags_without_history === 1
        ? '1 DAG has planned runs but no profiled run: its demand is unknown, not zero, and not in the forecast.'
        : `${formatInt(c.dags_without_history)} DAGs have planned runs but no profiled run: their demand is unknown, not zero, and not in the forecast.`,
    );
  if (f.evaluated && low && c.low_confidence_share !== null)
    details.push(
      `DAGs with less than ${f.history.min_days} days of history make up ${formatShare(c.low_confidence_share)} of the forecast run demand. Treat the windows below as a hint, and check them against the capacity tab.`,
    );
  return (
    <Alert
      severity={!f.evaluated ? 'info' : low ? 'warning' : 'info'}
      action={<InfoPopover explanation={X['fc-confidence']} />}
    >
      <Typography component="span" variant="body2" sx={{ fontWeight: low ? 500 : undefined }}>
        {c.summary}
      </Typography>
      {details.map((d) => (
        <Typography key={d} component="p" variant="body2" sx={{ mt: 1 }}>
          {d}
        </Typography>
      ))}
    </Alert>
  );
}

function Kpis({ f }: { f: Forecast }) {
  const time = useTimeFormat();
  const sat = f.saturation;
  const first = sat.windows[0];
  const peak = f.series.reduce<number | null>((m, s) => (s.p50 === null ? m : Math.max(m ?? 0, s.p50)), null);
  const atMax = f.capacity.worker_slots_at_max;
  const h = f.history;
  return (
    <KpiRow>
      <Kpi
        explanation={X['fc-windows-kpi']}
        value={sat.evaluated ? formatInt(sat.windows.length) : 'Not known yet'}
        hint={
          !sat.evaluated
            ? 'Needs the worker slots at max_count'
            : first
              ? `First ${time.dateTime(first.start)} for ${formatInt(first.minutes)} min`
              : 'None in the next 24 hours'
        }
      />
      <Kpi
        explanation={X['fc-peak']}
        value={peak === null ? NO_DATA : formatCount(peak)}
        unit={peak === null ? undefined : 'slots'}
        hint={`Worker slots at max_count: ${atMax === null ? 'unknown' : formatInt(atMax)}`}
      />
      <Kpi
        explanation={X['fc-planned']}
        value={formatInt(f.planned_runs)}
        hint={`${formatInt(f.unscheduled_dags)} DAG${f.unscheduled_dags === 1 ? '' : 's'} without a cron schedule ${f.unscheduled_dags === 1 ? 'is' : 'are'} in the baseline`}
      />
      <Kpi
        explanation={X['fc-history']}
        value={upToOne.format(h.days)}
        unit={upToOne.format(h.days) === '1' ? 'day' : 'days'}
        hint={`${h.min_days} days needed; ${h.read_days} read at most; ${formatInt(h.runs_profiled)} runs profiled`}
      />
    </KpiRow>
  );
}

function windowsText(windows: readonly Window[], time: ReturnType<typeof useTimeFormat>) {
  return windows.map((w) => periodText(time, w.start, w.end, w.minutes)).join('; ');
}

function DemandPanel({ f }: { f: Forecast }) {
  const theme = useTheme();
  const time = useTimeFormat();
  const colours = capacityColours(theme.palette.mode);
  const [view, setView] = usePageParam('forecast', 'chart');
  const asTable = view === 'table';
  const stepMs = f.step_seconds * 1000;
  const starts = useMemo(() => f.series.map((s) => Date.parse(s.start)), [f.series]);
  const labels = bucketLabels(time, starts.length, stepMs);
  const saturated = stepsIn(f, f.saturation.windows);
  const risky = stepsIn(f, f.risk.windows);
  const highlights = f.series.flatMap((s, index): ChartHighlight[] => {
    const range = labels.range(Date.parse(s.start));
    if (saturated.has(index))
      return [
        {
          index,
          title: `Predicted saturation ${range}: p50 ${formatCount(s.p50)} slots`,
          kind: 'strong',
        },
      ];
    if (risky.has(index))
      return [{ index, title: `Risk ${range}: p90 ${formatCount(s.p90)} slots`, kind: 'light' }];
    return [];
  });
  const peak = f.series.reduce((m, s) => Math.max(m, s.p50 ?? 0), 0);
  const atMax = f.capacity.worker_slots_at_max;
  const limits: ChartLimit[] = [];
  if (atMax !== null)
    limits.push({
      key: 'at-max',
      label: `Slots at max_count ${formatInt(atMax)}`,
      value: atMax,
      color: theme.palette.text.primary,
      dash: '6 4',
    });
  const total = f.capacity.parallelism_total;
  const bandMax = f.series.reduce((m, s) => Math.max(m, s.p90 ?? 0), 0);
  if (total !== null && total <= Math.max(bandMax, atMax ?? 0) * 1.5)
    limits.push({
      key: 'parallelism',
      label: `parallelism × schedulers ${formatInt(total)}`,
      value: total,
      color: theme.palette.text.secondary,
      dash: '2 3',
    });
  const label =
    `Forecast slot demand per ${f.step_seconds / 60}-minute step for the next 24 hours, an estimate. ` +
    `Peak p50 ${formatCount(peak)} slots against ${atMax === null ? 'unknown' : formatInt(atMax)} worker slots at max_count.` +
    (f.saturation.windows.length
      ? ` Predicted saturation: ${windowsText(f.saturation.windows, time)}.`
      : ' No predicted saturation.') +
    (f.risk.windows.length ? ` Risk (p90 above capacity): ${windowsText(f.risk.windows, time)}.` : '');

  return (
    <Panel
      explanation={X['fc-demand']}
      actions={
        <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
          <Chip size="small" variant="outlined" label="Estimate" />
          {f.confidence.level === 'low' && <Chip size="small" color="warning" label="Low confidence" />}
          <Button size="small" onClick={() => setView(asTable ? 'chart' : 'table')}>
            {asTable ? 'View as a chart' : 'View as a table'}
          </Button>
          <ExportCsvButton
            view="forecast-demand"
            what={`Forecast per ${f.step_seconds / 60}-minute step`}
            rows={f.series.map((step, index) => ({ step, index }))}
            columns={demandCsv(f, saturated, risky)}
          />
        </Stack>
      }
    >
      <Stack spacing={2}>
        <ChartKey label="Legend: forecast slot demand">
          <SwatchKey color={colours.running} label="p10 to p90 band" />
          <LineKey color={colours.running} dash="6 3" label="p50 (central forecast)" />
          <LineKey color={colours.secondary} dash="2 3" label="Baseline (unscheduled work)" />
          <LineKey color={theme.palette.text.primary} dash="6 4" label="Worker slots at max_count" />
          <SwatchKey color={colours.bound} hatched label="Predicted saturation, shaded; risk, hatched only" />
        </ChartKey>
        {asTable ? (
          <Box
            sx={{
              maxHeight: 400,
              overflow: 'auto',
              // 288 rows: plain cells keep the table view quick to open.
              '& tbody td': {
                borderBottom: 1,
                borderColor: 'divider',
                px: 4,
                py: 1.5,
                fontSize: '0.875rem',
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              },
              '& tbody td:first-of-type, & tbody td:last-of-type': { textAlign: 'left' },
            }}
          >
            <Table size="small" stickyHeader aria-label={`Forecast per ${f.step_seconds / 60}-minute step`}>
              <TableHead>
                <TableRow>
                  <TableCell>{`Step start (${time.zoneName(starts[0])})`}</TableCell>
                  <TableCell align="right">p10</TableCell>
                  <TableCell align="right">p50</TableCell>
                  <TableCell align="right">p90</TableCell>
                  <TableCell align="right">Baseline</TableCell>
                  <TableCell>Window</TableCell>
                </TableRow>
              </TableHead>
              <tbody>
                {f.series.map((s, i) => (
                  <tr key={s.start}>
                    <td>{time.dayClock(s.start)}</td>
                    <td>{formatCount(s.p10)}</td>
                    <td>{formatCount(s.p50)}</td>
                    <td>{formatCount(s.p90)}</td>
                    <td>{formatCount(s.baseline)}</td>
                    <td>{saturated.has(i) ? 'Saturation' : risky.has(i) ? 'Risk' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Box>
        ) : (
          <TimeChart
            starts={starts}
            bucketMs={stepMs}
            label={label}
            format={(v) => formatCount(v)}
            curve="linear"
            area={{
              key: 'band',
              label: 'p10 to p90',
              color: colours.running,
              lower: f.series.map((s) => s.p10),
              upper: f.series.map((s) => s.p90),
            }}
            lines={[
              {
                key: 'p50',
                label: 'p50',
                color: colours.running,
                dash: '6 3',
                values: f.series.map((s) => s.p50),
              },
              {
                key: 'baseline',
                label: 'Baseline',
                color: colours.secondary,
                dash: '2 3',
                values: f.series.map((s) => s.baseline),
              },
            ]}
            limits={limits}
            highlights={highlights}
            highlightColor={colours.bound}
          />
        )}
        <Typography variant="caption" color="text.secondary">
          Running plus queued task instances, the highest minute of each step. The band sums each DAG’s p10
          and p90, which assumes the DAGs move together, so it is wide. Baseline method: {f.baseline.method},
          from {upToOne.format(f.baseline.weeks)} weeks of history.
        </Typography>
      </Stack>
    </Panel>
  );
}

function WindowTable({
  view,
  label,
  windows,
  linkTo,
}: {
  view: string;
  label: string;
  windows: readonly Window[];
  linkTo: PageProps['linkTo'];
}) {
  const time = useTimeFormat();
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Stack direction="row" sx={{ justifyContent: 'flex-end', mb: 1 }}>
        <ExportCsvButton view={view} what={label} rows={windows} columns={WINDOW_CSV} />
      </Stack>
      <Table size="small" aria-label={label}>
        <TableHead>
          <TableRow>
            <TableCell>{`Start (${time.zoneName(windows[0]?.start)})`}</TableCell>
            <TableCell>End</TableCell>
            <TableCell align="right">Length</TableCell>
            <TableCell align="right">Peak demand (slots)</TableCell>
            <TableCell align="right">Worker slots at max</TableCell>
            <TableCell>Confidence</TableCell>
            <TableCell>DAGs adding most demand</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {windows.map((w) => (
            <TableRow key={w.start}>
              <TableCell>{time.dayClock(w.start)}</TableCell>
              <TableCell>
                {time.day(w.end) === time.day(w.start) ? time.clock(w.end) : time.dayClock(w.end)}
              </TableCell>
              <TableCell align="right">{formatInt(w.minutes)} min</TableCell>
              <TableCell align="right">{formatCount(w.peak_slots)}</TableCell>
              <TableCell align="right">{formatInt(w.capacity_slots)}</TableCell>
              <TableCell>
                {w.low_confidence ? (
                  <Chip size="small" color="warning" variant="outlined" label="Low confidence" />
                ) : (
                  'Normal'
                )}
              </TableCell>
              <TableCell>
                {w.top_dags.map((d, i) => (
                  <span key={d.dag_id}>
                    {i > 0 && ', '}
                    <Link href={linkTo({ page: 'dag', dagId: d.dag_id })}>{d.dag_id}</Link>{' '}
                    {formatShare(d.share)}
                  </span>
                ))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

function WindowsPanel({ f, linkTo }: { f: Forecast; linkTo: PageProps['linkTo'] }) {
  const sat = f.saturation;
  const risk = f.risk;
  const atMax = f.capacity.worker_slots_at_max;
  const sameReason =
    !sat.evaluated && !risk.evaluated && sat.not_evaluated_reason === risk.not_evaluated_reason;
  return (
    <Panel explanation={X['fc-windows']}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="body2" component="h3" sx={{ fontWeight: 500, mb: 1 }}>
            Predicted saturation: p50 above capacity for {sat.min_minutes} min or more
          </Typography>
          {!sat.evaluated ? (
            <Typography variant="body2" color="text.secondary">
              Not evaluated: {sat.not_evaluated_reason}
            </Typography>
          ) : sat.windows.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No predicted saturation window in the next 24 hours: the central forecast stays within the{' '}
              {formatCount(atMax)} worker slots at max_count.
            </Typography>
          ) : (
            <WindowTable
              view="forecast-saturation-windows"
              label="Predicted saturation windows (p50)"
              windows={sat.windows}
              linkTo={linkTo}
            />
          )}
        </Box>
        <Box>
          <Typography variant="body2" component="h3" sx={{ fontWeight: 500, mb: 1 }}>
            Risk: p90 above capacity for {risk.min_minutes} min or more
          </Typography>
          {!risk.evaluated ? (
            sameReason ? null : (
              <Typography variant="body2" color="text.secondary">
                Not evaluated: {risk.not_evaluated_reason}
              </Typography>
            )
          ) : risk.windows.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No risk window: even the p90 forecast stays within capacity.
            </Typography>
          ) : (
            <WindowTable
              view="forecast-risk-windows"
              label="Risk windows (p90)"
              windows={risk.windows}
              linkTo={linkTo}
            />
          )}
        </Box>
      </Stack>
    </Panel>
  );
}

function DagsPanel({ f, linkTo }: { f: Forecast; linkTo: PageProps['linkTo'] }) {
  return (
    <Panel
      explanation={X['fc-dags']}
      actions={
        <ExportCsvButton view="forecast-dags" what="DAGs in the forecast" rows={f.dags} columns={DAG_CSV} />
      }
    >
      {f.dags.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No DAG has a planned run in the next 24 hours. Unscheduled work is in the baseline.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {f.dag_count > f.dags.length && (
            <Typography variant="caption" color="text.secondary">
              The {formatInt(f.dags.length)} DAGs that add most demand, of {formatInt(f.dag_count)}.
            </Typography>
          )}
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="DAGs in the forecast">
              <TableHead>
                <TableRow>
                  <TableCell>DAG</TableCell>
                  <TableCell>Schedule</TableCell>
                  <TableCell align="right">Planned runs</TableCell>
                  <TableCell align="right">Runs profiled</TableCell>
                  <TableCell align="right">History</TableCell>
                  <TableCell>Confidence</TableCell>
                  <TableCell align="right">Slot-minutes</TableCell>
                  <TableCell align="right">Peak slots (one run)</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {f.dags.map((d) => {
                  const schedule = formatSchedule(d.schedule);
                  return (
                    <TableRow key={d.dag_id}>
                      <TableCell>
                        <Link href={linkTo({ page: 'dag', dagId: d.dag_id })}>{d.dag_id}</Link>
                      </TableCell>
                      <TableCell sx={schedule.code ? MONO : undefined}>{schedule.text}</TableCell>
                      <TableCell align="right">{formatInt(d.planned_runs)}</TableCell>
                      <TableCell align="right">{formatInt(d.runs_profiled)}</TableCell>
                      <TableCell align="right">
                        {d.history_days === null ? 'No history' : daysText(d.history_days)}
                      </TableCell>
                      <TableCell>
                        {d.low_confidence ? (
                          <Chip size="small" color="warning" variant="outlined" label="Low confidence" />
                        ) : (
                          'Normal'
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {d.slot_minutes === null ? UNKNOWN : formatInt(Math.round(d.slot_minutes))}
                      </TableCell>
                      <TableCell align="right">
                        {d.peak_slots === null ? UNKNOWN : formatCount(d.peak_slots)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        </Stack>
      )}
    </Panel>
  );
}

function PoolsPanel({ f }: { f: Forecast }) {
  const time = useTimeFormat();
  const zone = time.zoneName(f.pools.find((p) => p.peak_at !== null)?.peak_at ?? f.horizon.from);
  return (
    <Panel
      explanation={X['fc-pools']}
      actions={
        <ExportCsvButton
          view="forecast-pools"
          what="Pool demand forecast"
          rows={f.pools}
          columns={POOL_CSV}
        />
      }
    >
      {f.pools.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No pool demand to forecast: no planned run uses a pool in the next 24 hours.
        </Typography>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Pool demand forecast">
            <TableHead>
              <TableRow>
                <TableCell>Pool</TableCell>
                <TableCell align="right">Slots</TableCell>
                <TableCell align="right">Peak demand (p50)</TableCell>
                <TableCell>{`Peak at (${zone})`}</TableCell>
                <TableCell align="right">Time over its size</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {f.pools.map((p) => (
                <TableRow key={p.name}>
                  <TableCell sx={MONO}>{p.name}</TableCell>
                  <TableCell align="right">{formatInt(p.slots)}</TableCell>
                  <TableCell align="right">{formatCount(p.peak_slots)}</TableCell>
                  <TableCell>{p.peak_at === null ? NO_DATA : time.dayClock(p.peak_at)}</TableCell>
                  <TableCell align="right">
                    {p.minutes_over === null ? NO_DATA : `${formatInt(p.minutes_over)} min`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Panel>
  );
}

export function ForecastTab({ f, linkTo }: { f: Forecast; linkTo: PageProps['linkTo'] }) {
  return (
    <Stack spacing={4}>
      <HorizonText f={f} />
      <ConfidenceAlert f={f} />
      {f.evaluated && (
        <>
          <Kpis f={f} />
          <DemandPanel f={f} />
          <WindowsPanel f={f} linkTo={linkTo} />
          <DagsPanel f={f} linkTo={linkTo} />
          <PoolsPanel f={f} />
        </>
      )}
      <ProvenanceFooter
        dataAsOf={f.data_as_of}
        sources={f.sources}
        note={`an estimate (${f.method}) from up to ${f.history.read_days} days of task history; data as of is the newest task try read`}
      />
    </Stack>
  );
}
