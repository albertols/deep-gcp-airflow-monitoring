/**
 * Lines over evenly spaced points (time buckets, hours of the day, duration bins) on the design tokens
 * (spec §12.8): one y-axis, horizontal reference lines for limits, a hover tooltip per point, and a
 * legend that repeats each line's dash and marker, so colour is never the only cue. `null` breaks the
 * line: a gap is never drawn as zero (NFR-DATA-03). Callers give the chart an accessible description and
 * offer a table view.
 *
 * @implements NFR-DATA-03, NFR-A11Y-01
 */
import { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { Axes, CHART_MARGIN as M, ChartTooltip, niceMax, useWidth } from './charts';
import type { Marker } from './series';

export interface Line {
  readonly key: string;
  readonly label: string;
  /** One value per point; `null` is a gap. */
  readonly values: readonly (number | null)[];
  readonly color: string;
  /** SVG `stroke-dasharray`; `none` (the default) is solid. */
  readonly dash?: string;
  readonly marker?: Marker;
}

/** A horizontal line at a limit, such as `max_active_tasks` or a pool's size. */
export interface Reference {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly color: string;
  readonly dash?: string;
}

/** Markers are drawn at every point up to this many points; beyond, only where a point stands alone. */
const MARKER_POINTS = 48;

function MarkerShape({
  marker,
  x,
  y,
  color,
  size = 3.5,
}: {
  marker: Marker;
  x: number;
  y: number;
  color: string;
  size?: number;
}) {
  switch (marker) {
    case 'square':
      return <rect x={x - size} y={y - size} width={size * 2} height={size * 2} fill={color} />;
    case 'triangle':
      return (
        <polygon
          points={`${x},${y - size * 1.2} ${x + size * 1.1},${y + size * 0.9} ${x - size * 1.1},${y + size * 0.9}`}
          fill={color}
        />
      );
    case 'diamond':
      return (
        <polygon
          points={`${x},${y - size * 1.3} ${x + size * 1.1},${y} ${x},${y + size * 1.3} ${x - size * 1.1},${y}`}
          fill={color}
        />
      );
    case 'circle':
      return <circle cx={x} cy={y} r={size} fill={color} />;
  }
}

/** Runs of consecutive non-null points: each is drawn as its own path. */
export function segments(values: readonly (number | null)[]): number[][] {
  const out: number[][] = [];
  let current: number[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (current.length) out.push(current);
      current = [];
    } else current.push(i);
  });
  if (current.length) out.push(current);
  return out;
}

