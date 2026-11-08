/**
 * S-04 detail panels: workers against min_count and max_count with the scale events and scale-up lag (HM-012),
 * the limits with where DCAM read each one (HM-032: unknown reads as unknown, never as zero), worker CPU and
 * memory against their limits with the workload types not collected, and pool slots (FR-ENV-08).
 *
 * @implements FR-ENV-02, FR-ENV-08, HM-012, HM-032, NFR-DATA-03
 */
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { Capacity, LimitSource, Spread } from '@dcam/contracts';
import { formatDuration, formatInt, formatShare } from '../../components/format';
import { Panel } from '../../components/Panel';
import { usePageParam, useTimeFormat } from '../../components/view';
import { capacityColours } from './colours';
import { CAPACITY_EXPLANATIONS as X } from './explanations';
import {
  LIMIT_SOURCE,
  NO_DATA,
  UNKNOWN,
  bucketName,
  formatCount,
  spreadP95,
  workerCountSource,
} from './format';
import { ChartKey, LineKey, SwatchKey, TimeChart } from './TimeChart';

const MONO = { fontFamily: '"Roboto Mono", ui-monospace, monospace' } as const;
/** Scale events listed; the contract keeps the newest 200. */
const EVENTS_SHOWN = 20;

function lagText(s: Spread): string {
  if (s.samples === 0) return 'Scale-up lag: no scale-up in this range.';
  const p95 = spreadP95(s, (v) => formatDuration(v));
  const episodes = `${formatInt(s.samples)} episode${s.samples === 1 ? '' : 's'}`;
  return p95.lowSample
    ? `Scale-up lag ${p95.value ?? NO_DATA} (low sample: ${episodes})`
    : `Scale-up lag p95 ${p95.value ?? NO_DATA} (${episodes})`;
}

