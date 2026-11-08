/**
 * Top contributors per throttle reason (HM-006 output, M3 demo step 2): the DAGs and the pools whose
 * waiting task instances make up the selected reason, with their shares. Both tables export as CSV
 * (FR-STORE-04).
 *
 * @implements FR-BOTL-01, HM-006, FR-UI-05, FR-UI-07, FR-UI-08, FR-STORE-04
 */
import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { Bottlenecks, WaitReasonId } from '@dcam/contracts';
import type { CsvColumn } from '../../components/csv';
import { ExportCsvButton } from '../../components/ExportCsv';
import { formatShare } from '../../components/format';
import { Panel, ProvenanceFooter } from '../../components/Panel';
import type { PageProps } from '../types';
import { DEPTH_EXPLANATIONS as X } from './explanations-depth';
import { REASONS } from './reasons';
import { usePageParam } from '../../components/view';

const MONO = { fontFamily: '"Roboto Mono", ui-monospace, monospace' } as const;
const taskHours = (seconds: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(
    seconds / 3600,
  );

type Reason = Bottlenecks['reasons'][number];
type Contributor = Reason['top_contributors'][number];
type PoolContributor = NonNullable<Reason['top_pools']>[number];

/** The DAGs table as CSV: waiting task-seconds and share of the selected reason. */
const dagCsv = (reason: WaitReasonId): readonly CsvColumn<Contributor>[] => [
  { name: 'reason_id', value: () => reason },
  { name: 'dag_id', value: (c) => c.dag_id },
  { name: 'waiting_task_seconds', value: (c) => c.waiting_task_seconds },
  { name: 'share_ratio', value: (c) => c.share },
];

const poolCsv = (reason: WaitReasonId): readonly CsvColumn<PoolContributor>[] => [
  { name: 'reason_id', value: () => reason },
  { name: 'pool', value: (p) => p.pool },
  { name: 'waiting_task_seconds', value: (p) => p.waiting_task_seconds },
  { name: 'share_ratio', value: (p) => p.share },
];

/** An export button above a table, at its right edge. */
function TableActions({ children }: { children: ReactNode }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'flex-end', mb: 1 }}>
      {children}
    </Stack>
  );
}

function ShareCell({ share, label }: { share: number; label: string }) {
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
      <LinearProgress variant="determinate" value={share * 100} sx={{ flex: 1 }} aria-label={label} />
      <Typography variant="body2" sx={{ minWidth: 48, textAlign: 'right' }}>
        {formatShare(share)}
      </Typography>
    </Stack>
  );
}

export function TopContributorsPanel({ b, linkTo }: { b: Bottlenecks; linkTo: PageProps['linkTo'] }) {
  const withWaiting = b.reasons.filter((r) => r.evaluated && r.waiting_task_seconds > 0);
  const [picked, setPicked] = usePageParam('reason');
  const selected =
    withWaiting.find((r) => r.id === picked) ??
    withWaiting.find((r) => r.id === b.answer.reason) ??
    withWaiting[0];

  return (
    <Panel explanation={X['botl-top-contributors']}>
      {!selected ? (
        <Typography variant="body2" color="text.secondary">
          No work waited on a platform limit in this range, so nothing contributed to a limit. Choose a longer
          range to look further back.
        </Typography>
      ) : (
        <Stack spacing={3}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={selected.id}
            aria-label="Reason"
            onChange={(_e, next: WaitReasonId | null) => next && setPicked(next)}
            sx={{ flexWrap: 'wrap' }}
          >
            {withWaiting.map((r) => (
              <ToggleButton key={r.id} value={r.id}>
                {REASONS[r.id].label} · {formatShare(r.share)}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Stack direction={{ xs: 'column', md: 'row' }} sx={{ gap: 4 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <TableActions>
                <ExportCsvButton
                  view="top-dags-per-reason"
                  what="DAGs that waited most"
                  rows={selected.top_contributors}
                  columns={dagCsv(selected.id)}
                />
              </TableActions>
              <Table size="small" aria-label="DAGs that waited most">
                <TableHead>
                  <TableRow>
                    <TableCell>DAG</TableCell>
                    <TableCell align="right">Task-hours</TableCell>
                    <TableCell sx={{ width: '40%' }}>Share of the reason</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {selected.top_contributors.map((c) => (
                    <TableRow key={c.dag_id}>
                      <TableCell>
                        <Link href={linkTo({ page: 'dag', dagId: c.dag_id })}>{c.dag_id}</Link>
                      </TableCell>
                      <TableCell align="right">{taskHours(c.waiting_task_seconds)}</TableCell>
                      <TableCell>
                        <ShareCell share={c.share} label={`${c.dag_id} share`} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {selected.top_pools ? (
                <>
                  <TableActions>
                    <ExportCsvButton
                      view="top-pools-per-reason"
                      what="Pools that waited most"
                      rows={selected.top_pools}
                      columns={poolCsv(selected.id)}
                    />
                  </TableActions>
                  <Table size="small" aria-label="Pools that waited most">
                    <TableHead>
                      <TableRow>
                        <TableCell>Pool</TableCell>
                        <TableCell align="right">Task-hours</TableCell>
                        <TableCell sx={{ width: '40%' }}>Share of the reason</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {selected.top_pools.map((p) => (
                        <TableRow key={p.pool}>
                          <TableCell sx={MONO}>{p.pool}</TableCell>
                          <TableCell align="right">{taskHours(p.waiting_task_seconds)}</TableCell>
                          <TableCell>
                            <ShareCell share={p.share} label={`${p.pool} share`} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Pools per reason are not available from this DCAM server. Update DCAM to see them.
                </Typography>
              )}
            </Box>
          </Stack>
        </Stack>
      )}
      <Box sx={{ mt: 2 }}>
        <ProvenanceFooter
          as="p"
          dataAsOf={b.data_as_of}
          sources={b.sources}
          note="shares of the selected reason's waiting task-time; pre-queue reasons only from DCAM's own snapshots"
        />
      </Box>
    </Panel>
  );
}
