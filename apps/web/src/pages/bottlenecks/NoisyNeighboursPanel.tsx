/**
 * Noisy neighbours (HM-017, FR-BOTL-06, M3 demo step 2): DAGs whose heavy running is associated with
 * longer queue waits of other DAGs, with effect, bootstrap interval, confidence and overlap windows. The
 * wording stays with association: the method cannot show cause. The table exports as CSV (FR-STORE-04).
 *
 * @implements FR-BOTL-06, HM-017, FR-UI-05, FR-UI-07, FR-UI-08, FR-STORE-04
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { Bottlenecks, NoisyNeighbours } from '@dcam/contracts';
import { csvList, isoUtc, type CsvColumn } from '../../components/csv';
import { ExportCsvButton } from '../../components/ExportCsv';
import { formatDuration, formatInt, formatShare } from '../../components/format';
import { Panel, ProvenanceFooter } from '../../components/Panel';
import type { TimeFormat } from '../../components/time';
import { useTimeFormat } from '../../components/view';
import type { PageProps } from '../types';
import { DEPTH_EXPLANATIONS as X } from './explanations-depth';

type Confidence = NoisyNeighbours['items'][number]['confidence'];

const CONFIDENCE: Readonly<Record<Confidence, { label: string; color: 'success' | 'warning' | 'default' }>> =
  {
    high: { label: 'High', color: 'success' },
    medium: { label: 'Medium', color: 'warning' },
    low: { label: 'Low', color: 'default' },
  };

/** A signed duration: `+10s`, `−5s`. */
const signed = (seconds: number) => `${seconds < 0 ? '−' : '+'}${formatDuration(Math.abs(seconds))}`;
const unsigned = (seconds: number) =>
  seconds < 0 ? `−${formatDuration(-seconds)}` : formatDuration(seconds);
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
/** Overlap windows the table shows, and the file holds, per DAG. */
const WINDOWS_SHOWN = 3;

type Item = NoisyNeighbours['items'][number];

/** The table as CSV: effect and interval in seconds, windows as ISO 8601 UTC intervals. */
const NOISY_CSV: readonly CsvColumn<Item>[] = [
  { name: 'dag_id', value: (x) => x.dag_id },
  { name: 'effect_seconds', value: (x) => x.effect_seconds },
  { name: 'ci_low_seconds', value: (x) => x.ci_low_seconds },
  { name: 'ci_high_seconds', value: (x) => x.ci_high_seconds },
  { name: 'confidence', value: (x) => x.confidence },
  { name: 'median_wait_active_seconds', value: (x) => x.median_wait_active_seconds },
  { name: 'median_wait_inactive_seconds', value: (x) => x.median_wait_inactive_seconds },
  { name: 'affected_tries', value: (x) => x.affected_tries },
  { name: 'affected_minutes', value: (x) => x.affected_minutes },
  { name: 'control_tries', value: (x) => x.control_tries },
  { name: 'matched_share_ratio', value: (x) => x.matched_share },
  { name: 'active_minutes', value: (x) => x.active_minutes },
  { name: 'associated_wait_task_minutes', value: (x) => x.associated_wait_task_minutes },
  {
    name: 'overlap_windows_utc',
    value: (x) =>
      csvList(x.overlap_windows.slice(0, WINDOWS_SHOWN).map((w) => `${isoUtc(w.from)}/${isoUtc(w.to)}`)),
  },
];

/** An overlap window as `5 Nov, 01:00–01:30 UTC` in the context bar's zone. */
function windowText(w: { from: string; to: string }, time: TimeFormat): string {
  const end = time.day(w.from) === time.day(w.to) ? time.clock(w.to) : time.dayClock(w.to);
  return `${time.dayClock(w.from)}–${end} ${time.zoneName(w.from)}`;
}

