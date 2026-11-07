/**
 * Priority fairness (HM-023, the observed part): observed waits per priority_weight band within each
 * pool, with the §8.9 low-sample rule; the starvation ratio is shown as not computed, with its reason.
 *
 * @implements HM-023, FR-UI-05, FR-UI-07, FR-UI-08
 */
import { Fragment } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { Bottlenecks, PriorityFairness } from '@dcam/contracts';
import { formatDuration, formatInt } from '../../components/format';
import { Panel, ProvenanceFooter } from '../../components/Panel';
import { DEPTH_EXPLANATIONS as X } from './explanations-depth';

type Band = PriorityFairness['pools'][number]['bands'][number];

const BAND: Readonly<Record<Band['band'], string>> = { low: 'Low', mid: 'Middle', high: 'High' };
const MONO = { fontFamily: '"Roboto Mono", ui-monospace, monospace' } as const;
const weights = (b: Band) =>
  b.min_weight === b.max_weight ? `${b.min_weight}` : `${b.min_weight}–${b.max_weight}`;

function Body({ p }: { p: PriorityFairness }) {
  const banded = p.pools.filter((x) => x.bands.length > 1);
  const single = p.pools.filter((x) => x.bands.length <= 1 && x.tries > 0).length;
  return (
    <>
      {banded.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {p.pools.length === 0
            ? 'No task instance waited in a live snapshot in this range, so there is nothing to compare.'
            : 'In every pool the waiting task instances share one priority weight, so priority cannot favour some over others.'}
        </Typography>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Observed wait by priority band">
            <TableHead>
              <TableRow>
                <TableCell>Pool</TableCell>
                <TableCell>Band</TableCell>
                <TableCell align="right">priority_weight</TableCell>
                <TableCell align="right">Tries</TableCell>
                <TableCell align="right">Observed wait p50</TableCell>
                <TableCell align="right">p95</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {banded.map((pool) => (
                <Fragment key={pool.pool}>
                  {pool.bands.map((b, i) => (
                    <TableRow key={`${pool.pool}/${b.band}`}>
                      <TableCell sx={MONO}>{i === 0 ? pool.pool : ''}</TableCell>
                      <TableCell>{BAND[b.band]}</TableCell>
                      <TableCell align="right">{weights(b)}</TableCell>
                      <TableCell align="right">{formatInt(b.tries)}</TableCell>
                      <TableCell align="right">{formatDuration(b.wait_p50_seconds)}</TableCell>
                      <TableCell
                        align="right"
                        title={b.p95_low_sample ? 'Fewer than 20 tries: this is the maximum' : undefined}
                      >
                        {b.wait_p95_seconds === null
                          ? '—'
                          : `${b.p95_low_sample ? '≤ ' : ''}${formatDuration(b.wait_p95_seconds)}`}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      {single > 0 && banded.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          {single === 1
            ? '1 pool uses one priority weight only and is not listed.'
            : `${formatInt(single)} pools use one priority weight only and are not listed.`}
        </Typography>
      )}
      {!p.starvation_ratio_evaluated && (
        <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
          Starvation ratio not computed yet. {p.not_evaluated_reason}
        </Alert>
      )}
    </>
  );
}

export function PriorityPanel({ b }: { b: Bottlenecks }) {
  const p = b.priority_fairness;
  return (
    <Panel explanation={X['botl-priority']}>
      {p ? (
        <Body p={p} />
      ) : (
        <Typography variant="body2" color="text.secondary">
          Priority fairness is not available from this DCAM server. Update DCAM to see it.
        </Typography>
      )}
      <Box sx={{ mt: 2 }}>
        <ProvenanceFooter
          as="p"
          dataAsOf={b.data_as_of}
          sources={b.sources}
          note={`${p ? `method ${p.method}: ` : ''}observed waits are lower bounds at snapshot resolution`}
        />
      </Box>
    </Panel>
  );
}
