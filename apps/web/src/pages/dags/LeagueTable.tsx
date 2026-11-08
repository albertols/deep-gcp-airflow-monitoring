/**
 * The virtualised, sortable league table: only the rows in view are in the DOM, so sorting, filtering
 * and scrolling stay responsive at 5,000 DAGs (NFR-PERF-03). Every column header has an (i). Rows can be
 * picked to compare (FR-DAGD-08).
 *
 * @implements FR-DAGX-01, FR-DAGX-02, FR-DAGD-08, FR-UI-05
 */
import { memo, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Checkbox from '@mui/material/Checkbox';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import Typography from '@mui/material/Typography';
import type { DagLeagueRow } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import {
  describeQuantile,
  formatInt,
  formatQuantile,
  formatShare,
  formatSlotHours,
} from '../../components/format';
import type { Route } from '../../router';
import { DAG_EXPLANATIONS, type DagExplanationId } from './explanations';
import { shareChangePoints, type SortKey, type SortState } from './league';

const ROW_HEIGHT = 44;
const VIEWPORT_HEIGHT = 560;
const MONO = '"Roboto Mono", ui-monospace, monospace';
const points = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});

interface Column {
  readonly key: SortKey;
  readonly explanation: DagExplanationId;
  readonly numeric: boolean;
  readonly width: string;
}

const COLUMNS: readonly Column[] = [
  { key: 'dag_id', explanation: 'dagx-col-dag', numeric: false, width: '16%' },
  { key: 'team', explanation: 'dagx-col-team', numeric: false, width: '9%' },
  { key: 'runs', explanation: 'dagx-col-runs', numeric: true, width: '6%' },
  { key: 'success_rate', explanation: 'dagx-col-success', numeric: true, width: '7%' },
  { key: 'flaky_rate', explanation: 'dagx-col-flaky', numeric: true, width: '6%' },
  { key: 'run_duration_p95', explanation: 'dagx-col-duration', numeric: true, width: '8%' },
  { key: 'executor_slot_seconds', explanation: 'dagx-col-slot-hours', numeric: true, width: '8%' },
  { key: 'share', explanation: 'dagx-col-share', numeric: true, width: '10%' },
  { key: 'queue_wait_p95', explanation: 'dagx-col-queue', numeric: true, width: '8%' },
  { key: 'ready_wait_p95', explanation: 'dagx-col-ready', numeric: true, width: '8%' },
  { key: 'peak_concurrency', explanation: 'dagx-col-peak', numeric: true, width: '7%' },
  { key: 'open_findings', explanation: 'dagx-col-findings', numeric: true, width: '7%' },
];

/**
 * Change of share in percentage points, with a text label so colour is never the only cue. A DAG
 * absent from the previous period is "new" only where DCAM has history for that period: no data is not
 * "did not run".
 */
function ShareChange({ row, previousCoverage }: { row: DagLeagueRow; previousCoverage: number }) {
  const change = shareChangePoints(row);
  let text: string;
  let title: string;
  if (change !== null) {
    text = `${points.format(Math.abs(change) < 0.05 ? 0 : change)} pp`;
    title = `Previous period: ${formatShare(row.previous_share)}`;
  } else if (previousCoverage <= 0) {
    text = '—';
    title = 'No data for the previous period';
  } else {
    text = 'new';
    title =
      previousCoverage >= 1
        ? 'Did not run in the previous period'
        : `Did not run in the ${formatShare(previousCoverage)} of the previous period with data`;
  }
  return (
    <Typography component="span" variant="caption" color="text.secondary" title={title} sx={{ ml: 1 }}>
      {text}
    </Typography>
  );
}

const cellSx = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  height: ROW_HEIGHT,
  py: 0,
};

/** Rows picked for S-14 Compare DAGs (FR-DAGD-08): at most four; the others are disabled once four are. */
export interface LeagueSelection {
  readonly selected: ReadonlySet<string>;
  readonly full: boolean;
  readonly onToggle: (dagId: string) => void;
}

