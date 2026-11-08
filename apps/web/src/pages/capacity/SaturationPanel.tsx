/**
 * Saturation heatmap (FR-ENV-02): each UTC day × hour coloured by utilisation, minutes at max workers or
 * capacity-bound minutes, with capacity-bound hours marked. The metric, the table view and the selected cell are
 * in the URL (FR-UI-02). Hours are UTC, as the contract's heatmap is; hours never observed are empty (NFR-DATA-03),
 * and utilisation without worker_concurrency is unknown (HM-032). Its table view exports as CSV in either
 * view, an hour per row (FR-STORE-04).
 *
 * @implements FR-ENV-02, HM-011, FR-UI-02, FR-UI-06, NFR-DATA-03, FR-STORE-04
 */
import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { Capacity } from '@dcam/contracts';
import { isoUtc, type CsvColumn } from '../../components/csv';
import { ExportCsvButton } from '../../components/ExportCsv';
import { formatInt, formatShare } from '../../components/format';
import { Panel } from '../../components/Panel';
import { UTC_TIME } from '../../components/time';
import { usePageParam } from '../../components/view';
import { CAPACITY_EXPLANATIONS as X } from './explanations';
import { NO_DATA } from './format';
import { HeatLegend, HourGrid, type GridCell } from './HourGrid';

type Cell = Capacity['heatmap']['cells'][number];
type Metric = 'utilisation' | 'at-max' | 'bound';

const METRICS: Readonly<
  Record<
    Metric,
    {
      readonly title: string;
      readonly button: string;
      readonly value: (c: Cell) => number | null;
      readonly scale: (v: number) => number;
      readonly format: (v: number) => string;
      readonly low: string;
      readonly high: string;
    }
  >
> = {
  utilisation: {
    title: 'Worker slot utilisation',
    button: 'Utilisation',
    value: (c) => c.utilisation_mean,
    scale: (v) => v,
    format: (v) => formatShare(v),
    low: '0%',
    high: '100% of worker slots',
  },
  'at-max': {
    title: 'Minutes at max workers',
    button: 'Minutes at max workers',
    value: (c) => c.minutes_at_max,
    scale: (v) => v / 60,
    format: (v) => `${formatInt(v)} min`,
    low: '0 min',
    high: '60 min in the hour',
  },
  bound: {
    title: 'Capacity-bound minutes',
    button: 'Capacity-bound minutes',
    value: (c) => c.capacity_bound_minutes,
    scale: (v) => v / 60,
    format: (v) => `${formatInt(v)} min`,
    low: '0 min',
    high: '60 min in the hour',
  },
};
const isMetric = (v: string): v is Metric => Object.hasOwn(METRICS, v);

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (c: Pick<Cell, 'date' | 'hour'>) => `${c.date}T${pad(c.hour)}`;
const dayOf = (date: string) => UTC_TIME.day(`${date}T00:00:00Z`);
/** "5 Nov, 02:00 UTC". */
const hourText = (c: Pick<Cell, 'date' | 'hour'>) => `${dayOf(c.date)}, ${pad(c.hour)}:00 UTC`;
const orUnknown = (v: number | null, f: (v: number) => string) => (v === null ? 'unknown' : f(v));

/** The saturation table as CSV: one UTC hour per row, as the table lists them. */
const CELL_CSV: readonly CsvColumn<Cell>[] = [
  { name: 'hour_start_utc', value: (c) => isoUtc(`${c.date}T${pad(c.hour)}:00:00Z`) },
  { name: 'observed_minutes', value: (c) => c.observed_minutes },
  { name: 'utilisation_mean_ratio', value: (c) => c.utilisation_mean },
  { name: 'minutes_at_max_workers', value: (c) => c.minutes_at_max },
  { name: 'capacity_bound_minutes', value: (c) => c.capacity_bound_minutes },
];

/** The cell's figures in words: its accessible name. */
function cellName(c: Cell): string {
  if (c.observed_minutes === 0) return `${hourText(c)}: no data, not observed`;
  const parts = [
    `utilisation ${orUnknown(c.utilisation_mean, formatShare)}`,
    c.minutes_at_max === null
      ? 'minutes at max workers unknown'
      : `${formatInt(c.minutes_at_max)} min at max workers`,
    c.capacity_bound_minutes === null
      ? 'capacity-bound unknown'
      : `${formatInt(c.capacity_bound_minutes)} capacity-bound min`,
  ];
  if (c.observed_minutes < 60) parts.push(`${formatInt(c.observed_minutes)} of 60 min observed`);
  return `${hourText(c)}: ${parts.join(', ')}`;
}

function selectedText(c: Cell): string {
  const end = `${pad((c.hour + 1) % 24)}:00`;
  if (c.observed_minutes === 0)
    return `Selected: ${dayOf(c.date)}, ${pad(c.hour)}:00–${end} UTC. Not observed: no data.`;
  return (
    `Selected: ${dayOf(c.date)}, ${pad(c.hour)}:00–${end} UTC. ${formatInt(c.observed_minutes)} of 60 minutes observed; ` +
    `utilisation ${orUnknown(c.utilisation_mean, formatShare)}; ` +
    `${orUnknown(c.minutes_at_max, formatInt)} min at max workers; ` +
    `${orUnknown(c.capacity_bound_minutes, formatInt)} capacity-bound min.`
  );
}

