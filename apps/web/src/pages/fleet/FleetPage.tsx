/**
 * S-02 fleet: every environment at a glance with an explainable health score.
 *
 * @implements FR-FLEET-01, FR-FLEET-02, FR-UI-01, FR-UI-05, FR-UI-07, FR-UI-08
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlined from '@mui/icons-material/ErrorOutlined';
import HelpOutlineOutlined from '@mui/icons-material/HelpOutlineOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import type { FleetCard, HealthCheck } from '@dcam/contracts';
import { InfoPopover, type Explanation } from '@dcam/ui-kit';
import { formatInt, formatSlotHours } from '../../components/format';
import { PageHeader } from '../../components/PageHeader';
import { PanelTitle, ProvenanceFooter, QueryState } from '../../components/Panel';
import { useRefresh, useView } from '../../components/view';
import { linkTo as hrefFor } from '../../router';
import { REASONS } from '../bottlenecks/reasons';
import type { PageProps } from '../types';
import { FLEET_EXPLANATIONS as X } from './explanations';

const LABEL = {
  healthy: { text: 'Healthy', color: 'success', Icon: CheckCircleOutlined },
  degraded: { text: 'Degraded', color: 'warning', Icon: WarningAmberOutlined },
  unhealthy: { text: 'Unhealthy', color: 'error', Icon: ErrorOutlined },
  // HM-028 coverage gate: too few checks have data for a score; neutral, never "healthy".
  partial: { text: 'Partial', color: 'default', Icon: HelpOutlineOutlined },
  unknown: { text: 'Unknown', color: 'default', Icon: HelpOutlineOutlined },
} as const;

const CHECK_STATE: Record<HealthCheck['state'], string> = { pass: 'Pass', fail: 'Fail', unknown: 'No data' };

/**
 * The platform line of a card in plain words (§12.12). A self-managed Airflow (the emulator) has no
 * Composer image; the collectors report `none (self-managed Airflow)` for it, and `unknown` until the
 * configuration is read.
 */
export function platformLine(env: Pick<FleetCard, 'composer_image' | 'airflow_version'>): string {
  const airflow =
    env.airflow_version === 'unknown' ? 'Airflow version not known yet' : `Airflow ${env.airflow_version}`;
  if (env.composer_image.startsWith('none')) return `Self-managed ${airflow}`;
  if (env.composer_image === 'unknown') return `Composer image not known yet · ${airflow}`;
  return `${env.composer_image} · ${airflow}`;
}

function Metric({
  label,
  value,
  unit,
  explanation,
}: {
  label: string;
  value: string;
  unit?: string;
  explanation: Explanation;
}) {
  return (
    <Box sx={{ minWidth: 120 }}>
      <Stack direction="row" sx={{ alignItems: 'center' }}>
        <Typography variant="caption" color="text.secondary" component="p">
          {label}
        </Typography>
        <InfoPopover explanation={explanation} />
      </Stack>
      <Typography sx={{ fontVariantNumeric: 'tabular-nums', fontSize: '1.125rem' }}>
        {value}
        {unit && (
          <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
            {unit}
          </Typography>
        )}
      </Typography>
    </Box>
  );
}

