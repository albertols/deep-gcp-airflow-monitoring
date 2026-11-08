/**
 * A bucketed time chart for capacity and the forecast (spec §12.8): stacked bars, step or linear lines, an
 * optional band between two series, horizontal limit lines, and highlighted buckets that are shaded and hatched
 * with a marker strip and a title each, so colour is never the only cue (§12.11). `null` is a gap, never zero
 * (NFR-DATA-03). Callers give the chart an accessible description and offer a table view.
 *
 * @implements FR-ENV-02, HM-010, NFR-DATA-03, FR-UI-06
 */
import { useId, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import {
  Axes,
  CHART_MARGIN as M,
  ChartTooltip,
  bucketLabels,
  niceMax,
  useWidth,
} from '../../components/charts';
import { useTimeFormat } from '../../components/view';

type Values = readonly (number | null)[];

export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly values: Values;
  /** SVG dash pattern for lines, for example `6 3`. */
  readonly dash?: string;
}

export interface ChartArea {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly lower: Values;
  readonly upper: Values;
}

export interface ChartLimit {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly color: string;
  readonly dash: string;
}

export interface ChartHighlight {
  readonly index: number;
  /** The highlight's title, for example "Capacity-bound 02:00–02:15 UTC: 12 min". */
  readonly title: string;
  /** `strong`: shaded, hatched and marked; `light`: hatched only. */
  readonly kind?: 'strong' | 'light';
}

export interface TimeChartProps {
  readonly starts: readonly number[];
  readonly bucketMs: number;
  readonly label: string;
  readonly format: (v: number) => string;
  /** Stacked bottom-up in this order. */
  readonly bars?: readonly ChartSeries[];
  readonly lines?: readonly ChartSeries[];
  readonly area?: ChartArea;
  readonly limits?: readonly ChartLimit[];
  readonly highlights?: readonly ChartHighlight[];
  readonly highlightColor?: string;
  readonly curve?: 'step' | 'linear';
  readonly height?: number;
}

const at = (values: Values, i: number): number | null => values[i] ?? null;

/** Path segments through the non-null values; a null breaks the line. */
function linePath(
  values: Values,
  x: (i: number) => [number, number],
  y: (v: number) => number,
  curve: 'step' | 'linear',
): string {
  let d = '';
  let open = false;
  values.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    const [x0, x1] = x(i);
    if (curve === 'step') {
      d += `${open ? 'L' : 'M'}${x0},${y(v)}L${x1},${y(v)}`;
    } else {
      d += `${open ? 'L' : 'M'}${(x0 + x1) / 2},${y(v)}`;
    }
    open = true;
  });
  return d;
}

