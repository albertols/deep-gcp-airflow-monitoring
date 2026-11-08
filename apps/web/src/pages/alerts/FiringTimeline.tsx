/**
 * When each rule was firing over the last 24 h (spec §16.7, FR-ALRT-06): one row per rule and
 * environment, a bar per firing period. Bars carry a text title and the row names the rule, so colour
 * is never the only cue (spec §12.8). The history table below is its table view.
 *
 * @implements FR-ALRT-06, FR-UI-01
 */
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { Severity } from '@dcam/contracts';
import { useWidth } from '../../components/charts';
import { useTimeFormat } from '../../components/view';
import { SEVERITY_LABEL, type FiringPeriod } from './model';

const LABEL_W = 156;
const ROW_H = 22;
const AXIS_H = 20;
const RIGHT = 8;

export function FiringTimeline({
  periods,
  from,
  to,
  showEnvironment,
}: {
  periods: readonly FiringPeriod[];
  from: number;
  to: number;
  showEnvironment: boolean;
}) {
  const theme = useTheme();
  const time = useTimeFormat();
  const hhmm = (ms: number) => time.clock(ms);
  const zone = (ms: number) => time.zoneName(ms);
  const [ref, width] = useWidth<HTMLDivElement>();
  const colour: Record<Severity, string> = {
    critical: theme.palette.error.main,
    warning: theme.palette.warning.main,
    info: theme.palette.info.main,
  };
  const rows = [...new Set(periods.map((p) => `${p.envId}\u0000${p.ruleId}`))].sort();
  const height = rows.length * ROW_H + AXIS_H;
  const innerW = Math.max(40, width - LABEL_W - RIGHT);
  const x = (t: number) => LABEL_W + ((Math.min(Math.max(t, from), to) - from) / (to - from)) * innerW;
  const ticks = Array.from({ length: 5 }, (_, i) => from + (i * (to - from)) / 4);
  const stillFiring = periods.filter((p) => p.open).length;
  const label = `Firing periods over the last 24 h: ${periods.length} ${
    periods.length === 1 ? 'period' : 'periods'
  } across ${rows.length} ${rows.length === 1 ? 'rule' : 'rules'}, ${stillFiring} still firing.`;

  if (rows.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        Nothing fired in the last 24 hours.
      </Typography>
    );

  return (
    <Box ref={ref}>
      <svg width={width} height={height} role="img" aria-label={label}>
        {ticks.map((t, i) => (
          <g key={t}>
            <line
              x1={x(t)}
              x2={x(t)}
              y1={0}
              y2={rows.length * ROW_H}
              stroke={theme.palette.divider}
              strokeDasharray="2 3"
            />
            <text
              x={x(t)}
              y={rows.length * ROW_H + 14}
              fill={theme.palette.text.secondary}
              fontSize={11}
              // The last label ends at the axis end, so it is never clipped by the chart edge.
              textAnchor={i === ticks.length - 1 ? 'end' : 'middle'}
            >
              {i === 0 ? `${hhmm(t)} ${zone(t)}` : hhmm(t)}
            </text>
          </g>
        ))}
        {rows.map((row, i) => {
          const [envId, ruleId] = row.split('\u0000') as [string, string];
          const y = i * ROW_H;
          return (
            <g key={row}>
              <text x={0} y={y + ROW_H / 2 + 4} fill={theme.palette.text.primary} fontSize={12}>
                {showEnvironment ? `${ruleId} · ${envId}` : ruleId}
              </text>
              {periods
                .filter((p) => p.envId === envId && p.ruleId === ruleId)
                .map((p) => (
                  <rect
                    key={p.start}
                    x={x(p.start)}
                    y={y + 4}
                    width={Math.max(2, x(p.end) - x(p.start))}
                    height={ROW_H - 8}
                    rx={2}
                    fill={colour[p.severity]}
                  >
                    <title>
                      {`${ruleId} ${envId} · ${SEVERITY_LABEL[p.severity]} · fired ${hhmm(p.start)} ${zone(p.start)}, ${
                        p.open ? 'still firing' : `resolved ${hhmm(p.end)} ${zone(p.end)}`
                      }`}
                    </title>
                  </rect>
                ))}
            </g>
          );
        })}
      </svg>
    </Box>
  );
}