export function WorkersPanel({ c }: { c: Capacity }) {
  const theme = useTheme();
  const time = useTimeFormat();
  const colours = capacityColours(theme.palette.mode);
  const [view, setView] = usePageParam('workers', 'chart');
  const asTable = view === 'table';
  const ev = c.scale_events;
  const { min_workers: min, max_workers: max } = c.limits;
  const events = [...ev.items].reverse().slice(0, EVENTS_SHOWN);
  const counts = `${formatInt(ev.up)} scale-up${ev.up === 1 ? '' : 's'} and ${formatInt(ev.down)} scale-down${ev.down === 1 ? '' : 's'}`;
  const source = workerCountSource(c.slots_source);
  return (
    <Panel
      explanation={X['cap-workers']}
      actions={
        <Button size="small" onClick={() => setView(asTable ? 'chart' : 'table')}>
          {asTable ? 'View workers as a chart' : 'View workers as a table'}
        </Button>
      }
    >
      <Stack spacing={2}>
        <ChartKey label="Legend: workers">
          <SwatchKey color={colours.running} label="Workers (mean)" />
          <LineKey color={colours.queued} dash="5 3" label="Autoscaler target (highest)" />
          <LineKey color={theme.palette.text.secondary} dash="6 4" label="max_count" />
          <LineKey color={theme.palette.text.secondary} dash="2 3" label="min_count" />
        </ChartKey>
        {asTable ? (
          <Box sx={{ maxHeight: 360, overflow: 'auto' }}>
            <Table size="small" stickyHeader aria-label="Workers per bucket">
              <TableHead>
                <TableRow>
                  <TableCell>{`Bucket start (${time.zoneName(c.series[0]?.start)})`}</TableCell>
                  <TableCell align="right">Workers (mean)</TableCell>
                  <TableCell align="right">Workers (most)</TableCell>
                  <TableCell align="right">Autoscaler target</TableCell>
                  <TableCell align="right">Minutes at max_count</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {c.series.map((b) => (
                  <TableRow key={b.start}>
                    <TableCell>{time.dayClock(b.start)}</TableCell>
                    <TableCell align="right">{formatCount(b.workers_mean)}</TableCell>
                    <TableCell align="right">{formatCount(b.workers_max)}</TableCell>
                    <TableCell align="right">{formatCount(b.target_max)}</TableCell>
                    <TableCell align="right">{formatCount(b.minutes_at_max)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        ) : (
          <TimeChart
            starts={c.series.map((b) => Date.parse(b.start))}
            bucketMs={c.bucket_seconds * 1000}
            height={180}
            label={`Workers per ${bucketName(c.bucket_seconds)} bucket against min_count ${min} and max_count ${max}. ${ev.evaluated ? `${counts}.` : 'Scale events not evaluated.'}`}
            format={(v) => formatCount(v)}
            bars={[
              {
                key: 'workers',
                label: 'Workers (mean)',
                color: colours.running,
                values: c.series.map((b) => b.workers_mean),
              },
            ]}
            lines={[
              {
                key: 'target',
                label: 'Autoscaler target (highest)',
                color: colours.queued,
                dash: '5 3',
                values: c.series.map((b) => b.target_max),
              },
            ]}
            limits={[
              {
                key: 'max',
                label: `max_count ${max}`,
                value: max,
                color: theme.palette.text.secondary,
                dash: '6 4',
              },
              {
                key: 'min',
                label: `min_count ${min}`,
                value: min,
                color: theme.palette.text.secondary,
                dash: '2 3',
              },
            ]}
          />
        )}
        {source && (
          <Typography variant="caption" color="text.secondary">
            {source}
          </Typography>
        )}
        {ev.evaluated ? (
          <>
            <Typography variant="body2">
              {counts} in this range. {lagText(c.summary.scale_up_lag_seconds)}
            </Typography>
            {events.length > 0 && (
              <>
                {ev.items.length > events.length && (
                  <Typography variant="caption" color="text.secondary">
                    The newest {formatInt(events.length)} of {formatInt(ev.items.length)} changes.
                  </Typography>
                )}
                <Box sx={{ maxHeight: 280, overflow: 'auto' }}>
                  <Table size="small" stickyHeader aria-label="Scale events">
                    <TableHead>
                      <TableRow>
                        <TableCell>{`Time (${time.zoneName(events[0]?.at)})`}</TableCell>
                        <TableCell align="right">Workers</TableCell>
                        <TableCell>Change</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {events.map((e) => (
                        <TableRow key={e.at}>
                          <TableCell>{time.dayClock(e.at)}</TableCell>
                          <TableCell align="right">
                            {e.from} → {e.to}
                          </TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              variant="outlined"
                              label={e.to > e.from ? 'Up' : 'Down'}
                              color={e.to > e.from ? 'info' : 'default'}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              </>
            )}
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Not evaluated: {ev.not_evaluated_reason}
          </Typography>
        )}
      </Stack>
    </Panel>
  );
}

interface LimitRow {
  readonly name: string;
  readonly code: boolean;
  readonly what: string;
  readonly value: string;
  readonly source: string;
  readonly unknown: boolean;
}

const known = (v: number | null, unit = '') => (v === null ? UNKNOWN : `${formatInt(v)}${unit}`);
const sourceOf = (s: LimitSource) => LIMIT_SOURCE[s];

export function LimitsPanel({ c }: { c: Capacity }) {
  const l = c.limits;
  const rows: LimitRow[] = [
    {
      name: 'worker_concurrency',
      code: true,
      what: '[celery]: task instances one worker runs at once',
      value: known(l.worker_concurrency),
      source: sourceOf(l.worker_concurrency_source),
      unknown: l.worker_concurrency === null,
    },
    {
      name: 'Workers',
      code: false,
      what: 'min_count to max_count of the autoscaler',
      value: `${formatInt(l.min_workers)} to ${formatInt(l.max_workers)}`,
      source: 'Environment configuration',
      unknown: false,
    },
    {
      name: 'Worker slots at max_count',
      code: false,
      what: 'max_count × worker_concurrency',
      value: known(l.worker_slots_at_max),
      source: l.worker_slots_at_max === null ? 'Needs worker_concurrency' : 'Computed',
      unknown: l.worker_slots_at_max === null,
    },
    {
      name: 'parallelism',
      code: true,
      what: '[core]: running and queued task instances one scheduler allows',
      value: l.parallelism === null ? UNKNOWN : `${formatInt(l.parallelism)} per scheduler`,
      source: sourceOf(l.parallelism_source),
      unknown: l.parallelism === null,
    },
    {
      name: 'Schedulers',
      code: false,
      what: 'scheduler count',
      value: formatInt(l.schedulers),
      source: 'Environment configuration',
      unknown: false,
    },
    {
      name: 'parallelism × schedulers',
      code: false,
      what: 'running and queued task instances the schedulers allow together',
      value: known(l.parallelism_total),
      source: l.parallelism_total === null ? 'Needs parallelism' : 'Computed',
      unknown: l.parallelism_total === null,
    },
  ];
  const anyUnknown = rows.some((r) => r.unknown);
  return (
    <Panel explanation={X['cap-limits']}>
      <Table size="small" aria-label="Limits">
        <TableHead>
          <TableRow>
            <TableCell>Limit</TableCell>
            <TableCell align="right">Value</TableCell>
            <TableCell>Source</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.name}>
              <TableCell>
                <Box component={r.code ? 'code' : 'span'} sx={r.code ? MONO : undefined}>
                  {r.name}
                </Box>
                <Typography variant="caption" color="text.secondary" component="div">
                  {r.what}
                </Typography>
              </TableCell>
              <TableCell align="right" sx={{ color: r.unknown ? 'text.secondary' : undefined }}>
                {r.value}
              </TableCell>
              <TableCell>{r.source}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {anyUnknown && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
          Unknown limits have no value here, and the figures that need them say so instead of guessing
          (HM-032).
        </Typography>
      )}
    </Panel>
  );
}

const WORKLOAD_NAMES: Readonly<Record<Capacity['workloads_not_collected'][number], string>> = {
  scheduler: 'scheduler',
  triggerer: 'triggerer',
  'dag-processor': 'DAG processor',
  'web-server': 'web server',
};

const listText = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

function spreadCells(s: Spread, samples: number) {
  if (samples === 0 || s.samples === 0) return [NO_DATA, NO_DATA, NO_DATA];
  const p95 = spreadP95(s, (v) => formatShare(v));
  return [
    s.p50 === null ? NO_DATA : formatShare(s.p50),
    p95.lowSample ? `Low sample, ${p95.value ?? NO_DATA}` : (p95.value ?? NO_DATA),
    s.max === null ? NO_DATA : formatShare(s.max),
  ];
}

export function WorkloadsPanel({ c }: { c: Capacity }) {
  return (
    <Panel explanation={X['cap-workloads']}>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" aria-label="CPU and memory against limits">
          <TableHead>
            <TableRow>
              <TableCell>Workload</TableCell>
              <TableCell align="right">CPU p50</TableCell>
              <TableCell align="right">CPU p95</TableCell>
              <TableCell align="right">CPU max</TableCell>
              <TableCell align="right">Memory p50</TableCell>
              <TableCell align="right">Memory p95</TableCell>
              <TableCell align="right">Memory max</TableCell>
              <TableCell align="right">Samples</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {c.workloads.map((w) => (
              <TableRow key={w.workload}>
                <TableCell>{w.workload === 'celery-worker' ? 'Celery workers' : w.workload}</TableCell>
                {[...spreadCells(w.cpu, w.samples), ...spreadCells(w.memory, w.samples)].map((v, i) => (
                  <TableCell key={i} align="right">
                    {v}
                  </TableCell>
                ))}
                <TableCell align="right">{formatInt(w.samples)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
        Usage ÷ limit per one-minute sample from Cloud Monitoring.
        {c.workloads_not_collected.length > 0 &&
          ` Not collected yet: ${listText(c.workloads_not_collected.map((w) => WORKLOAD_NAMES[w]))}.`}
      </Typography>
    </Panel>
  );
}

export function PoolSlotsPanel({ c }: { c: Capacity }) {
  return (
    <Panel explanation={X['cap-pools']}>
      {c.pools.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No pools are known for this environment yet. They appear after the first live snapshot.
        </Typography>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Pool slots">
            <TableHead>
              <TableRow>
                <TableCell>Pool</TableCell>
                <TableCell align="right">Slots</TableCell>
                <TableCell align="right">Running slots (mean)</TableCell>
                <TableCell align="right">Running slots (peak)</TableCell>
                <TableCell align="right">Queued slots (mean)</TableCell>
                <TableCell align="right">Starved minutes</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {c.pools.map((p) => (
                <TableRow key={p.name}>
                  <TableCell sx={MONO}>{p.name}</TableCell>
                  <TableCell align="right">{formatInt(p.slots)}</TableCell>
                  <TableCell align="right">{formatCount(p.running_slots_avg)}</TableCell>
                  <TableCell align="right">{formatCount(p.running_slots_peak)}</TableCell>
                  <TableCell align="right">{formatCount(p.queued_slots_avg)}</TableCell>
                  <TableCell align="right">{formatCount(p.starved_minutes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Panel>
  );
}