function EnvironmentCard({ env }: { env: FleetCard }) {
  const [open, setOpen] = useState(false);
  const view = useView();
  const status = LABEL[env.health.label];
  const link = (page: 'bottlenecks' | 'dags' | 'advisor' | 'alerts' | 'overview') =>
    hrefFor({ page }, env.env_id, view);
  const headingId = `fleet-${env.env_id}`;

  return (
    <Paper component="section" aria-labelledby={headingId} sx={{ p: 4, flex: '1 1 360px', minWidth: 0 }}>
      <Stack spacing={3}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography id={headingId} variant="h2" component="h2">
            {env.display_name}
          </Typography>
          <Chip size="small" variant="outlined" label={env.tier.toUpperCase()} />
          <Box sx={{ flex: 1 }} />
          <Chip
            size="small"
            color={status.color}
            icon={<status.Icon fontSize="small" />}
            label={
              env.health.label === 'partial'
                ? `Partial: ${env.health.evaluated} of ${env.health.total} checks`
                : status.text
            }
          />
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {platformLine(env)}
        </Typography>

        <Stack direction="row" sx={{ alignItems: 'flex-end', gap: 2 }}>
          <Typography sx={{ fontSize: '2.25rem', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {env.health.score === null ? '—' : env.health.score}
          </Typography>
          <Box>
            <PanelTitle explanation={X['fleet-health']} component="h3" />
            <Typography variant="caption" color="text.secondary">
              {env.health.evaluated} of {env.health.total} checks evaluated
            </Typography>
          </Box>
        </Stack>
        <Box>
          <Button size="small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Hide the checks' : `Show the ${env.health.total} checks`}
          </Button>
          {open && (
            <Table size="small" aria-label={`Health checks for ${env.display_name}`}>
              <TableHead>
                <TableRow>
                  <TableCell>Check</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell>Healthy when</TableCell>
                  <TableCell align="right">Value</TableCell>
                  <TableCell align="right">Weight</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {env.health.checks.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      {c.label}
                      {c.critical ? ' (critical)' : ''}
                    </TableCell>
                    <TableCell>{CHECK_STATE[c.state]}</TableCell>
                    <TableCell>{c.threshold}</TableCell>
                    <TableCell align="right">{c.value ?? '—'}</TableCell>
                    <TableCell align="right">{c.weight}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Box>

        <Stack direction="row" sx={{ gap: 4, flexWrap: 'wrap' }}>
          <Metric
            explanation={X['fleet-load']}
            label="Running · queued"
            value={`${formatInt(env.running)} · ${formatInt(env.queued)}`}
          />
          <Metric
            explanation={X['fleet-workers']}
            label="Workers"
            value={`${env.workers.current} of ${env.workers.max} max`}
          />
          <Metric
            explanation={X['fleet-activity']}
            label="Slot-hours (24 h)"
            value={formatSlotHours(env.slot_seconds_24h)}
          />
          <Metric
            explanation={X['fleet-activity']}
            label="Waiting task-hours (24 h)"
            value={formatSlotHours(env.waiting_task_seconds_24h)}
          />
          <Metric
            explanation={X['fleet-activity']}
            label="Failed tries (24 h)"
            value={formatInt(env.failures_24h)}
          />
        </Stack>

        <Box>
          <PanelTitle explanation={X['fleet-bottleneck']} component="h3" />
          <Typography variant="body2">
            {env.top_reason ? REASONS[env.top_reason].label : 'No waiting on platform limits'}
          </Typography>
        </Box>

        <Box>
          <PanelTitle explanation={X['fleet-findings']} component="h3" />
          {env.top_findings.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No open findings.
            </Typography>
          ) : (
            <Stack component="ul" spacing={1} sx={{ m: 0, pl: 4 }}>
              {env.top_findings.map((f) => (
                <li key={f.id}>
                  <Link href={link('advisor')} variant="body2">
                    {f.rule_id} · {f.title}
                  </Link>
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    {f.severity}
                  </Typography>
                </li>
              ))}
            </Stack>
          )}
        </Box>

        <Stack direction="row" sx={{ gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          <Link href={link('alerts')} variant="body2">
            {env.alerts_firing === 1 ? '1 alert firing' : `${env.alerts_firing} alerts firing`}
          </Link>
          <Box sx={{ flex: 1 }} />
          <Link href={link('overview')} variant="body2">
            Capacity
          </Link>
          <Link href={link('dags')} variant="body2">
            DAG league table
          </Link>
          <Link href={link('bottlenecks')} variant="body2">
            Bottlenecks
          </Link>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Data as of {view.time.full(env.data_as_of)}
        </Typography>
      </Stack>
    </Paper>
  );
}

export function FleetPage({ api }: PageProps) {
  const q = useQuery({ queryKey: ['fleet'], queryFn: () => api.getFleet(), ...useRefresh() });
  return (
    <Stack spacing={4}>
      <PageHeader
        title="Fleet"
        subtitle="Every environment at a glance: health, load and what holds work back."
      />
      <QueryState isPending={q.isPending} error={q.error} what="the fleet" />
      {q.data && (
        <>
          {q.data.environments.length === 0 ? (
            <Typography color="text.secondary">
              No environments are configured. Add one to dcam.config.yaml, then restart DCAM.
            </Typography>
          ) : (
            <Stack direction="row" sx={{ gap: 4, flexWrap: 'wrap', alignItems: 'stretch' }}>
              {q.data.environments.map((env) => (
                <EnvironmentCard key={env.env_id} env={env} />
              ))}
            </Stack>
          )}
          <ProvenanceFooter dataAsOf={q.data.data_as_of} sources={q.data.sources} />
        </>
      )}
    </Stack>
  );
}