export function LineLegend({
  lines,
  references = [],
  label,
}: {
  lines: readonly Line[];
  references?: readonly Reference[];
  label: string;
}) {
  const items = [
    ...lines.map((l) => ({ key: l.key, label: l.label, color: l.color, dash: l.dash, marker: l.marker })),
    ...references.map((r) => ({
      key: r.key,
      label: r.label,
      color: r.color,
      dash: r.dash,
      marker: undefined,
    })),
  ];
  return (
    <Box
      component="ul"
      aria-label={label}
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, listStyle: 'none', p: 0, m: 0 }}
    >
      {items.map((item) => (
        <Box component="li" key={item.key} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <svg width={28} height={12} aria-hidden="true">
            <line
              x1={1}
              x2={27}
              y1={6}
              y2={6}
              stroke={item.color}
              strokeWidth={2}
              strokeDasharray={item.dash ?? 'none'}
            />
            {item.marker && <MarkerShape marker={item.marker} x={14} y={6} color={item.color} size={3} />}
          </svg>
          <Typography variant="caption" color="text.secondary">
            {item.label}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

export function LineChart({
  count,
  lines,
  references = [],
  tick,
  title,
  format,
  label,
  height = 200,
}: {
  /** Number of points; every line has a value (or `null`) per point. */
  count: number;
  lines: readonly Line[];
  references?: readonly Reference[];
  /** The x-axis label of point `i`. */
  tick: (i: number) => string;
  /** The tooltip heading of point `i`. */
  title: (i: number) => string;
  /** Values with their unit, on the axis and in the tooltip. */
  format: (v: number) => string;
  /** Accessible description of the chart, generated from its data (spec §12.8). */
  label: string;
  height?: number;
}) {
  const theme = useTheme();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const band = count ? innerW / count : innerW;
  let top = 0;
  for (const l of lines) for (const v of l.values) if (v !== null && v > top) top = v;
  for (const r of references) top = Math.max(top, r.value);
  const max = niceMax(top * 1.05);
  const x = (i: number) => M.left + band * (i + 0.5);
  const y = (v: number) => M.top + innerH * (1 - Math.min(v, max) / max);
  const step = Math.max(1, Math.ceil(count / 6));
  const ticks = Array.from({ length: count }, (_, i) => i)
    .filter((i) => i % step === 0)
    .map((i) => ({ x: x(i), label: tick(i) }));

  return (
    <Stack spacing={1}>
      <Box ref={ref} sx={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
        <svg width={width} height={height} role="img" aria-label={label}>
          <Axes width={width} height={height} max={max} format={format} ticks={ticks} />
          {references.map((r) => (
            <line
              key={r.key}
              data-reference={r.key}
              x1={M.left}
              x2={width - M.right}
              y1={y(r.value)}
              y2={y(r.value)}
              stroke={r.color}
              strokeWidth={1.5}
              strokeDasharray={r.dash ?? '6 4'}
            />
          ))}
          {lines.map((l) => {
            const runs = segments(l.values);
            return (
              <g key={l.key} data-line={l.key}>
                {runs.map((run) =>
                  run.length === 1 ? null : (
                    <path
                      key={run[0]}
                      d={run.map((i, k) => `${k === 0 ? 'M' : 'L'}${x(i)},${y(l.values[i] ?? 0)}`).join(' ')}
                      fill="none"
                      stroke={l.color}
                      strokeWidth={2}
                      strokeDasharray={l.dash ?? 'none'}
                      strokeLinejoin="round"
                    />
                  ),
                )}
                {runs.flatMap((run) =>
                  run.length === 1 || (l.marker && count <= MARKER_POINTS)
                    ? run.map((i) => (
                        <MarkerShape
                          key={i}
                          marker={l.marker ?? 'circle'}
                          x={x(i)}
                          y={y(l.values[i] ?? 0)}
                          color={l.color}
                        />
                      ))
                    : [],
                )}
              </g>
            );
          })}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={M.top}
              y2={M.top + innerH}
              stroke={theme.palette.text.secondary}
              strokeWidth={1}
              opacity={0.5}
            />
          )}
          {Array.from({ length: count }, (_, i) => (
            <rect
              key={i}
              x={M.left + band * i}
              y={M.top}
              width={band}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hover !== null && (
          <ChartTooltip x={x(hover)} width={width}>
            <Typography variant="caption" component="p" sx={{ fontWeight: 500 }}>
              {title(hover)}
            </Typography>
            <Stack spacing={0.5} sx={{ mt: 1 }}>
              {lines.map((l) => {
                const v = l.values[hover] ?? null;
                return (
                  <Stack key={l.key} direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                    <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: l.color }} />
                    <Typography variant="caption" sx={{ flex: 1 }}>
                      {l.label}
                    </Typography>
                    <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {v === null ? 'No data' : format(v)}
                    </Typography>
                  </Stack>
                );
              })}
              {references.map((r) => (
                <Typography key={r.key} variant="caption" color="text.secondary">
                  {r.label}: {format(r.value)}
                </Typography>
              ))}
            </Stack>
          </ChartTooltip>
        )}
      </Box>
      <LineLegend lines={lines} references={references} label={`Legend: ${label.split(':')[0] ?? label}`} />
    </Stack>
  );
}
