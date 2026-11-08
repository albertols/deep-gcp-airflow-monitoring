/**
 * Rows × 24 hours heatmap (FR-ENV-02 saturation, FR-DAGX-06 load by DAG). Each cell is a button named with its
 * figures, so the heatmap is keyboard-operable and readable without colour (§12.11); the selected cell is the
 * caller's (in the URL). Colours come from the viridis scale for the current theme (FR-UI-06); unobserved or
 * unknown cells are dashed outlines without fill, never the lowest colour (NFR-DATA-03); marked cells (for
 * example capacity-bound hours) carry an inner outline as well as their colour.
 *
 * @implements FR-ENV-02, FR-DAGX-06, FR-UI-06, NFR-DATA-03, NFR-A11Y-01
 */
import { Fragment } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { heatColour } from './heat-scale';

export interface GridRow {
  readonly key: string;
  readonly label: string;
  /** Full text when the label is cut short (long DAG IDs). */
  readonly title?: string;
}

export interface GridCell {
  /** The selection key, for example `2026-11-05T02`. */
  readonly key: string;
  readonly row: string;
  readonly hour: number;
  /** Position on the scale, 0 to 1; `null` draws an empty cell. */
  readonly t: number | null;
  /** Accessible name: the cell's figures in words. */
  readonly label: string;
  readonly marked?: boolean;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const pad = (n: number) => String(n).padStart(2, '0');

export function HourGrid({
  rows,
  cells,
  label,
  selected,
  onSelect,
  rowLabelWidth = 72,
}: {
  rows: readonly GridRow[];
  cells: readonly GridCell[];
  /** Accessible description of the whole heatmap. */
  label: string;
  selected: string | null;
  onSelect: (key: string) => void;
  rowLabelWidth?: number;
}) {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const byPosition = new Map(cells.map((c) => [`${c.row}|${c.hour}`, c]));
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Box
        role="group"
        aria-label={label}
        sx={{
          display: 'grid',
          gridTemplateColumns: `${rowLabelWidth}px repeat(24, minmax(12px, 1fr))`,
          gap: '2px',
          minWidth: rowLabelWidth + 24 * 14,
          alignItems: 'center',
          '& .hour': { fontSize: 10, color: 'text.secondary', textAlign: 'left' },
          '& .row-label': {
            fontSize: 12,
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            pr: 1,
          },
          '& .cell': {
            height: 18,
            minWidth: 0,
            border: 0,
            p: 0,
            borderRadius: '2px',
            cursor: 'pointer',
          },
          '& .cell[data-empty="true"]': { border: `1px dashed ${theme.palette.divider}` },
          '& .cell[data-bound="true"]': { boxShadow: `inset 0 0 0 2px ${theme.palette.text.primary}` },
          '& .cell[aria-pressed="true"]': {
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: '1px',
          },
          '& .cell:focus-visible': {
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: '1px',
          },
        }}
      >
        <span aria-hidden />
        {HOURS.map((h) => (
          <span key={`h${h}`} className="hour" aria-hidden>
            {h % 3 === 0 ? pad(h) : ''}
          </span>
        ))}
        {rows.map((r) => (
          <Fragment key={r.key}>
            <span className="row-label" title={r.title ?? r.label}>
              {r.label}
            </span>
            {HOURS.map((h) => {
              const c = byPosition.get(`${r.key}|${h}`);
              if (!c) return <span key={h} aria-hidden />;
              const empty = c.t === null;
              return (
                <button
                  key={h}
                  type="button"
                  className="cell"
                  aria-label={c.label}
                  aria-pressed={selected === c.key}
                  data-empty={empty ? 'true' : undefined}
                  data-bound={c.marked ? 'true' : undefined}
                  style={{ backgroundColor: c.t === null ? 'transparent' : heatColour(c.t, mode) }}
                  onClick={() => onSelect(c.key)}
                />
              );
            })}
          </Fragment>
        ))}
      </Box>
    </Box>
  );
}

/** The scale as a gradient with its ends, and what empty and marked cells mean. */
export function HeatLegend({
  low,
  high,
  marked,
}: {
  low: string;
  high: string;
  /** What a marked cell means, for example "Capacity-bound minutes in the hour". */
  marked?: string;
}) {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const gradient = [0, 0.25, 0.5, 0.75, 1].map((t) => heatColour(t, mode)).join(', ');
  const swatch = { width: 12, height: 12, borderRadius: '2px', flexShrink: 0 } as const;
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Typography variant="caption" color="text.secondary">
        {low}
      </Typography>
      <Box
        aria-hidden
        sx={{
          width: 120,
          height: 10,
          borderRadius: '2px',
          background: `linear-gradient(to right, ${gradient})`,
        }}
      />
      <Typography variant="caption" color="text.secondary">
        {high}
      </Typography>
      <Box aria-hidden sx={{ ...swatch, border: `1px dashed ${theme.palette.divider}` }} />
      <Typography variant="caption" color="text.secondary">
        No data
      </Typography>
      {marked && (
        <>
          <Box
            aria-hidden
            sx={{
              ...swatch,
              bgcolor: heatColour(0.5, mode),
              boxShadow: `inset 0 0 0 2px ${theme.palette.text.primary}`,
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {marked}
          </Typography>
        </>
      )}
    </Stack>
  );
}
