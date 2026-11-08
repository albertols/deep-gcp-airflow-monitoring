/**
 * S-16 "Why is work waiting?": waiting task-time attributed to the limit that binds (HM-006), with
 * worker capacity, top contributors, noisy neighbours, pools, priority fairness and sensor waste, over the
 * context bar's range. The chart's bucket keeps it at 360 bars or fewer and is named in the chart; chart or
 * table view is in the URL.
 *
 * @implements FR-BOTL-01, FR-BOTL-02, FR-BOTL-06, FR-BOTL-07, FR-BOTL-09, FR-ENV-08, HM-017, HM-023,
 *   FR-UI-01, FR-UI-02, FR-UI-05, FR-UI-07, FR-UI-08, NFR-PERF-06
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { Bottlenecks, WaitReasonId } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import { HistoryNote } from '../../components/backfill';
import { Legend, StackedBars, ValueBars, bucketLabels } from '../../components/charts';
import { formatCadence, formatDuration, formatInt, formatShare } from '../../components/format';
import { PageHeader } from '../../components/PageHeader';
import { Kpi, KpiRow, Panel, ProvenanceFooter, QueryState } from '../../components/Panel';
import { RANGE_PRESETS } from '../../components/range';
import { usePageParam, useRefresh, useView } from '../../components/view';
import type { PageProps } from '../types';
import { BOTTLENECK_EXPLANATIONS as X } from './explanations';
import { NoisyNeighboursPanel } from './NoisyNeighboursPanel';
import { PoolsPanel } from './PoolsPanel';
import { PriorityPanel } from './PriorityPanel';
import { CHART_SERIES, REASONS, type ChartSeriesKey } from './reasons';
import { TopContributorsPanel } from './TopContributorsPanel';

const minutes = (seconds: number) => seconds / 60;
const fmtMinutes = (m: number) => `${formatInt(Math.round(m))} min`;
const taskHours = (seconds: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(
    seconds / 3600,
  );

const NO_SAMPLES = 'Needs Cloud Monitoring worker samples; none arrived in this range';

/**
 * A capacity KPI in minutes. `null` is never shown as 0 (spec §8.1): without worker samples there is
 * no data; with samples, a null capacity-bound figure means worker_concurrency is not known (HM-032).
 */
function capacityMinutes(b: Bottlenecks, minutes: number | null) {
  if (minutes !== null) return { value: formatInt(Math.round(minutes)), unit: 'min' };
  if (b.capacity.worker_samples === 0) return { value: 'No data', hint: NO_SAMPLES };
  return {
    value: 'Not known yet',
    hint: 'worker_concurrency is not known (no override in the Composer configuration)',
  };
}

/** "15-minute" for 900 s, "3-hour" for 10,800 s: the chart's bucket, named in its description. */
export const bucketName = (seconds: number) =>
  seconds % 3600 === 0
    ? `${seconds / 3600}-hour`
    : seconds % 60 === 0
      ? `${seconds / 60}-minute`
      : `${seconds}-second`;

/** Waiting task-minutes per chart series for each bucket. */
function seriesBuckets(b: Bottlenecks) {
  return b.series.map((bucket) => {
    const values: Partial<Record<ChartSeriesKey, number>> = {};
    for (const [reason, secs] of Object.entries(bucket.waiting_task_seconds)) {
      const key = REASONS[reason as WaitReasonId]?.series;
      if (key && secs !== undefined) values[key] = (values[key] ?? 0) + minutes(secs);
    }
    return { start: Date.parse(bucket.start), values };
  });
}

