/**
 * Treemap team → DAG sized by executor slot-seconds and coloured by p95 queue wait, as hand-written SVG
 * on the design tokens, with a legend, an accessible description and a table view that exports as CSV. A
 * team click filters to that team; a DAG tile opens the DAG.
 *
 * @implements FR-DAGX-04, FR-UI-02, FR-STORE-04
 */
import { useId, useMemo, type KeyboardEvent } from 'react';
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
import type { DagLeagueRow } from '@dcam/contracts';
import { tokens } from '@dcam/ui-kit';
import { quantileColumns, type CsvColumn } from '../../components/csv';
import { ExportCsvButton } from '../../components/ExportCsv';
import { formatInt, formatQuantile, formatShare, formatSlotHours } from '../../components/format';
import { usePageParam } from '../../components/view';
import type { Route } from '../../router';
import {
  QUEUE_WAIT_BANDS,
  queueWaitBand,
  treemapLayout,
  type QueueWaitBand,
  type TreemapTile,
} from './treemap-layout';

const WIDTH = 960;
const HEIGHT = 380;
const HEADER = 18;
const MAX_TILES = 150;
const TITLE = 'Capacity by team and DAG';

/** Fill and readable text colour per band, from the theme's tokens. */
function bandColours(mode: 'dark' | 'light'): Record<QueueWaitBand, { fill: string; text: string }> {
  const t = tokens[mode];
  const onStatus = mode === 'dark' ? t.bgCanvas : '#FFFFFF';
  return {
    low: { fill: t.statusOk, text: onStatus },
    medium: { fill: t.statusWarning, text: mode === 'dark' ? t.bgCanvas : t.textPrimary },
    high: { fill: t.statusError, text: onStatus },
    none: { fill: t.borderSubtle, text: t.textPrimary },
  };
}

const bandOf = (tile: TreemapTile): QueueWaitBand =>
  tile.row ? queueWaitBand(tile.row.queue_wait_p95) : 'none';

function tileLabel(tile: TreemapTile, total: number): string {
  const share = formatShare(total > 0 ? tile.value / total : 0);
  const hours = `${formatSlotHours(tile.value)} slot-hours (${share})`;
  if (!tile.row) return `${tile.team}: ${tile.label}, ${hours}`;
  return `${tile.label}, team ${tile.team}: ${hours}, p95 queue wait ${formatQuantile(tile.row.queue_wait_p95)}`;
}

const NO_QUANTILE = { value_seconds: null, samples: 0, low_sample: true } as const;

/**
 * The treemap table as CSV: one row per tile, a DAG or a team's "other" tile that folds its small DAGs
 * (`dag_count` of them), sized in executor slot-seconds (HM-003).
 */
const treemapCsv = (total: number): readonly CsvColumn<TreemapTile>[] => [
  { name: 'team', value: (t) => t.team },
  { name: 'tile', value: (t) => t.kind },
  { name: 'dag_id', value: (t) => (t.kind === 'dag' ? (t.row?.dag_id ?? t.label) : null) },
  { name: 'label', value: (t) => t.label },
  { name: 'dag_count', value: (t) => t.dagCount },
  { name: 'executor_slot_seconds', value: (t) => t.value },
  { name: 'share_ratio', value: (t) => (total > 0 ? t.value / total : null) },
  ...quantileColumns<TreemapTile>('queue_wait_p95', (t) => t.row?.queue_wait_p95 ?? NO_QUANTILE),
];

/** Truncates text to fit roughly `width` pixels at the label font size. */
function fit(text: string, width: number): string | null {
  const chars = Math.floor((width - 8) / 6.6);
  if (chars < 4) return null;
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}