/** Closed areas over the runs of buckets where both bounds are known. */
function areaPath(area: ChartArea, x: (i: number) => [number, number], y: (v: number) => number): string {
  const runs: number[][] = [];
  let run: number[] = [];
  area.upper.forEach((u, i) => {
    if (u === null || at(area.lower, i) === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(i);
  });
  if (run.length) runs.push(run);
  return runs
    .map((r) => {
      const mid = (i: number) => (x(i)[0] + x(i)[1]) / 2;
      const top = r.map((i) => `${mid(i)},${y(at(area.upper, i) ?? 0)}`);
      const bottom = [...r].reverse().map((i) => `${mid(i)},${y(at(area.lower, i) ?? 0)}`);
      return `M${[...top, ...bottom].join('L')}Z`;
    })
    .join('');
}

export function TimeChart({
  starts,
  bucketMs,
  label,
  format,
  bars = [],
  lines = [],
  area,
  limits = [],
  highlights = [],
  highlightColor,
  curve = 'step',
  height = 240,
}: TimeChartProps) {
  const theme = useTheme();
  const hatch = useId().replace(/:/g, '');
  const labels = bucketLabels(useTimeFormat(), starts.length, bucketMs);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const band = starts.length ? innerW / starts.length : innerW;
  const stackAt = (i: number) => bars.reduce((s, b) => s + (at(b.values, i) ?? 0), 0);
  let top = 0;
  starts.forEach((_s, i) => {
    top = Math.max(top, stackAt(i), at(area?.upper ?? [], i) ?? 0);
    for (const l of lines) top = Math.max(top, at(l.values, i) ?? 0);
  });
  for (const l of limits) top = Math.max(top, l.value);
  const max = niceMax(top);
  const y = (v: number) => M.top + innerH * (1 - Math.min(v, max) / max);
  const x = (i: number): [number, number] => [M.left + band * i, M.left + band * (i + 1)];
  const step = Math.max(1, Math.ceil(starts.length / 6));
  const ticks = starts
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => i % step === 0)
    .map(({ s, i }) => ({ x: M.left + band * (i + 0.5), label: labels.tick(s) }));
  const color = highlightColor ?? theme.palette.error.main;
  const hovered = hover === null ? undefined : starts[hover];
  const valueText = (v: number | null) => (v === null ? 'No data' : format(v));

  return (
    <Box ref={ref} sx={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={label}>
        <defs>
          <pattern
            id={hatch}
            width={6}
            height={6}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1={0} y1={0} x2={0} y2={6} stroke={color} strokeWidth={2} strokeOpacity={0.55} />
          </pattern>
        </defs>
        {highlights.map((h) => {
          const [x0] = x(h.index);
          const strong = (h.kind ?? 'strong') === 'strong';
          return (
            <g key={`h${h.index}`} data-highlight={h.kind ?? 'strong'}>
              <title>{h.title}</title>
              {strong && (
                <rect x={x0} y={M.top} width={band} height={innerH} fill={color} fillOpacity={0.14} />
              )}
              <rect x={x0} y={M.top} width={band} height={innerH} fill={`url(#${hatch})`} />
              {strong && <rect x={x0} y={M.top} width={band} height={3} fill={color} />}
            </g>
          );
        })}
        <Axes width={width} height={height} max={max} format={format} ticks={ticks} />
        {area && <path d={areaPath(area, x, y)} fill={area.color} fillOpacity={0.22} stroke="none" />}
        {starts.map((s, i) => {
          let base = M.top + innerH;
          return (
            <g key={s} opacity={hover === null || hover === i ? 1 : 0.6}>
              {bars.map((b) => {
                const v = at(b.values, i);
                if (v === null || v <= 0) return null;
                const h = (Math.min(v, max) / max) * innerH;
                base -= h;
                return (
                  <rect
                    key={b.key}
                    x={x(i)[0] + (band > 4 ? 1 : 0)}
                    y={base}
                    width={Math.max(0.5, band - (band > 4 ? 2 : 0))}
                    height={h}
                    fill={b.color}
                  />
                );
              })}
            </g>
          );
        })}
        {limits.map((l) => (
          <g key={l.key}>
            <line
              x1={M.left}
              x2={width - M.right}
              y1={y(l.value)}
              y2={y(l.value)}
              stroke={l.color}
              strokeWidth={1.5}
              strokeDasharray={l.dash}
            />
            <text
              x={width - M.right - 4}
              y={y(l.value) - 4}
              textAnchor="end"
              fontSize={11}
              fill={theme.palette.text.secondary}
            >
              {l.label}
            </text>
          </g>
        ))}
        {lines.map((l) => (
          <path
            key={l.key}
            d={linePath(l.values, x, y, curve)}
            fill="none"
            stroke={l.color}
            strokeWidth={2}
            strokeDasharray={l.dash}
          />
        ))}
        {starts.map((s, i) => (
          <rect
            key={`hover${s}`}
            x={x(i)[0]}
            y={M.top}
            width={band}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {hovered !== undefined && hover !== null && (
        <ChartTooltip x={M.left + band * hover} width={width}>
          <Typography variant="caption" component="p" sx={{ fontWeight: 500 }}>
            {labels.range(hovered)}
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {highlights
              .filter((h) => h.index === hover)
              .map((h) => (
                <Typography key={h.title} variant="caption" sx={{ color }}>
                  {h.title}
                </Typography>
              ))}
            {[...bars, ...lines].map((sr) => (
              <Stack key={sr.key} direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: sr.color }} />
                <Typography variant="caption" sx={{ flex: 1 }}>
                  {sr.label}
                </Typography>
                <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {valueText(at(sr.values, hover))}
                </Typography>
              </Stack>
            ))}
            {area && (
              <Typography variant="caption">
                {area.label}: {valueText(at(area.lower, hover))} to {valueText(at(area.upper, hover))}
              </Typography>
            )}
          </Stack>
        </ChartTooltip>
      )}
    </Box>
  );
}

/** A legend entry for a line: its colour and dash, as drawn. */
export function LineKey({ color, dash, label }: { color: string; dash?: string; label: string }) {
  return (
    <Box component="li" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <svg width={18} height={10} aria-hidden>
        <line x1={0} x2={18} y1={5} y2={5} stroke={color} strokeWidth={2} strokeDasharray={dash} />
      </svg>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}

/** A legend entry for bars or an area: a filled square, hatched for highlights. */
export function SwatchKey({ color, label, hatched }: { color: string; label: string; hatched?: boolean }) {
  return (
    <Box component="li" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Box
        aria-hidden
        sx={{
          width: 10,
          height: 10,
          borderRadius: '2px',
          bgcolor: hatched ? 'transparent' : color,
          backgroundImage: hatched
            ? `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 5px)`
            : undefined,
          border: hatched ? `1px solid ${color}` : undefined,
        }}
      />
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}

/** The list that holds {@link LineKey} and {@link SwatchKey} entries. */
export function ChartKey({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box
      component="ul"
      aria-label={label}
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, listStyle: 'none', p: 0, m: 0 }}
    >
      {children}
    </Box>
  );
}
