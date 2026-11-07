/**
 * Noisy neighbours (HM-017, FR-BOTL-06, M3 demo step 2): DAGs whose heavy running is associated with
 * longer queue waits of other DAGs, with effect, bootstrap interval, confidence and overlap windows. The
 * wording stays with association: the method cannot show cause.
 *
 * @implements FR-BOTL-06, HM-017, FR-UI-05, FR-UI-07, FR-UI-08
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
import { formatDuration, formatInt, formatShare } from '../../components/format';
import { Panel, ProvenanceFooter } from '../../components/Panel';
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
const hhmm = (iso: string) => iso.slice(11, 16);
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function Body({ n, linkTo }: { n: NoisyNeighbours; linkTo: PageProps['linkTo'] }) {
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
                        .slice(0, 3)
                        .map((w) => `${hhmm(w.from)}–${hhmm(w.to)}`)
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
    <Panel explanation={X['botl-noisy-neighbours']}>
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