const LeagueRow = memo(function LeagueRow({
  row,
  index,
  linkTo,
  previousCoverage,
  checked,
  disabled,
  onToggle,
}: {
  row: DagLeagueRow;
  index: number;
  linkTo: (route: Route) => string;
  previousCoverage: number;
  checked?: boolean;
  disabled?: boolean;
  onToggle?: ((dagId: string) => void) | undefined;
}) {
  // HM-015: task instances inferred flaky from the try number make the flaky rate an upper bound.
  const inferred = row.flaky_inferred ?? 0;
  return (
    <TableRow hover aria-rowindex={index + 2} selected={checked === true}>
      {onToggle && (
        <TableCell padding="checkbox" sx={{ height: ROW_HEIGHT, py: 0 }}>
          <Checkbox
            size="small"
            checked={checked === true}
            disabled={disabled === true}
            onChange={() => onToggle(row.dag_id)}
            slotProps={{ input: { 'aria-label': `Select ${row.dag_id} to compare` } }}
          />
        </TableCell>
      )}
      <TableCell sx={cellSx} title={row.dag_id}>
        <Link href={linkTo({ page: 'dag', dagId: row.dag_id })} sx={{ fontFamily: MONO }}>
          {row.dag_id}
        </Link>
        {row.paused && (
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
            paused
          </Typography>
        )}
      </TableCell>
      <TableCell sx={cellSx} title={row.team}>
        {row.team}
      </TableCell>
      <TableCell sx={cellSx} align="right" title={`${formatInt(row.failed_runs)} failed`}>
        {formatInt(row.runs)}
      </TableCell>
      <TableCell sx={cellSx} align="right">
        {formatShare(row.success_rate)}
      </TableCell>
      <TableCell
        sx={cellSx}
        align="right"
        title={
          row.flaky_rate === null
            ? `Fewer than 20 task instances; ${formatInt(row.retries)} retries in ${formatInt(row.tries)} tries`
            : `${formatInt(row.retries)} retries in ${formatInt(row.tries)} tries${
                inferred > 0
                  ? `; at most this flaky: ${formatInt(inferred)} inferred from the try number, which clearing a task also raises`
                  : ''
              }`
        }
      >
        {row.flaky_rate !== null && inferred > 0
          ? `≤ ${formatShare(row.flaky_rate)}`
          : formatShare(row.flaky_rate)}
      </TableCell>
      <TableCell sx={cellSx} align="right" title={describeQuantile(row.run_duration_p95)}>
        {formatQuantile(row.run_duration_p95)}
      </TableCell>
      <TableCell sx={cellSx} align="right">
        {formatSlotHours(row.executor_slot_seconds)}
      </TableCell>
      <TableCell sx={cellSx} align="right">
        {formatShare(row.share)}
        <ShareChange row={row} previousCoverage={previousCoverage} />
      </TableCell>
      <TableCell sx={cellSx} align="right" title={describeQuantile(row.queue_wait_p95)}>
        {formatQuantile(row.queue_wait_p95)}
      </TableCell>
      <TableCell sx={cellSx} align="right" title={describeQuantile(row.ready_wait_p95)}>
        {formatQuantile(row.ready_wait_p95)}
      </TableCell>
      <TableCell sx={cellSx} align="right">
        {formatInt(row.peak_concurrency)}
      </TableCell>
      <TableCell sx={cellSx} align="right">
        {formatInt(row.open_findings)}
      </TableCell>
    </TableRow>
  );
});

export function LeagueTable({
  rows,
  sort,
  onSort,
  linkTo,
  resetKey,
  previousCoverage,
  selection,
}: {
  rows: readonly DagLeagueRow[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  linkTo: (route: Route) => string;
  /** Share of the previous period with collected history (0–1). */
  previousCoverage: number;
  /** Changes when the user sorts or filters; a background refresh keeps the scroll position. */
  resetKey: string;
  /** Adds a first column of checkboxes that pick DAGs to compare (FR-DAGD-08). */
  selection?: LeagueSelection;
}) {
  const columnCount = COLUMNS.length + (selection ? 1 : 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // TanStack Virtual returns fresh functions every render; this component does not memoise them.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  // A new sort or filter starts at the top of the list.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [resetKey]);
  const items = virtualizer.getVirtualItems();
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0));

  return (
    <TableContainer
      ref={scrollRef}
      tabIndex={0}
      role="region"
      aria-label="DAG rows, scrollable"
      sx={{ maxHeight: VIEWPORT_HEIGHT, overflow: 'auto' }}
    >
      <Table
        stickyHeader
        size="small"
        aria-label="DAG league table"
        aria-rowcount={rows.length + 1}
        sx={{ tableLayout: 'fixed', minWidth: selection ? 1368 : 1320 }}
      >
        <TableHead>
          <TableRow aria-rowindex={1}>
            {selection && (
              <TableCell padding="checkbox" sx={{ width: 48, verticalAlign: 'bottom' }}>
                <Typography variant="caption" color="text.secondary">
                  Compare
                </Typography>
              </TableCell>
            )}
            {COLUMNS.map((c) => {
              const e = DAG_EXPLANATIONS[c.explanation];
              const active = sort.key === c.key;
              return (
                <TableCell
                  key={c.key}
                  align={c.numeric ? 'right' : 'left'}
                  sortDirection={active ? sort.direction : false}
                  sx={{ width: c.width, verticalAlign: 'bottom' }}
                >
                  <Stack
                    direction="row"
                    sx={{ alignItems: 'center', justifyContent: c.numeric ? 'flex-end' : 'flex-start' }}
                  >
                    <TableSortLabel
                      active={active}
                      direction={active ? sort.direction : c.numeric ? 'desc' : 'asc'}
                      onClick={() => onSort(c.key)}
                      aria-label={`Sort by ${e.title}`}
                    >
                      {e.title}
                    </TableSortLabel>
                    <InfoPopover explanation={e} />
                  </Stack>
                </TableCell>
              );
            })}
          </TableRow>
        </TableHead>
        <TableBody>
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columnCount} style={{ height: paddingTop, padding: 0, border: 0 }} />
            </tr>
          )}
          {items.map((v) => {
            const row = rows[v.index];
            const checked = selection?.selected.has(row?.dag_id ?? '') ?? false;
            return row ? (
              <LeagueRow
                key={row.dag_id}
                row={row}
                index={v.index}
                linkTo={linkTo}
                previousCoverage={previousCoverage}
                checked={checked}
                disabled={selection ? selection.full && !checked : false}
                onToggle={selection?.onToggle}
              />
            ) : null;
          })}
          {paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columnCount} style={{ height: paddingBottom, padding: 0, border: 0 }} />
            </tr>
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/** Default direction when a column is first chosen: numbers largest first, text A to Z. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  const numeric = COLUMNS.find((c) => c.key === key)?.numeric ?? true;
  return { key, direction: numeric ? 'desc' : 'asc' };
}
