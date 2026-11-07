/**
 * Pools (FR-ENV-08, M3 demo step 3): per pool the slots, how many ran and queued, how much ready and queued
 * work waited, starvation over time and the DAGs that waited most. Buckets without a snapshot are gaps,
 * never zero (§8.1); the starvation bars have an accessible description and a table view (§12.8).
 *
 * @implements FR-ENV-08, FR-UI-05, FR-UI-07, FR-UI-08
 */
import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { Bottlenecks } from '@dcam/contracts';
import { formatInt, formatShare } from '../../components/format';
import { Panel, ProvenanceFooter } from '../../components/Panel';
import type { PageProps } from '../types';
import { DEPTH_EXPLANATIONS as X } from './explanations-depth';

type Pool = Bottlenecks['pools'][number];

const MONO = { fontFamily: '"Roboto Mono", ui-monospace, monospace' } as const;
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const taskHours = (seconds: number | undefined) =>
  seconds === undefined ? '—' : oneDecimal.format(seconds / 3600);
const bucketName = (seconds: number) => (seconds % 60 === 0 ? `${seconds / 60}-minute` : `${seconds}-second`);
const NO_DATA = 'No data';

function Starvation({ pool, bucketSeconds }: { pool: Pool; bucketSeconds: number }) {
  const theme = useTheme();
  const series = pool.starved_series ?? [];
  const observed = series.filter((m) => m !== null).length;
  const peak = series.reduce<number>((max, m) => Math.max(max, m ?? 0), 0);
  const limit = bucketSeconds / 60;
  const width = 120;
  const height = 24;
  const step = series.length > 0 ? width / series.length : width;
  const label =
    `Starved minutes per ${bucketName(bucketSeconds)} bucket for ${pool.name}: ` +
    (observed === 0
      ? 'no snapshots in this range.'
      : `${formatInt(observed)} of ${formatInt(series.length)} buckets observed, at most ${oneDecimal.format(peak)} min in one bucket.`);
  return (
    <svg role="img" aria-label={label} width={width} height={height} style={{ display: 'block' }}>
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke={theme.palette.divider} />
      {series.map((m, i) =>
        m === null || m <= 0 ? null : (
          <rect
            key={i}
            x={i * step}
            width={Math.max(1, step - 1)}
            y={height - Math.max(1, (Math.min(m, limit) / limit) * height)}
            height={Math.max(1, (Math.min(m, limit) / limit) * height)}
            fill={theme.palette.error.main}
          />
        ),
      )}
    </svg>
  );
}

export function PoolsPanel({ b, linkTo }: { b: Bottlenecks; linkTo: PageProps['linkTo'] }) {
  const [asTable, setAsTable] = useState(false);
  const withSeries = b.pools.filter((p) => p.starved_series !== undefined);

  return (
    <Panel
      explanation={X['botl-pools-activity']}
      actions={
        withSeries.length > 0 ? (
          <Button size="small" onClick={() => setAsTable((v) => !v)}>
            {asTable ? 'View starvation as bars' : 'View starvation as a table'}
          </Button>
        ) : undefined
      }
    >
      {b.pools.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No pools were reported for this environment yet. Pools appear after the first live snapshot; check
          the collectors on the DCAM health page.
        </Typography>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Pools">
            <TableHead>
              <TableRow>
                <TableCell>Pool</TableCell>
                <TableCell align="right">Slots</TableCell>
                <TableCell align="right">Running slots (mean / peak)</TableCell>
                <TableCell align="right">Queued slots (mean)</TableCell>
                <TableCell align="right">Ready waiting (task-h)</TableCell>
                <TableCell align="right">Queued waiting (task-h)</TableCell>
                <TableCell align="right">Starved (min)</TableCell>
                <TableCell>Starvation over time</TableCell>
                <TableCell align="right">Fill p95</TableCell>
                <TableCell>DAGs that waited most</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {b.pools.map((p) => (
                <TableRow key={p.name}>
                  <TableCell sx={MONO}>{p.name}</TableCell>
                  <TableCell align="right">{formatInt(p.slots)}</TableCell>
                  <TableCell align="right">
                    {p.running_slots_avg === null || p.running_slots_avg === undefined
                      ? NO_DATA
                      : `${oneDecimal.format(p.running_slots_avg)} / ${formatInt(p.running_slots_peak ?? 0)}`}
                  </TableCell>
                  <TableCell align="right">
                    {p.queued_slots_avg === null || p.queued_slots_avg === undefined
                      ? NO_DATA
                      : oneDecimal.format(p.queued_slots_avg)}
                  </TableCell>
                  <TableCell align="right">{taskHours(p.ready_task_seconds)}</TableCell>
                  <TableCell align="right">{taskHours(p.queued_task_seconds)}</TableCell>
                  <TableCell align="right">{formatInt(Math.round(p.starved_minutes))}</TableCell>
                  <TableCell>
                    {p.starved_series ? <Starvation pool={p} bucketSeconds={b.bucket_seconds} /> : '—'}
                  </TableCell>
                  <TableCell align="right">{formatShare(p.utilisation_p95)}</TableCell>
                  <TableCell>
                    {(p.top_dags ?? []).slice(0, 3).map((d, i) => (
                      <span key={d.dag_id}>
                        {i > 0 && ', '}
                        <Link href={linkTo({ page: 'dag', dagId: d.dag_id })}>{d.dag_id}</Link>
                      </span>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}

      {asTable && (
        <Box sx={{ maxHeight: 320, overflow: 'auto', mt: 3 }}>
          <Table size="small" stickyHeader aria-label="Starved minutes per bucket">
            <TableHead>
              <TableRow>
                <TableCell>Bucket (UTC)</TableCell>
                {withSeries.map((p) => (
                  <TableCell key={p.name} align="right" sx={MONO}>
                    {p.name}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {b.series.map((bucket, i) => (
                <TableRow key={bucket.start}>
                  <TableCell>{bucket.start.slice(11, 16)}</TableCell>
                  {withSeries.map((p) => {
                    const m = p.starved_series?.[i];
                    return (
                      <TableCell key={p.name} align="right">
                        {m === null || m === undefined ? 'no snapshot' : oneDecimal.format(m)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}

      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
        Starved: zero open slots while ready work waited for the pool. Deferred slots are not collected yet.
      </Typography>
      <ProvenanceFooter
        as="p"
        dataAsOf={b.data_as_of}
        sources={b.sources}
        note="time-weighted over DCAM's live snapshots; a bucket without a snapshot is a gap, not zero"
      />
    </Panel>
  );
}