export function Treemap({
  rows,
  team,
  onTeam,
  linkTo,
}: {
  rows: readonly DagLeagueRow[];
  team: string | null;
  onTeam: (team: string | null) => void;
  linkTo: (route: Route) => string;
}) {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const t = tokens[mode];
  const colours = bandColours(mode);
  const descId = useId();
  const [view, setView] = usePageParam('treemap', 'chart');
  const asTable = view === 'table';
  const groups = useMemo(
    () =>
      treemapLayout(
        rows,
        { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        { maxTiles: MAX_TILES, headerHeight: HEADER, padding: 2 },
      ),
    [rows],
  );
  const total = groups.reduce((s, g) => s + g.value, 0);
  const dagCount = groups.reduce((s, g) => s + g.dagCount, 0);
  const tiles = useMemo(() => groups.flatMap((g) => g.tiles), [groups]);
  const largest = groups.reduce<(typeof groups)[number] | null>(
    (m, g) => (m && m.value >= g.value ? m : g),
    null,
  );
  const description =
    groups.length === 0
      ? 'No DAG used executor slots in this range.'
      : `Treemap of ${formatInt(groups.length)} team${groups.length === 1 ? '' : 's'} and ${formatInt(dagCount)} DAG${dagCount === 1 ? '' : 's'}, sized by executor slot-hours and coloured by p95 queue wait. ` +
        `The largest team is ${largest?.team ?? ''} with ${formatShare(total > 0 ? (largest?.value ?? 0) / total : 0)}. ` +
        'Use "View treemap as table" for every value.';
  const onKey = (name: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onTeam(name);
    }
  };

  return (
    <Stack spacing={2}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}
      >
        <Box
          component="ul"
          aria-label="Treemap colours"
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, listStyle: 'none', m: 0, p: 0 }}
        >
          {QUEUE_WAIT_BANDS.map((b) => (
            <Box component="li" key={b.band} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box
                aria-hidden
                sx={{
                  width: 12,
                  height: 12,
                  borderRadius: 0.5,
                  bgcolor: colours[b.band].fill,
                  border: `1px solid ${t.borderSubtle}`,
                }}
              />
              <Typography variant="caption">{b.label}</Typography>
            </Box>
          ))}
          <Box component="li">
            <Typography variant="caption" color="text.secondary">
              Size: executor slot-hours
            </Typography>
          </Box>
        </Box>
        <Stack direction="row" sx={{ gap: 1 }}>
          {team !== null && (
            <Button size="small" onClick={() => onTeam(null)}>
              Show all teams
            </Button>
          )}
          <Button size="small" variant="outlined" onClick={() => setView(asTable ? 'chart' : 'table')}>
            {asTable ? 'View treemap as chart' : 'View treemap as table'}
          </Button>
          <ExportCsvButton view="dags-treemap" what={TITLE} rows={tiles} columns={treemapCsv(total)} />
        </Stack>
      </Stack>

      <Typography id={descId} variant="caption" color="text.secondary">
        {description}
      </Typography>

      {asTable ? (
        <TableContainer sx={{ maxHeight: HEIGHT }}>
          <Table size="small" stickyHeader aria-label={TITLE}>
            <TableHead>
              <TableRow>
                <TableCell>Team</TableCell>
                <TableCell>DAG</TableCell>
                <TableCell align="right">Slot-hours</TableCell>
                <TableCell align="right">Share</TableCell>
                <TableCell align="right">p95 queue wait</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {groups.flatMap((g) =>
                g.tiles.map((tile) => (
                  <TableRow key={tile.id}>
                    <TableCell>{g.team}</TableCell>
                    <TableCell sx={{ fontFamily: '"Roboto Mono", ui-monospace, monospace' }}>
                      {tile.label}
                    </TableCell>
                    <TableCell align="right">{formatSlotHours(tile.value)}</TableCell>
                    <TableCell align="right">{formatShare(total > 0 ? tile.value / total : 0)}</TableCell>
                    <TableCell align="right">
                      {tile.row ? formatQuantile(tile.row.queue_wait_p95) : '—'}
                    </TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <svg
          role="group"
          aria-label={TITLE}
          aria-describedby={descId}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          style={{ width: '100%', height: 'auto', display: 'block', fontFamily: theme.typography.fontFamily }}
        >
          {groups.map((g) => (
            <g key={g.team}>
              <rect
                x={g.x}
                y={g.y}
                width={g.width}
                height={g.height}
                fill={t.bgRaised}
                stroke={t.bgCanvas}
                strokeWidth={2}
              />
              <g
                role="button"
                tabIndex={0}
                aria-label={`Filter to team ${g.team}`}
                onClick={() => onTeam(g.team)}
                onKeyDown={onKey(g.team)}
                style={{ cursor: 'pointer' }}
              >
                <rect x={g.x} y={g.y} width={g.width} height={HEADER} fill={t.bgRaised} />
                <text x={g.x + 4} y={g.y + 13} fontSize={11} fill={t.textPrimary}>
                  {fit(`${g.team} · ${formatShare(total > 0 ? g.value / total : 0)}`, g.width) ?? ''}
                </text>
              </g>
              {g.tiles.map((tile) => {
                const c = colours[bandOf(tile)];
                const label = tileLabel(tile, total);
                const text = tile.height >= 16 ? fit(tile.label, tile.width) : null;
                const body = (
                  <>
                    <title>{label}</title>
                    <rect
                      x={tile.x}
                      y={tile.y}
                      width={Math.max(0, tile.width)}
                      height={Math.max(0, tile.height)}
                      fill={c.fill}
                      stroke={t.bgCanvas}
                      strokeWidth={1}
                    />
                    {text && (
                      <text x={tile.x + 4} y={tile.y + 13} fontSize={11} fill={c.text} pointerEvents="none">
                        {text}
                      </text>
                    )}
                  </>
                );
                return tile.kind === 'dag' ? (
                  <a key={tile.id} href={linkTo({ page: 'dag', dagId: tile.id })} aria-label={label}>
                    {body}
                  </a>
                ) : (
                  <g key={tile.id} aria-label={label} role="img">
                    {body}
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      )}
    </Stack>
  );
}
