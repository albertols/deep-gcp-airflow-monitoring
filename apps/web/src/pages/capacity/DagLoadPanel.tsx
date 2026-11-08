/**
 * Load by DAG and hour of day (FR-DAGX-06): the mean worker slots each of the top DAGs held in each UTC hour of
 * the day, over the hours of task history in the range. Hours without history are empty, not zero
 * (NFR-DATA-03). The table view and the selected cell are in the URL (FR-UI-02); a selection links to the DAG.
 *
 * @implements FR-DAGX-06, FR-UI-02, FR-UI-06, FR-UI-07, NFR-DATA-03
 */
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { Capacity } from '@dcam/contracts';
import { formatInt, formatShare, formatSlotHours } from '../../components/format';
import { Panel } from '../../components/Panel';
import { usePageParam } from '../../components/view';
import type { PageProps } from '../types';
import { CAPACITY_EXPLANATIONS as X } from './explanations';
import { formatCount } from './format';
import { HeatLegend, HourGrid, type GridCell } from './HourGrid';

type DagLoad = Capacity['dag_load'];

const MONO = { fontFamily: '"Roboto Mono", ui-monospace, monospace' } as const;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const pad = (n: number) => String(n).padStart(2, '0');
const upToOne = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const hoursOf = (n: number) => `${upToOne.format(n)} hour${n === 1 ? '' : 's'}`;
const keyOf = (dagId: string, hour: number) => `${pad(hour)}:${dagId}`;

function cellName(dagId: string, hour: number, v: number | null): string {
  return `${dagId}, ${pad(hour)}:00 UTC: ${v === null ? 'no task history' : `${formatCount(v)} slots on average`}`;
}

/** "Each cell averages 1 hour …", and how many hours of the day have none. */
function coverageText(load: DagLoad): string[] {
  const covered = load.covered_hours.filter((h) => h > 0);
  const lines: string[] = [];
  if (covered.length > 0) {
    const lo = Math.min(...covered);
    const hi = Math.max(...covered);
    lines.push(
      lo === hi
        ? `Each cell averages ${hoursOf(lo)} of task history in this range.`
        : `Each cell averages ${upToOne.format(lo)} to ${hoursOf(hi)} of task history in this range.`,
    );
  }
  const missing = load.covered_hours.length - covered.length;
  if (missing > 0)
    lines.push(
      missing === 1
        ? '1 hour of the day has no task history in this range: its cells are empty, not zero.'
        : `${formatInt(missing)} hours of the day have no task history in this range: their cells are empty, not zero.`,
    );
  return lines;
}

export function DagLoadPanel({ c, linkTo }: { c: Capacity; linkTo: PageProps['linkTo'] }) {
  const load = c.dag_load;
  const [view, setView] = usePageParam('dagload', 'chart');
  const asTable = view === 'table';
  const [selected, setSelected] = usePageParam('dagcell', '');
  const max = load.dags.reduce((m, d) => Math.max(m, ...d.hours.map((v) => v ?? 0)), 0);
  const cells: GridCell[] = load.dags.flatMap((d) =>
    HOURS.map((h) => {
      const v = d.hours[h] ?? null;
      return {
        key: keyOf(d.dag_id, h),
        row: d.dag_id,
        hour: h,
        t: v === null ? null : max > 0 ? v / max : 0,
        label: cellName(d.dag_id, h, v),
      };
    }),
  );
  let top: { dag: string; hour: number; v: number } | null = null;
  for (const d of load.dags)
    for (const h of HOURS) {
      const v = d.hours[h] ?? null;
      if (v !== null && v > 0 && (top === null || v > top.v)) top = { dag: d.dag_id, hour: h, v };
    }
  const label = `Mean worker slots by DAG and UTC hour of day: the top ${formatInt(load.dags.length)} of ${formatInt(load.dag_count)} DAGs. ${
    top ? `Busiest: ${top.dag} at ${pad(top.hour)}:00 UTC with ${formatCount(top.v)} slots.` : 'No slot time.'
  }`;
  const at = selected.indexOf(':');
  const selHour = at > 0 ? Number(selected.slice(0, at)) : NaN;
  const selDag = at > 0 ? load.dags.find((d) => d.dag_id === selected.slice(at + 1)) : undefined;
  const selValue = selDag && Number.isInteger(selHour) ? (selDag.hours[selHour] ?? null) : undefined;

  return (
    <Panel
      explanation={X['cap-dag-load']}
      actions={
        load.dags.length > 0 ? (
          <Button size="small" onClick={() => setView(asTable ? 'chart' : 'table')}>
            {asTable ? 'View as a heatmap' : 'View as a table'}
          </Button>
        ) : undefined
      }
    >
      {load.dags.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No DAG held a worker slot in this range. Widen the range, or check the task instance collector on
          DCAM health.
        </Typography>
      ) : (
        <Stack spacing={2}>
          {asTable ? (
            <Box sx={{ overflowX: 'auto', maxHeight: 480 }}>
              <Table size="small" stickyHeader aria-label="Load by DAG and UTC hour">
                <TableHead>
                  <TableRow>
                    <TableCell>DAG</TableCell>
                    <TableCell align="right">Share</TableCell>
                    <TableCell align="right">Slot-hours</TableCell>
                    {HOURS.map((h) => (
                      <TableCell key={h} align="right">{`${pad(h)}:00`}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {load.dags.map((d) => (
                    <TableRow key={d.dag_id}>
                      <TableCell sx={MONO}>{d.dag_id}</TableCell>
                      <TableCell align="right">{formatShare(d.share)}</TableCell>
                      <TableCell align="right">{formatSlotHours(d.executor_slot_seconds)}</TableCell>
                      {HOURS.map((h) => (
                        <TableCell key={h} align="right">
                          {formatCount(d.hours[h] ?? null)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          ) : (
            <>
              <HeatLegend low="0 slots" high={`${formatCount(max)} slots on average`} />
              <HourGrid
                rows={load.dags.map((d) => ({ key: d.dag_id, label: d.dag_id }))}
                cells={cells}
                label={label}
                selected={selected || null}
                onSelect={(key) => setSelected(key === selected ? '' : key)}
                rowLabelWidth={200}
              />
            </>
          )}
          {selDag && selValue !== undefined && !asTable && (
            <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
              <Typography variant="body2" role="status">
                Selected: {selDag.dag_id}, {pad(selHour)}:00–{pad((selHour + 1) % 24)}:00 UTC.{' '}
                {selValue === null
                  ? 'No task history in that hour'
                  : `${formatCount(selValue)} slots on average`}
                ; the DAG holds {formatShare(selDag.share)} of the executor slot time in this range.
              </Typography>
              <Link href={linkTo({ page: 'dag', dagId: selDag.dag_id })}>Open {selDag.dag_id}</Link>
              <Button size="small" onClick={() => setSelected('')}>
                Clear selection
              </Button>
            </Stack>
          )}
          {coverageText(load).map((line) => (
            <Typography key={line} variant="caption" color="text.secondary">
              {line}
            </Typography>
          ))}
          <Typography variant="caption" color="text.secondary">
            Hours are UTC. Computed from task tries ({load.method}) until 5-minute rollups exist.
          </Typography>
        </Stack>
      )}
    </Panel>
  );
}
