/**
 * Pools (FR-ENV-08, M3 demo step 3): per pool the slots, how many ran and queued, how much ready and queued
 * work waited, starvation over time and the DAGs that waited most. Buckets without a snapshot are gaps,
 * never zero (§8.1); the starvation bars have an accessible description and a table view (§12.8). Both
 * tables export as CSV (FR-STORE-04).
 *
 * @implements FR-ENV-08, FR-UI-05, FR-UI-07, FR-UI-08, FR-STORE-04
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
import { useTheme } from '@mui/material/styles';
import type { Bottlenecks } from '@dcam/contracts';
import { csvList, isoUtc, type CsvColumn } from '../../components/csv';
import { ExportCsvButton } from '../../components/ExportCsv';
import { formatInt, formatShare } from '../../components/format';
import { bucketLabels } from '../../components/charts';
import { Panel, ProvenanceFooter } from '../../components/Panel';
import { usePageParam, useTimeFormat } from '../../components/view';
import type { PageProps } from '../types';
import { DEPTH_EXPLANATIONS as X } from './explanations-depth';

type Pool = Bottlenecks['pools'][number];

const MONO = { fontFamily: '"Roboto Mono", ui-monospace, monospace' } as const;
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const taskHours = (seconds: number | undefined) =>
  seconds === undefined ? '—' : oneDecimal.format(seconds / 3600);
const bucketName = (seconds: number) => (seconds % 60 === 0 ? `${seconds / 60}-minute` : `${seconds}-second`);
const NO_DATA = 'No data';

/** The pools table as CSV: slots, time-weighted means, waiting in task-seconds (null where not measured). */
const POOL_CSV: readonly CsvColumn<Pool>[] = [
  { name: 'pool', value: (p) => p.name },
  { name: 'slots', value: (p) => p.slots },
  { name: 'running_slots_mean', value: (p) => p.running_slots_avg },
  { name: 'running_slots_peak', value: (p) => p.running_slots_peak },
  { name: 'queued_slots_mean', value: (p) => p.queued_slots_avg },
  { name: 'ready_task_seconds', value: (p) => p.ready_task_seconds },
  { name: 'queued_task_seconds', value: (p) => p.queued_task_seconds },
  { name: 'waiting_task_seconds', value: (p) => p.waiting_task_seconds },
  { name: 'starved_minutes', value: (p) => p.starved_minutes },
  { name: 'utilisation_p95_ratio', value: (p) => p.utilisation_p95 },
  { name: 'top_dags', value: (p) => csvList((p.top_dags ?? []).slice(0, 3).map((d) => d.dag_id)) },
];

type Bucket = Bottlenecks['series'][number];
interface StarvedRow {
  readonly bucket: Bucket;
  readonly index: number;
}

/** Starved minutes per bucket as CSV: one column per pool; a bucket without a snapshot is empty. */
const starvedCsv = (pools: readonly Pool[], bucketSeconds: number): readonly CsvColumn<StarvedRow>[] => [
  { name: 'bucket_start_utc', value: (x) => isoUtc(x.bucket.start) },
  { name: 'bucket_seconds', value: () => bucketSeconds },
  ...pools.map((p) => ({
    name: `${p.name}_starved_minutes`,
    value: (x: StarvedRow) => p.starved_series?.[x.index] ?? null,
  })),
];

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
  const [view, setView] = usePageParam('starvation', 'bars');
  const asTable = view === 'table';
  const time = useTimeFormat();
  const labels = bucketLabels(time, b.series.length, b.bucket_seconds * 1000);
  const withSeries = b.pools.filter((p) => p.starved_series !== undefined);

  return (
    <Panel
      explanation={X['botl-pools-activity']}
      actions={
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {withSeries.length > 0 && (
            <Button size="small" onClick={() => setView(asTable ? 'bars' : 'table')}>
              {asTable ? 'View starvation as bars' : 'View starvation as a table'}
            </Button>
          )}
          <ExportCsvButton view="pools" what="Pools" rows={b.pools} columns={POOL_CSV} />
        </Stack>
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
        <Stack direction="row" sx={{ justifyContent: 'flex-end', mt: 3 }}>
          <ExportCsvButton
            view="pool-starvation"
            what="Starved minutes per bucket"
            rows={b.series.map((bucket, index) => ({ bucket, index }))}
            columns={starvedCsv(withSeries, b.bucket_seconds)}
          />
        </Stack>
      )}
      {asTable && (
        <Box sx={{ maxHeight: 320, overflow: 'auto', mt: 1 }}>
          <Table size="small" stickyHeader aria-label="Starved minutes per bucket">
            <TableHead>
              <TableRow>
                <TableCell>{`Bucket start (${time.zoneName(b.series[0]?.start)})`}</TableCell>
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
                  <TableCell>{labels.tick(Date.parse(bucket.start))}</TableCell>
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
