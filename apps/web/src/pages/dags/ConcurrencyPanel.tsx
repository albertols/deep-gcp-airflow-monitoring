/**
 * The DAG's concurrency profile (FR-DAGD-05, S-12 tab "concurrency"): its running task instances per time
 * bucket (from tries) and its running + queued and ready ones (from live snapshots) against
 * `max_active_tasks`, the time it spent at that limit, the slots it held in each pool against every DAG,
 * and its self-throttling share against REC-DAG-01's 10 % threshold, with a link to the advisor's finding.
 * Buckets without data are gaps, never zero; every chart has a table view, which exports as CSV in either
 * view (FR-STORE-04).
 *
 * @implements FR-DAGD-05, HM-005, HM-011, REC-DAG-01, NFR-DATA-03, FR-UI-05, FR-UI-07, FR-UI-08, FR-STORE-04
 */
import type { ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { DagConcurrency, DagDetail } from '@dcam/contracts';
import { tokens } from '@dcam/ui-kit';
import type { DcamApi } from '../../api';
import { HistoryNote } from '../../components/backfill';
import { ValueBars, bucketLabels } from '../../components/charts';
import { isoUtc, type CsvColumn } from '../../components/csv';
import { ExportCsvButton } from '../../components/ExportCsv';
import { formatCadence, formatDuration, formatInt, formatShare } from '../../components/format';
import { LineChart, type Line } from '../../components/line-chart';
import { Panel, PanelTitle, ProvenanceFooter } from '../../components/Panel';
import { seriesStyle } from '../../components/series';
import { useTableView } from '../../components/view-toggle';
import { useTimeFormat } from '../../components/view';
import type { PageProps } from '../types';
import { COMPARE_EXPLANATIONS as E } from './compare-explanations';
import { TaskHistoryFreshness } from './TaskHistoryFreshness';

const MONO = '"Roboto Mono", ui-monospace, monospace';
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const tasks = (v: number) => `${oneDecimal.format(v)} tasks`;
const NO_SNAPSHOT = 'No live snapshot in this bucket';
const NO_HISTORY = 'No task history for this bucket';

type Bucket = DagConcurrency['series'][number];

const peakOf = (values: readonly (number | null)[]) =>
  values.reduce<number | null>((m, v) => (v === null ? m : Math.max(m ?? 0, v)), null);

const AT_LIMIT_NOT_KNOWN = 'Time at the limit is not known: no live snapshot in this range.';

/** Time at max_active_tasks over the buckets with a live snapshot; `null` when no bucket has one (never 0). */
function timeAtLimit(c: DagConcurrency): number | null {
  let total: number | null = null;
  for (const b of c.series) if (b.at_limit_seconds !== null) total = (total ?? 0) + b.at_limit_seconds;
  return total;
}

const hasData = (c: DagConcurrency) =>
  c.series.some(
    (b) =>
      b.running_avg !== null || b.running_max !== null || b.in_flight_max !== null || b.ready_max !== null,
  );

/** A value or a gap with its reason on hover (NFR-DATA-03). */
function Cell({ value, gap, children }: { value: number | null; gap: string; children?: ReactNode }) {
  return (
    <TableCell align="right" title={value === null ? gap : undefined}>
      {value === null ? '—' : (children ?? formatInt(value))}
    </TableCell>
  );
}

function LimitFacts({ c }: { c: DagConcurrency }) {
  const limit = c.max_active_tasks_is_default
    ? `max_active_tasks ${formatInt(c.max_active_tasks)}, the default: the DAG does not set its own, so [core] max_active_tasks_per_dag applies.`
    : `max_active_tasks ${formatInt(c.max_active_tasks)}, set by the DAG.`;
  const snapshots =
    c.snapshots === 0
      ? 'No live snapshots in this range: running + queued and ready are not known.'
      : `${formatInt(c.snapshots)} live snapshots${c.snapshot_interval_seconds === null ? '' : `, every ${formatCadence(c.snapshot_interval_seconds)}`}.`;
  return (
    <Typography variant="body2">
      <Box component="span" sx={{ fontFamily: MONO }}>
        {limit}
      </Box>{' '}
      Running + queued task instances of all its active runs count against it (Airflow 2). Peak running{' '}
      {c.peak_running === null ? '—' : formatInt(c.peak_running)}, peak running + queued{' '}
      {c.peak_in_flight === null ? '—' : formatInt(c.peak_in_flight)}. {snapshots}
    </Typography>
  );
}

function SelfThrottling({ c, linkTo }: { c: DagConcurrency; linkTo: PageProps['linkTo'] }) {
  const time = useTimeFormat();
  const s = c.self_throttling;
  const threshold = formatShare(s.threshold);
  let body: ReactNode;
  if (s.at_limit_share === null) {
    body = (
      <Typography variant="body2" color="text.secondary">
        DCAM saw no work of this DAG in its live snapshots in this range, so it cannot tell how often
        max_active_tasks held it back. Pick a longer range, or check that DCAM is collecting.
      </Typography>
    );
  } else if (s.raises_rec_dag_01) {
    const headroom =
      s.headroom_share === null
        ? ''
        : ` There were free worker slots in ${formatShare(s.headroom_share)} of those moments, so its own limit held it back, not the environment.`;
    body = (
      <Alert
        severity="warning"
        variant="outlined"
        action={
          s.finding_id ? (
            <Link href={linkTo({ page: 'advisor' }, { finding: s.finding_id })} sx={{ whiteSpace: 'nowrap' }}>
              Open the REC-DAG-01 finding
            </Link>
          ) : undefined
        }
      >
        At its max_active_tasks limit for {formatShare(s.at_limit_share)} of its active time, with its own
        ready tasks waiting: above the {threshold} threshold of REC-DAG-01. Its ready tasks waited{' '}
        {formatDuration(s.own_waiting_task_seconds)} of task time at the limit, and up to{' '}
        {formatInt(s.peak_demand)} task instances wanted to run at once.{headroom}
        {s.last_at_limit ? ` Last at the limit ${time.dateTime(s.last_at_limit)}.` : ''}
        {s.finding_id
          ? ''
          : ' The advisor has no open REC-DAG-01 finding for this DAG: it evaluates the last 24 hours, this panel the selected range.'}
      </Alert>
    );
  } else {
    body = (
      <Typography variant="body2">
        At its max_active_tasks limit for {formatShare(s.at_limit_share)} of its active time: below the{' '}
        {threshold} threshold of REC-DAG-01, so its own limit rarely holds it back.
      </Typography>
    );
  }
  return (
    <Stack spacing={1} data-testid="self-throttling">
      <PanelTitle explanation={E['dagd-self-throttling']} component="h3" />
      {body}
    </Stack>
  );
}

function ProfileChart({ c }: { c: DagConcurrency }) {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const t = tokens[mode];
  const time = useTimeFormat();
  const bucketMs = c.bucket_seconds * 1000;
  const starts = c.series.map((b) => Date.parse(b.start));
  const labels = bucketLabels(time, starts.length, bucketMs);
  const [a, b, cc] = [0, 1, 2].map((i) => seriesStyle(mode, i));
  const pick = (f: (x: Bucket) => number | null) => c.series.map(f);
  const lines: Line[] = [
    {
      key: 'running-avg',
      label: 'Running (mean)',
      values: pick((x) => x.running_avg),
      color: a?.color ?? '',
    },
    {
      key: 'running-max',
      label: 'Running (peak)',
      values: pick((x) => x.running_max),
      color: a?.color ?? '',
      dash: '1 3',
    },
    {
      key: 'in-flight',
      label: 'Running + queued (peak, live snapshots)',
      values: pick((x) => x.in_flight_max),
      color: b?.color ?? '',
      dash: b?.dash ?? 'none',
    },
    {
      key: 'ready',
      label: 'Ready, not yet queued (peak, live snapshots)',
      values: pick((x) => x.ready_max),
      color: cc?.color ?? '',
      dash: cc?.dash ?? 'none',
    },
  ];
  const atLimit = timeAtLimit(c);
  const description = `Concurrency per ${formatDuration(c.bucket_seconds)} bucket: ${
    c.peak_running === null ? 'no task ran' : `peak ${formatInt(c.peak_running)} running at once`
  } against max_active_tasks ${formatInt(c.max_active_tasks)}${
    atLimit === null
      ? `. ${AT_LIMIT_NOT_KNOWN}`
      : `; at the limit for ${formatDuration(atLimit)} in the range.`
  }`;
  return (
    <Stack spacing={2}>
      <LineChart
        count={starts.length}
        lines={lines}
        references={[
          {
            key: 'limit',
            label: `max_active_tasks (${formatInt(c.max_active_tasks)})`,
            value: c.max_active_tasks,
            color: t.textSecondary,
          },
        ]}
        tick={(i) => labels.tick(starts[i] ?? 0)}
        title={(i) => labels.range(starts[i] ?? 0)}
        format={tasks}
        label={description}
      />
      <Typography variant="caption" color="text.secondary" component="p">
        Time at the limit with its own ready work, per bucket (HM-005)
      </Typography>
      {atLimit === null ? (
        <Typography variant="body2" color="text.secondary">
          {AT_LIMIT_NOT_KNOWN}
        </Typography>
      ) : (
        <ValueBars
          buckets={c.series.map((x, i) => ({ start: starts[i] ?? 0, value: x.at_limit_seconds }))}
          bucketMs={bucketMs}
          max={c.bucket_seconds}
          format={formatDuration}
          color={b?.color ?? t.statusWarning}
          label={`Time at the limit per bucket: ${formatDuration(atLimit)} in total; empty buckets had no live snapshot.`}
          height={100}
        />
      )}
    </Stack>
  );
}

function PoolChart({ c, pool }: { c: DagConcurrency; pool: DagConcurrency['pools'][number] }) {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const t = tokens[mode];
  const time = useTimeFormat();
  const starts = c.series.map((b) => Date.parse(b.start));
  const labels = bucketLabels(time, starts.length, c.bucket_seconds * 1000);
  const [a, b] = [0, 1].map((i) => seriesStyle(mode, i));
  const dagPeak = peakOf(pool.dag_slots_max);
  const allPeak = peakOf(pool.occupied_max);
  const size =
    pool.slots === null ? 'a pool the environment does not define' : `${formatInt(pool.slots)} slots`;
  const description = `Pool ${pool.name}: this DAG held up to ${dagPeak === null ? '—' : oneDecimal.format(dagPeak)} of ${size}; every DAG together occupied up to ${allPeak === null ? '—' : oneDecimal.format(allPeak)}. Each task of this DAG takes up to ${formatInt(pool.pool_slots)} slots.`;
  return (
    <Stack spacing={1}>
      <Typography variant="body2" sx={{ fontFamily: MONO }} component="h4">
        Pool {pool.name}
      </Typography>
      <LineChart
        count={starts.length}
        height={140}
        lines={[
          {
            key: 'dag',
            label: 'This DAG (peak slots, from tries)',
            values: pool.dag_slots_max,
            color: a?.color ?? '',
          },
          {
            key: 'all',
            label: 'Every DAG (peak occupied, live snapshots)',
            values: pool.occupied_max,
            color: b?.color ?? '',
            dash: b?.dash ?? 'none',
          },
        ]}
        references={
          pool.slots === null
            ? []
            : [
                {
                  key: 'size',
                  label: `Pool size (${formatInt(pool.slots)})`,
                  value: pool.slots,
                  color: t.textSecondary,
                },
              ]
        }
        tick={(i) => labels.tick(starts[i] ?? 0)}
        title={(i) => labels.range(starts[i] ?? 0)}
        format={(v) => `${oneDecimal.format(v)} slots`}
        label={description}
      />
    </Stack>
  );
}

const slot = (v: number | null) => (v === null ? '—' : oneDecimal.format(v));

interface ProfileRow {
  readonly bucket: Bucket;
  readonly index: number;
}

/** The concurrency table as CSV: a bucket per row, a pool's two peaks per pool; a gap is an empty cell. */
const profileCsv = (c: DagConcurrency): readonly CsvColumn<ProfileRow>[] => [
  { name: 'bucket_start_utc', value: (x) => isoUtc(x.bucket.start) },
  { name: 'bucket_seconds', value: () => c.bucket_seconds },
  { name: 'running_mean', value: (x) => x.bucket.running_avg },
  { name: 'running_peak', value: (x) => x.bucket.running_max },
  { name: 'running_queued_peak', value: (x) => x.bucket.in_flight_max },
  { name: 'ready_peak', value: (x) => x.bucket.ready_max },
  { name: 'at_limit_seconds', value: (x) => x.bucket.at_limit_seconds },
  ...c.pools.flatMap((p) => [
    { name: `${p.name}_dag_slots_peak`, value: (x: ProfileRow) => p.dag_slots_max[x.index] ?? null },
    { name: `${p.name}_occupied_slots_peak`, value: (x: ProfileRow) => p.occupied_max[x.index] ?? null },
  ]),
];

function ProfileTable({ c }: { c: DagConcurrency }) {
  const time = useTimeFormat();
  const labels = bucketLabels(time, c.series.length, c.bucket_seconds * 1000);
  return (
    <TableContainer sx={{ maxHeight: 420 }}>
      <Table size="small" stickyHeader aria-label="Concurrency per bucket">
        <TableHead>
          <TableRow>
            <TableCell>Time</TableCell>
            <TableCell align="right">Running (mean)</TableCell>
            <TableCell align="right">Running (peak)</TableCell>
            <TableCell align="right">Running + queued (peak)</TableCell>
            <TableCell align="right">Ready (peak)</TableCell>
            <TableCell align="right">Time at the limit</TableCell>
            {c.pools.map((p) => (
              <TableCell key={p.name} align="right">
                Pool {p.name}: this DAG / all DAGs
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {c.series.map((b, i) => (
            <TableRow key={b.start}>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{labels.range(Date.parse(b.start))}</TableCell>
              <Cell value={b.running_avg} gap={NO_HISTORY}>
                {b.running_avg === null ? null : oneDecimal.format(b.running_avg)}
              </Cell>
              <Cell value={b.running_max} gap={NO_HISTORY} />
              <Cell value={b.in_flight_max} gap={NO_SNAPSHOT} />
              <Cell value={b.ready_max} gap={NO_SNAPSHOT} />
              <Cell value={b.at_limit_seconds} gap={NO_SNAPSHOT}>
                {b.at_limit_seconds === null ? null : formatDuration(b.at_limit_seconds)}
              </Cell>
              {c.pools.map((p) => (
                <TableCell key={p.name} align="right">
                  {`${slot(p.dag_slots_max[i] ?? null)} / ${slot(p.occupied_max[i] ?? null)}`}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function ConcurrencyPanel({
  detail,
  api,
  envId,
  linkTo,
}: {
  detail: DagDetail;
  api: DcamApi;
  envId: string;
  linkTo: PageProps['linkTo'];
}) {
  const time = useTimeFormat();
  const [asTable, toggle] = useTableView('concurrency');
  const c = detail.concurrency;
  const data = c !== undefined && hasData(c);
  return (
    <Panel
      explanation={E['dagd-concurrency']}
      actions={
        <Stack direction="row" sx={{ gap: 2, alignItems: 'center' }}>
          <TaskHistoryFreshness api={api} envId={envId} />
          {data && toggle}
          {c !== undefined && data && (
            <ExportCsvButton
              view="concurrency"
              what="Concurrency per bucket"
              rows={c.series.map((bucket, index) => ({ bucket, index }))}
              columns={profileCsv(c)}
            />
          )}
        </Stack>
      }
    >
      {c === undefined ? (
        <Typography variant="body2" color="text.secondary">
          This DCAM server does not report the concurrency profile yet. Update DCAM to see it.
        </Typography>
      ) : (
        <Stack spacing={3}>
          <HistoryNote
            api={api}
            envId={envId}
            rangeFrom={detail.range.from}
            kinds={['task_instances']}
            healthHref={linkTo({ page: 'health' })}
          />
          <LimitFacts c={c} />
          <SelfThrottling c={c} linkTo={linkTo} />
          {!data ? (
            <Typography variant="body2" color="text.secondary">
              No task of this DAG ran in this range, and DCAM has no live snapshots of it. Pick a longer
              range, or check that the DAG is not paused.
            </Typography>
          ) : asTable ? (
            <ProfileTable c={c} />
          ) : (
            <>
              <ProfileChart c={c} />
              {c.pools.length > 0 && (
                <Stack spacing={2}>
                  <PanelTitle explanation={E['dagd-concurrency-pools']} component="h3" />
                  {c.pools.map((p) => (
                    <PoolChart key={p.name} c={c} pool={p} />
                  ))}
                </Stack>
              )}
            </>
          )}
          <ProvenanceFooter
            as="p"
            dataAsOf={detail.data_as_of}
            sources={detail.sources}
            note={`running from task tries (HM-011); running + queued and ready from live snapshots; self-throttling method ${c.self_throttling.method} · range ${time.dateTime(detail.range.from)} to ${time.dateTime(detail.range.to)}`}
          />
        </Stack>
      )}
    </Panel>
  );
}