export function SaturationPanel({ c }: { c: Capacity }) {
  const [metricParam, setMetric] = usePageParam('metric', 'utilisation');
  const metric: Metric = isMetric(metricParam) ? metricParam : 'utilisation';
  const [view, setView] = usePageParam('heatmap', 'chart');
  const asTable = view === 'table';
  const [selected, setSelected] = usePageParam('cell', '');
  const m = METRICS[metric];
  const cells = c.heatmap.cells;
  const rows = useMemo(
    () => [...new Set(cells.map((x) => x.date))].sort().map((date) => ({ key: date, label: dayOf(date) })),
    [cells],
  );
  const grid: GridCell[] = cells.map((x) => {
    const v = x.observed_minutes === 0 ? null : m.value(x);
    return {
      key: keyOf(x),
      row: x.date,
      hour: x.hour,
      t: v === null ? null : m.scale(v),
      label: cellName(x),
      marked: (x.capacity_bound_minutes ?? 0) > 0,
    };
  });
  const busiest = cells.reduce<{ cell: Cell; v: number } | null>((best, x) => {
    const v = x.observed_minutes === 0 ? null : m.value(x);
    return v !== null && (best === null || v > best.v) ? { cell: x, v } : best;
  }, null);
  const observed = cells.some((x) => x.observed_minutes > 0);
  const utilisationUnknown =
    metric === 'utilisation' && observed && cells.every((x) => x.utilisation_mean === null);
  const label = `${m.title} by UTC day and hour. ${
    busiest ? `Busiest: ${hourText(busiest.cell)} at ${m.format(busiest.v)}.` : 'No observed hour.'
  }${cells.some((x) => (x.capacity_bound_minutes ?? 0) > 0) ? ' Outlined hours had capacity-bound minutes.' : ''}`;
  const chosen = cells.find((x) => keyOf(x) === selected);

  return (
    <Panel
      explanation={X['cap-saturation']}
      actions={
        <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={metric}
            aria-label="Colour by"
            onChange={(_e, next: Metric | null) => next && setMetric(next)}
          >
            {(Object.keys(METRICS) as Metric[]).map((k) => (
              <ToggleButton key={k} value={k}>
                {METRICS[k].button}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Button size="small" onClick={() => setView(asTable ? 'chart' : 'table')}>
            {asTable ? 'View as a heatmap' : 'View as a table'}
          </Button>
          <ExportCsvButton
            view="capacity-saturation"
            what="Saturation by UTC day and hour"
            rows={cells}
            columns={CELL_CSV}
          />
        </Stack>
      }
    >
      <Stack spacing={2}>
        {cells.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No hour of this range has worker figures yet. They appear after the first Cloud Monitoring samples
            or live snapshots.
          </Typography>
        ) : asTable ? (
          <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
            <Table size="small" stickyHeader aria-label="Saturation by UTC day and hour">
              <TableHead>
                <TableRow>
                  <TableCell>Hour (UTC)</TableCell>
                  <TableCell align="right">Observed minutes</TableCell>
                  <TableCell align="right">Utilisation</TableCell>
                  <TableCell align="right">Minutes at max workers</TableCell>
                  <TableCell align="right">Capacity-bound minutes</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {cells.map((x) => (
                  <TableRow key={keyOf(x)}>
                    <TableCell>{`${dayOf(x.date)}, ${pad(x.hour)}:00`}</TableCell>
                    <TableCell align="right">{formatInt(x.observed_minutes)}</TableCell>
                    <TableCell align="right">
                      {x.utilisation_mean === null ? NO_DATA : formatShare(x.utilisation_mean)}
                    </TableCell>
                    <TableCell align="right">
                      {x.minutes_at_max === null ? NO_DATA : formatInt(x.minutes_at_max)}
                    </TableCell>
                    <TableCell align="right">
                      {x.capacity_bound_minutes === null ? NO_DATA : formatInt(x.capacity_bound_minutes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        ) : (
          <>
            <HeatLegend low={m.low} high={m.high} marked="Capacity-bound minutes in the hour" />
            <HourGrid
              rows={rows}
              cells={grid}
              label={label}
              selected={selected || null}
              onSelect={(key) => setSelected(key === selected ? '' : key)}
            />
          </>
        )}
        {utilisationUnknown && (
          <Typography variant="body2" color="text.secondary">
            Utilisation needs worker_concurrency, which is not known.{' '}
            <Link
              component="button"
              type="button"
              onClick={() => setMetric('at-max')}
              sx={{ verticalAlign: 'baseline' }}
            >
              Colour by minutes at max workers instead.
            </Link>
          </Typography>
        )}
        {chosen && !asTable && (
          <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Typography variant="body2" role="status">
              {selectedText(chosen)}
            </Typography>
            <Button size="small" onClick={() => setSelected('')}>
              Clear selection
            </Button>
          </Stack>
        )}
        <Typography variant="caption" color="text.secondary">
          Hours are UTC, whatever the time zone toggle says.
        </Typography>
      </Stack>
    </Panel>
  );
}
