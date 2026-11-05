/**
 * Small SVG charts on the design tokens (spec §12.8): one y-axis, recessive grid, thin marks with a
 * 2 px surface gap between stacked segments, a hover tooltip per bucket, gaps never drawn as zero.
 * Callers give each chart an accessible description and offer a table view.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';

const M = { top: 8, right: 8, bottom: 22, left: 68 };

/** Width of an element, following resizes (falls back to 720 px where ResizeObserver is missing). */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(240, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** 1, 2 or 5 × 10^k at or above `v`. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

export interface Series {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

export function Legend({ series, label }: { series: readonly Series[]; label: string }) {
  return (
    <Box
      component="ul"
      aria-label={label}
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, listStyle: 'none', p: 0, m: 0 }}
    >
      {series.map((s) => (
        <Box component="li" key={s.key} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box aria-hidden sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: s.color }} />
          <Typography variant="caption" color="text.secondary">
            {s.label}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(0, x + 12), Math.max(0, width - 240));
  return (
    <Paper
      role="status"
      elevation={4}
      sx={{ position: 'absolute', top: 0, left, width: 228, p: 2, pointerEvents: 'none', zIndex: 1 }}
    >
      {children}
    </Paper>
  );
}

function Axes({
  width,
  height,
  max,
  format,
  ticks,
}: {
  width: number;
  height: number;
  max: number;
  format: (v: number) => string;
  ticks: ReadonlyArray<{ x: number; label: string }>;
}) {
  const theme = useTheme();
  const innerH = height - M.top - M.bottom;
  return (
    <g fontSize={11} fill={theme.palette.text.secondary}>
      {[0, 0.5, 1].map((f) => {
        const y = M.top + innerH * (1 - f);
        return (
          <g key={f}>
            <line
              x1={M.left}
              x2={width - M.right}
              y1={y}
              y2={y}
              stroke={theme.palette.divider}
              strokeWidth={1}
            />
            <text x={M.left - 6} y={y + 4} textAnchor="end">
              {format(max * f)}
            </text>
          </g>
        );
      })}
      {ticks.map((t) => (
        <text key={t.x} x={t.x} y={height - 6} textAnchor="middle">
          {t.label}
        </text>
      ))}
    </g>
  );
}

export interface StackedBucket {
  readonly start: number;
  readonly values: Readonly<Record<string, number>>;
}

/** Stacked bars per time bucket, series stacked bottom-up in the given (fixed) order. */
export function StackedBars({
  buckets,
  series,
  bucketMs,
  label,
  format,
  height = 220,
}: {
  buckets: readonly StackedBucket[];
  series: readonly Series[];
  bucketMs: number;
  label: string;
  format: (v: number) => string;
  height?: number;
}) {
  const theme = useTheme();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const band = buckets.length ? innerW / buckets.length : innerW;
  const total = (b: StackedBucket) => series.reduce((s, x) => s + (b.values[x.key] ?? 0), 0);
  const max = niceMax(buckets.reduce((m, b) => Math.max(m, total(b)), 0));
  const step = Math.max(1, Math.ceil(buckets.length / 6));
  const ticks = buckets
    .map((b, i) => ({ i, b }))
    .filter(({ i }) => i % step === 0)
    .map(({ i, b }) => ({ x: M.left + band * (i + 0.5), label: hhmm(b.start) }));
  const hovered = hover === null ? undefined : buckets[hover];

  return (
    <Box ref={ref} sx={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={label}>
        <Axes width={width} height={height} max={max} format={format} ticks={ticks} />
        {buckets.map((b, i) => {
          let y = M.top + innerH;
          const x = M.left + band * i + 1;
          const w = Math.max(1, band - 2);
          return (
            <g key={b.start} opacity={hover === null || hover === i ? 1 : 0.55}>
              {series.map((s) => {
                const v = b.values[s.key] ?? 0;
                if (v <= 0) return null;
                const h = (v / max) * innerH;
                y -= h;
                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={y}
                    width={w}
                    height={h}
                    fill={s.color}
                    stroke={theme.palette.background.paper}
                    strokeWidth={band > 6 ? 2 : 0.5}
                  />
                );
              })}
              <rect
                x={M.left + band * i}
                y={M.top}
                width={band}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <Tooltip x={M.left + band * hover} width={width}>
          <Typography variant="caption" component="p" sx={{ fontWeight: 500 }}>
            {hhmm(hovered.start)}–{hhmm(hovered.start + bucketMs)} UTC · {format(total(hovered))}
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {series
              .filter((s) => (hovered.values[s.key] ?? 0) > 0)
              .sort((a, b) => (hovered.values[b.key] ?? 0) - (hovered.values[a.key] ?? 0))
              .map((s) => (
                <Stack key={s.key} direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                  <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: s.color }} />
                  <Typography variant="caption" sx={{ flex: 1 }}>
                    {s.label}
                  </Typography>
                  <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {format(hovered.values[s.key] ?? 0)}
                  </Typography>
                </Stack>
              ))}
          </Stack>
        </Tooltip>
      )}
    </Box>
  );
}

/** One value per bucket on a fixed scale; `null` is a gap, never zero. */
export function ValueBars({
  buckets,
  bucketMs,
  label,
  max,
  format,
  color,
  detail,
  height = 120,
}: {
  buckets: ReadonlyArray<{ start: number; value: number | null }>;
  bucketMs: number;
  label: string;
  max: number;
  format: (v: number) => string;
  color: string;
  detail?: (i: number) => string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const band = buckets.length ? innerW / buckets.length : innerW;
  const step = Math.max(1, Math.ceil(buckets.length / 6));
  const ticks = buckets
    .map((b, i) => ({ i, b }))
    .filter(({ i }) => i % step === 0)
    .map(({ i, b }) => ({ x: M.left + band * (i + 0.5), label: hhmm(b.start) }));
  const hovered = hover === null ? undefined : buckets[hover];

  return (
    <Box ref={ref} sx={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={label}>
        <Axes width={width} height={height} max={max} format={format} ticks={ticks} />
        {buckets.map((b, i) => {
          const h = b.value === null ? 0 : (Math.min(b.value, max) / max) * innerH;
          return (
            <g key={b.start}>
              {b.value !== null && (
                <rect
                  x={M.left + band * i + 1}
                  y={M.top + innerH - h}
                  width={Math.max(1, band - 2)}
                  height={h}
                  fill={color}
                  opacity={hover === null || hover === i ? 1 : 0.55}
                />
              )}
              <rect
                x={M.left + band * i}
                y={M.top}
                width={band}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <Tooltip x={M.left + band * hover} width={width}>
          <Typography variant="caption" component="p" sx={{ fontWeight: 500 }}>
            {hhmm(hovered.start)}–{hhmm(hovered.start + bucketMs)} UTC
          </Typography>
          <Typography variant="caption" component="p">
            {hovered.value === null ? 'No data' : format(hovered.value)}
            {detail ? ` · ${detail(hover)}` : ''}
          </Typography>
        </Tooltip>
      )}
    </Box>
  );
}
