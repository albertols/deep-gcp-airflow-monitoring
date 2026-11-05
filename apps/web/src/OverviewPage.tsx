/**
 * Capacity overview (M0): the first slice of the DAG league table (spec §12.4 S-05, FR-DAGX-02/03).
 *
 * @implements HM-003, HM-011, FR-DAGX-03, FR-UI-05, FR-UI-07, FR-UI-08
 */
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { InfoPopover } from '@dcam/ui-kit';
import { useState } from 'react';
import type { DcamApi, OverviewRange } from './api';
import { EXPLANATIONS, type ExplanationId } from './explanations';

/** Every panel on this page; a test checks each has an explanation (FR-UI-05). */
export const PANELS: readonly ExplanationId[] = ['hm-003-slot-seconds', 'hm-011-peak-concurrency', 'fr-dagx-03-pareto', 'top-dags'];

const hours = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const int = new Intl.NumberFormat('en-US');

function PanelTitle({ id }: { id: ExplanationId }) {
  const e = EXPLANATIONS[id];
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <Typography variant="body2" color="text.secondary" component="h2">
        {e.title}
      </Typography>
      <InfoPopover explanation={e} />
    </Stack>
  );
}

function Kpi({ id, value, unit }: { id: ExplanationId; value: string; unit?: string }) {
  return (
    <Paper sx={{ p: 4, flex: '1 1 220px' }}>
      <PanelTitle id={id} />
      <Typography sx={{ fontSize: '2rem', fontVariantNumeric: 'tabular-nums', mt: 1 }}>
        {value}
        {unit && (
          <Typography component="span" variant="body1" color="text.secondary" sx={{ ml: 1 }}>
            {unit}
          </Typography>
        )}
      </Typography>
    </Paper>
  );
}

export function OverviewPage({ api, envId }: { api: DcamApi; envId: string }) {
  const [range, setRange] = useState<OverviewRange>('24h');
  const overview = useQuery({ queryKey: ['overview', envId, range], queryFn: () => api.getOverview(envId, range) });

  return (
    <Stack spacing={4}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
        <Typography variant="h1">Capacity overview</Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={range}
          aria-label="Time range"
          onChange={(_e, value: OverviewRange | null) => value && setRange(value)}
        >
          <ToggleButton value="1h">1 h</ToggleButton>
          <ToggleButton value="6h">6 h</ToggleButton>
          <ToggleButton value="24h">24 h</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {overview.isError && (
        <Alert severity="error">
          Couldn't load the overview: {(overview.error as Error).message}. Check that DCAM is still running, then reload the page.
        </Alert>
      )}

      {overview.isPending && <Skeleton variant="rounded" height={120} aria-label="Loading overview" />}

      {overview.data && (
        <>
          <Stack direction="row" sx={{ gap: 4, flexWrap: 'wrap' }}>
            <Kpi id="hm-003-slot-seconds" value={hours.format(overview.data.total_executor_slot_seconds / 3600)} unit="slot-hours" />
            <Kpi id="hm-011-peak-concurrency" value={int.format(overview.data.peak_concurrency)} unit="running tries" />
            <Kpi
              id="fr-dagx-03-pareto"
              value={`${int.format(overview.data.pareto_80_dag_count)} of ${int.format(overview.data.dag_count)}`}
              unit="DAGs"
            />
          </Stack>

          <Paper sx={{ p: 4 }}>
            <PanelTitle id="top-dags" />
            <Table size="small" aria-label="Top DAGs by slot-hours">
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell>
                  <TableCell>DAG</TableCell>
                  <TableCell align="right">Slot-hours</TableCell>
                  <TableCell sx={{ width: '35%' }}>Share of environment</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {overview.data.top_dags.map((d, i) => (
                  <TableRow key={d.dag_id} hover>
                    <TableCell>{i + 1}</TableCell>
                    <TableCell sx={{ fontFamily: '"Roboto Mono", ui-monospace, monospace' }}>{d.dag_id}</TableCell>
                    <TableCell align="right">{hours.format(d.executor_slot_seconds / 3600)}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                        <Box sx={{ flex: 1 }}>
                          <LinearProgress variant="determinate" value={Math.min(100, d.share * 100)} aria-label={`${d.dag_id} share`} />
                        </Box>
                        <Typography variant="body2" sx={{ minWidth: 48, textAlign: 'right' }}>
                          {pct.format(d.share)}
                        </Typography>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>

          <Typography variant="caption" color="text.secondary" component="footer">
            Data as of {new Date(overview.data.data_as_of).toUTCString()} · Source:{' '}
            {overview.data.sources.map((s) => (s === 'DEMO' ? 'demo data' : s)).join(', ')}
          </Typography>
        </>
      )}
    </Stack>
  );
}
