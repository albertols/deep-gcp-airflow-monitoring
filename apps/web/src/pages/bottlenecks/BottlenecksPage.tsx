/**
 * S-16 "Why is work waiting?": waiting task-time attributed to the limit that binds (HM-006), with
 * worker capacity, pool pressure and sensor waste.
 *
 * @implements FR-BOTL-01, FR-BOTL-02, FR-BOTL-07, FR-BOTL-09, FR-UI-05, FR-UI-07, FR-UI-08
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
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
import type { Bottlenecks, Range, WaitReasonId } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import { Legend, StackedBars, ValueBars } from '../../components/charts';
import { formatDuration, formatInt, formatShare } from '../../components/format';
import { PageHeader } from '../../components/PageHeader';
import { Kpi, KpiRow, Panel, ProvenanceFooter, QueryState } from '../../components/Panel';
import type { PageProps } from '../types';
import { BOTTLENECK_EXPLANATIONS as X } from './explanations';
import { CHART_SERIES, REASONS, type ChartSeriesKey } from './reasons';

const minutes = (seconds: number) => seconds / 60;
const fmtMinutes = (m: number) => `${formatInt(Math.round(m))} min`;
const taskHours = (seconds: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(
    seconds / 3600,
  );

/** "15-minute" for 900 s. */
const bucketName = (seconds: number) => (seconds % 60 === 0 ? `${seconds / 60}-minute` : `${seconds}-second`);

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
  const [range, setRange] = useState<Range>('24h');
  const [asTable, setAsTable] = useState(false);
  const q = useQuery({
    queryKey: ['bottlenecks', envId, range],
    queryFn: () => api.getBottlenecks(envId, range),
  });
  const b = q.data;
  const buckets = useMemo(() => (b ? seriesBuckets(b) : []), [b]);
  const present = CHART_SERIES.filter((s) => buckets.some((x) => (x.values[s.key] ?? 0) > 0));
  const bucketLabel = b ? bucketName(b.bucket_seconds) : '';

  return (
    <Stack spacing={4}>
      <PageHeader
        title="Bottlenecks"
        subtitle="Why ready work is not running: waiting attributed to the limit that binds."
        range={range}
        onRangeChange={setRange}
      />
      <QueryState isPending={q.isPending} error={q.error} what="the bottleneck analysis" />
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
                . {REASONS[b.answer.reason].action}
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
              value={formatInt(Math.round(b.capacity.minutes_at_max_workers))}
              unit="min"
              hint={`Workers ${b.current.workers.current} of ${b.current.workers.max} max`}
            />
            {b.capacity.capacity_bound_minutes === null ? (
              // HM-032: without worker_concurrency the slots, and so "queued ≥ 20 % of slots", are unknown.
              <Kpi
                explanation={X['botl-capacity-bound']}
                value="Not known yet"
                hint="worker_concurrency is not known (no override in the Composer configuration)"
              />
            ) : (
              <Kpi
                explanation={X['botl-capacity-bound']}
                value={formatInt(Math.round(b.capacity.capacity_bound_minutes))}
                unit="min"
              />
            )}
            <Kpi
              explanation={X['botl-scale-lag']}
              value={formatDuration(b.capacity.scale_up_lag_p95_seconds)}
            />
          </KpiRow>

          <Panel
            explanation={X['botl-waiting-chart']}
            actions={
              <Button size="small" onClick={() => setAsTable((v) => !v)}>
                {asTable ? 'View waiting as a chart' : 'View waiting as a table'}
              </Button>
            }
          >
            <Stack spacing={2}>
              <Legend series={present} label="Legend: waiting by reason" />
              {asTable ? (
                <Box sx={{ maxHeight: 360, overflow: 'auto' }}>
                  <Table size="small" stickyHeader aria-label="Waiting task-minutes per bucket">
                    <TableHead>
                      <TableRow>
                        <TableCell>Bucket (UTC)</TableCell>
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
                          <TableCell>{new Date(x.start).toISOString().slice(11, 16)}</TableCell>
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

          <Stack direction={{ xs: 'column', lg: 'row' }} sx={{ gap: 4 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Panel explanation={X['botl-pools']}>
                <Table size="small" aria-label="Pools">
                  <TableHead>
                    <TableRow>
                      <TableCell>Pool</TableCell>
                      <TableCell align="right">Slots</TableCell>
                      <TableCell align="right">Waiting (task-h)</TableCell>
                      <TableCell align="right">Starved (min)</TableCell>
                      <TableCell align="right">Fill p95</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {b.pools.map((p) => (
                      <TableRow key={p.name}>
                        <TableCell sx={{ fontFamily: '"Roboto Mono", ui-monospace, monospace' }}>
                          {p.name}
                        </TableCell>
                        <TableCell align="right">{formatInt(p.slots)}</TableCell>
                        <TableCell align="right">{taskHours(p.waiting_task_seconds)}</TableCell>
                        <TableCell align="right">{formatInt(Math.round(p.starved_minutes))}</TableCell>
                        <TableCell align="right">{formatShare(p.utilisation_p95)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Panel>
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

          <ProvenanceFooter
            dataAsOf={b.data_as_of}
            sources={b.sources}
            note={`live snapshots every ${b.snapshot_interval_seconds} s; pre-queue reasons only from DCAM's own collection`}
          />
        </>
      )}
    </Stack>
  );
}
