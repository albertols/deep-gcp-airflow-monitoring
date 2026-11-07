/**
 * Hour-of-day × minute-of-hour heatmap (S-17, FR-BOTL-03): 24 rows by 60 columns on the design tokens,
 * one accessible description for the whole chart, a native tooltip per cell. Callers offer a table view.
 *
 * @implements FR-BOTL-03
 */
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { useWidth } from '../../components/charts';

export interface HeatCell {
  readonly hour: number;
  readonly minute: number;
  readonly value: number;
}

const LEFT = 40;
const TOP = 16;
const pad = (n: number) => String(n).padStart(2, '0');

export function Heatmap({
  cells,
  label,
  describe,
}: {
  cells: readonly HeatCell[];
  /** Accessible description of the whole chart. */
  label: string;
  /** Tooltip text of one cell. */
  describe: (c: HeatCell) => string;
}) {
  const theme = useTheme();
  const [ref, width] = useWidth<HTMLDivElement>();
  const cell = Math.max(4, Math.floor((width - LEFT) / 60));
  const rowHeight = Math.max(6, Math.min(14, cell));
  const height = TOP + 24 * rowHeight;
  const max = cells.reduce((m, c) => Math.max(m, c.value), 0);
  return (
    <Box ref={ref} sx={{ width: '100%', overflowX: 'auto' }}>
      <svg role="img" aria-label={label} width={LEFT + 60 * cell} height={height}>
        <g fontSize={10} fill={theme.palette.text.secondary}>
          {[0, 10, 20, 30, 40, 50].map((m) => (
            <text key={m} x={LEFT + m * cell} y={10}>
              :{pad(m)}
            </text>
          ))}
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
            <text key={h} x={LEFT - 6} y={TOP + h * rowHeight + rowHeight - 1} textAnchor="end">
              {pad(h)}:00
            </text>
          ))}
        </g>
        <rect
          x={LEFT}
          y={TOP}
          width={60 * cell}
          height={24 * rowHeight}
          fill="none"
          stroke={theme.palette.divider}
        />
        {cells.map((c) => (
          <rect
            key={`${c.hour}:${c.minute}`}
            x={LEFT + c.minute * cell}
            y={TOP + c.hour * rowHeight}
            width={Math.max(1, cell - 1)}
            height={Math.max(1, rowHeight - 1)}
            fill={theme.palette.primary.main}
            // A square-root scale keeps small cells visible next to a large collision.
            fillOpacity={max > 0 ? 0.15 + 0.85 * Math.sqrt(c.value / max) : 0}
          >
            <title>{describe(c)}</title>
          </rect>
        ))}
      </svg>
    </Box>
  );
}

export const cellTime = (c: Pick<HeatCell, 'hour' | 'minute'>) => `${pad(c.hour)}:${pad(c.minute)}`;