export function BottlenecksPage({ api, envId, linkTo }: PageProps) {
  const { range, time } = useView();
  const [view, setView] = usePageParam('waiting', 'chart');
  const asTable = view === 'table';
  const q = useQuery({
    queryKey: ['bottlenecks', envId, range],
    queryFn: () => api.getBottlenecks(envId, range),
    ...useRefresh(),
  });
  const b = q.data;
  const buckets = useMemo(() => (b ? seriesBuckets(b) : []), [b]);
  const present = CHART_SERIES.filter((s) => buckets.some((x) => (x.values[s.key] ?? 0) > 0));
  const bucketLabel = b ? bucketName(b.bucket_seconds) : '';
  const labels = bucketLabels(time, buckets.length, (b?.bucket_seconds ?? 60) * 1000);

  return (
    <Stack spacing={4}>
      <PageHeader
        title="Bottlenecks"
        subtitle={`${RANGE_PRESETS[range].label}. Why ready work is not running: waiting attributed to the limit that binds.`}
      />
      <QueryState isPending={q.isPending} error={q.error} what="the bottleneck analysis" range={range} />
      {b && (
        <>
          {b.answer.reason ? (
            <Alert severity="info" icon={false} action={<InfoPopover explanation={X['botl-answer']} />}>
              <Typography component="p">
                <strong>{formatShare(b.answer.share)}</strong> of waiting task-time was caused by "
                {REASONS[b.answer.reason].label}"
                {b.answer.reason === 'executor-slots-exhausted' && b.answer.workers_at_max_share > 0.5
                  ? ' while workers were at max'
                  : ''}
                .{' '}
                {b.answer.advice_withheld === null
                  ? REASONS[b.answer.reason].action
                  : // The advisor's data gate (§13.2): never advise what the advisor reports as not evaluated.
                    `No advice yet. ${b.answer.advice_withheld}`}
              </Typography>
            </Alert>
          ) : (
            <Alert severity="success">
              No work waited on a platform limit in this range. Waits were within normal scheduling latency.
            </Alert>
          )}

          <KpiRow>
            <Kpi
              explanation={X['botl-waiting-total']}
              value={taskHours(b.waiting_task_seconds)}
              unit="task-hours"
            />
            <Kpi
              explanation={X['botl-current']}
              value={b.current.binding ? REASONS[b.current.binding].label : 'Nothing'}
              hint={`${formatInt(b.current.scheduled)} ready, ${formatInt(b.current.queued)} queued, ${formatInt(b.current.running)} running`}
            />
            <Kpi
              explanation={X['botl-at-max']}
              {...capacityMinutes(b, b.capacity.minutes_at_max_workers)}
              hint={
                b.capacity.minutes_at_max_workers === null
                  ? NO_SAMPLES
                  : b.current.slots_source === 'hostnames'
                    ? `Workers at least ${b.current.workers.current} of ${b.current.workers.max} max, estimated from worker hostnames`
                    : `Workers ${b.current.workers.current} of ${b.current.workers.max} max`
              }
            />
            <Kpi
              explanation={X['botl-capacity-bound']}
              {...capacityMinutes(b, b.capacity.capacity_bound_minutes)}
            />
            <Kpi
              explanation={X['botl-scale-lag']}
              value={formatDuration(b.capacity.scale_up_lag_p95_seconds)}
              hint={b.capacity.worker_samples === 0 ? NO_SAMPLES : undefined}
            />
          </KpiRow>

          <Panel
            explanation={X['botl-waiting-chart']}
            actions={
              <Button size="small" onClick={() => setView(asTable ? 'chart' : 'table')}>
                {asTable ? 'View waiting as a chart' : 'View waiting as a table'}
              </Button>
            }
          >
            <Stack spacing={2}>
              <Legend series={present} label="Legend: waiting by reason" />
              <Typography variant="caption" color="text.secondary">
                Each bar is one {bucketLabel} bucket of the {RANGE_PRESETS[range].span}, in task-minutes.
              </Typography>
              {asTable ? (
                <Box sx={{ maxHeight: 360, overflow: 'auto' }}>
                  <Table size="small" stickyHeader aria-label="Waiting task-minutes per bucket">
                    <TableHead>
                      <TableRow>
                        <TableCell>{`Bucket start (${time.zoneName(buckets[0]?.start)})`}</TableCell>
                        {present.map((s) => (
                          <TableCell key={s.key} align="right">
                            {s.label}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {buckets.map((x) => (
                        <TableRow key={x.start}>
                          <TableCell>{labels.tick(x.start)}</TableCell>
                          {present.map((s) => (
                            <TableCell key={s.key} align="right">
                              {formatInt(Math.round(x.values[s.key] ?? 0))}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              ) : (
                <StackedBars
                  buckets={buckets}
                  series={present}
                  bucketMs={b.bucket_seconds * 1000}
                  format={fmtMinutes}
                  label={`Waiting task-minutes per ${bucketLabel} bucket, stacked by reason. ${
                    b.answer.reason
                      ? `${REASONS[b.answer.reason].label} accounts for ${formatShare(b.answer.share)}.`
                      : 'No waiting on platform limits.'
                  }`}
                />
              )}
            </Stack>
          </Panel>

          <Panel explanation={X['botl-utilisation-chart']}>
            <ValueBars
              buckets={b.series.map((s) => ({ start: Date.parse(s.start), value: s.worker_slots_used }))}
              bucketMs={b.bucket_seconds * 1000}
              max={1}
              format={(v) => formatShare(v)}
              color="#8ab4f8"
              detail={(i) => {
                const w = b.series[i]?.workers;
                return w === null || w === undefined ? 'no samples' : `${w.toFixed(1)} workers`;
              }}
              label={`Share of worker slots in use per ${bucketLabel} bucket; p95 ${formatShare(b.capacity.utilisation_p95)}.`}
            />
          </Panel>

          <Panel explanation={X['botl-reasons']}>
            <Table size="small" aria-label="Waiting by reason">
              <TableHead>
                <TableRow>
                  <TableCell>Reason</TableCell>
                  <TableCell>Phase</TableCell>
                  <TableCell align="right">Task-hours</TableCell>
                  <TableCell sx={{ width: '22%' }}>Share</TableCell>
                  <TableCell>DAGs that waited most</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {b.reasons.map((r) => {
                  const info = REASONS[r.id];
                  const color = CHART_SERIES.find((s) => s.key === info.series)?.color;
                  return (
                    <TableRow key={r.id} hover>
                      <TableCell>
                        <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                          <Box
                            aria-hidden
                            sx={{
                              width: 10,
                              height: 10,
                              borderRadius: '2px',
                              bgcolor: color ?? 'transparent',
                              flexShrink: 0,
                            }}
                          />
                          <Box>
                            <Typography variant="body2">{info.label}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {info.description}
                            </Typography>
                          </Box>
                        </Stack>
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.phase}</TableCell>
                      <TableCell align="right">
                        {r.evaluated ? taskHours(r.waiting_task_seconds) : '—'}
                      </TableCell>
                      <TableCell>
                        {r.evaluated ? (
                          <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                            <LinearProgress
                              variant="determinate"
                              value={r.share * 100}
                              sx={{ flex: 1 }}
                              aria-label={`${info.label} share`}
                            />
                            <Typography variant="body2" sx={{ minWidth: 44, textAlign: 'right' }}>
                              {formatShare(r.share)}
                            </Typography>
                          </Stack>
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            Not collected yet
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.top_contributors.slice(0, 3).map((c, i) => (
                          <span key={c.dag_id}>
                            {i > 0 && ', '}
                            <Link href={linkTo({ page: 'dag', dagId: c.dag_id })}>{c.dag_id}</Link>
                          </span>
                        ))}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
              Also observed: {taskHours(b.normal_latency_task_seconds)} task-hours of normal latency (waits
              below the 30 s / 60 s thresholds), not counted as a platform limit.
            </Typography>
          </Panel>

          <TopContributorsPanel b={b} linkTo={linkTo} />
          <NoisyNeighboursPanel b={b} linkTo={linkTo} />
          <PoolsPanel b={b} linkTo={linkTo} />

          <Stack direction={{ xs: 'column', lg: 'row' }} sx={{ gap: 4 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <PriorityPanel b={b} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Panel explanation={X['botl-sensors']}>
                {b.sensors.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No poke-mode sensors held worker slots in this range.
                  </Typography>
                ) : (
                  <Table size="small" aria-label="Sensors holding worker slots">
                    <TableHead>
                      <TableRow>
                        <TableCell>DAG</TableCell>
                        <TableCell>Task</TableCell>
                        <TableCell align="right">Slot time</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {b.sensors.slice(0, 8).map((s) => (
                        <TableRow key={`${s.dag_id}/${s.task_id}`}>
                          <TableCell>
                            <Link href={linkTo({ page: 'dag', dagId: s.dag_id })}>{s.dag_id}</Link>
                          </TableCell>
                          <TableCell sx={{ fontFamily: '"Roboto Mono", ui-monospace, monospace' }}>
                            {s.task_id}
                          </TableCell>
                          <TableCell align="right">{formatDuration(s.slot_seconds)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Panel>
            </Box>
          </Stack>

          <HistoryNote
            api={api}
            envId={envId}
            rangeFrom={b.range.from}
            kinds={['task_instances', 'metrics']}
            healthHref={linkTo({ page: 'health' })}
          />
          <ProvenanceFooter
            dataAsOf={b.data_as_of}
            sources={b.sources}
            note={`${
              b.snapshot_interval_seconds === null
                ? 'fewer than two live snapshots in this range, so their cadence is not known yet'
                : `live snapshots every ${formatCadence(b.snapshot_interval_seconds)}`
            }; pre-queue reasons only from DCAM's own collection`}
          />
        </>
      )}
    </Stack>
  );
}