function Body({ n, linkTo }: { n: NoisyNeighbours; linkTo: PageProps['linkTo'] }) {
  const time = useTimeFormat();
  if (!n.evaluated)
    return (
      <Alert severity="info" variant="outlined">
        Not evaluated in this range. {n.not_evaluated_reason}
      </Alert>
    );
  if (n.items.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        {n.qualified === 0
          ? `No DAG met the minimum samples: ${formatInt(n.candidates)} held at least ${formatShare(n.active_share)} of the worker slots at some point, but a DAG needs ${formatInt(n.min_active_minutes)} active minutes and ${formatInt(n.min_affected_tries)} affected tries of other DAGs. Choose a longer range to collect more.`
          : `${formatInt(n.qualified)} DAGs met the minimum samples, and none was associated with longer queue waits of other DAGs.`}
      </Typography>
    );
  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        While these DAGs held at least {formatShare(n.active_share)} of the worker slots, other DAGs' tries
        waited longer in the queue. They are associated with the longer waits; check the overlap windows
        before you move or cap one.
      </Typography>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" aria-label="DAGs associated with longer queue waits">
          <TableHead>
            <TableRow>
              <TableCell>DAG</TableCell>
              <TableCell align="right">Median wait of others</TableCell>
              <TableCell align="right">95 % interval</TableCell>
              <TableCell>Confidence</TableCell>
              <TableCell align="right">Affected tries</TableCell>
              <TableCell align="right">Active min</TableCell>
              <TableCell align="right">Associated wait (task-min)</TableCell>
              <TableCell>When it was active (UTC)</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {n.items.map((x) => (
              <TableRow key={x.dag_id}>
                <TableCell>
                  <Link href={linkTo({ page: 'dag', dagId: x.dag_id })}>{x.dag_id}</Link>
                </TableCell>
                <TableCell
                  align="right"
                  title={`${formatDuration(x.median_wait_active_seconds)} while active, ${formatDuration(x.median_wait_inactive_seconds)} otherwise`}
                >
                  {signed(x.effect_seconds)}
                </TableCell>
                <TableCell align="right">
                  {x.ci_low_seconds === null || x.ci_high_seconds === null
                    ? '—'
                    : `${unsigned(x.ci_low_seconds)} to ${unsigned(x.ci_high_seconds)}`}
                </TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    variant="outlined"
                    color={CONFIDENCE[x.confidence].color}
                    label={CONFIDENCE[x.confidence].label}
                  />
                  {x.confidence === 'low' && (
                    <Typography variant="caption" color="text.secondary" component="div">
                      No clear association
                    </Typography>
                  )}
                </TableCell>
                <TableCell align="right">{formatInt(x.affected_tries)}</TableCell>
                <TableCell align="right">{formatInt(x.active_minutes)}</TableCell>
                <TableCell align="right">≈ {oneDecimal.format(x.associated_wait_task_minutes)}</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  {x.overlap_windows.length === 0
                    ? '—'
                    : x.overlap_windows
                        .slice(0, WINDOWS_SHOWN)
                        .map((w) => windowText(w, time))
                        .join(', ')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </>
  );
}

export function NoisyNeighboursPanel({ b, linkTo }: { b: Bottlenecks; linkTo: PageProps['linkTo'] }) {
  const n = b.noisy_neighbours;
  return (
    <Panel
      explanation={X['botl-noisy-neighbours']}
      actions={
        <ExportCsvButton
          view="noisy-neighbours"
          what="DAGs associated with longer queue waits"
          rows={n?.evaluated ? n.items : []}
          columns={NOISY_CSV}
        />
      }
    >
      {n?.evaluated && n.slots_source === 'hostnames' && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Estimated worker slots: without Cloud Monitoring, DCAM counts workers from the hostnames of running
          tasks, a lower bound. A DAG may look more active than it was; check that Cloud Monitoring is
          collected on the DCAM health page.
        </Typography>
      )}
      {n ? (
        <Body n={n} linkTo={linkTo} />
      ) : (
        <Typography variant="body2" color="text.secondary">
          The noisy-neighbour analysis is not available from this DCAM server. Update DCAM to see it.
        </Typography>
      )}
      <Box sx={{ mt: 2 }}>
        <ProvenanceFooter
          as="p"
          dataAsOf={b.data_as_of}
          sources={b.sources}
          note={
            n
              ? `method ${n.method}: queue wait (HM-001) matched by hour of the week; ${formatInt(n.resamples)} bootstrap resamples; association, not cause`
              : 'association, not cause'
          }
        />
      </Box>
    </Panel>
  );
}
