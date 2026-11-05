/**
 * DCAM health: what DCAM collects from each environment, how fresh it is, what fails and how many
 * requests DCAM itself makes. Demo mode has no collectors, so the page says that nothing is collected.
 *
 * @implements FR-SELF-01, FR-COLL-11, FR-COLL-06, HM-030, NFR-OBS-06, FR-UI-05, FR-UI-07, FR-UI-08
 */
import { useQuery } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Chip, { type ChipProps } from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import DoNotDisturbOnOutlined from '@mui/icons-material/DoNotDisturbOnOutlined';
import ErrorOutlined from '@mui/icons-material/ErrorOutlined';
import HourglassTopOutlined from '@mui/icons-material/HourglassTopOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import type { ApiFootprint, CollectionEnvironment, CollectorStatus } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import { COLLECTION_POLL_MS, useCollection } from '../../components/collection';
import { formatBytes, formatDuration, formatInt, formatShare } from '../../components/format';
import { PageHeader } from '../../components/PageHeader';
import { PanelTitle, QueryState, SOURCE_NAMES } from '../../components/Panel';
import { SnippetBlock } from '../advisor/SnippetBlock';
import type { PageProps } from '../types';
import { HEALTH_EXPLANATIONS as X, type HealthExplanationId } from './explanations';

type State = CollectorStatus['state'];
const STATE: Readonly<
  Record<State, { label: string; color: ChipProps['color']; Icon: ComponentType<SvgIconProps> }>
> = {
  ok: { label: 'OK', color: 'success', Icon: CheckCircleOutlined },
  waiting: { label: 'Waiting', color: 'default', Icon: HourglassTopOutlined },
  degraded: { label: 'Degraded', color: 'warning', Icon: WarningAmberOutlined },
  failing: { label: 'Failing', color: 'error', Icon: ErrorOutlined },
  disabled: { label: 'Disabled', color: 'default', Icon: DoNotDisturbOnOutlined },
};
const PROFILE: Readonly<Record<CollectionEnvironment['profile'], string>> = {
  live: 'Live profile',
  standard: 'Standard profile',
  eco: 'Eco profile',
  off: 'Collection off',
};
const API: Readonly<Record<ApiFootprint['api'], string>> = {
  airflow: SOURCE_NAMES['SRC-AF-API'],
  composer: SOURCE_NAMES['SRC-COMPOSER'],
  monitoring: SOURCE_NAMES['SRC-MON'],
};
const MINUTES = { '1h': 60, '24h': 24 * 60 } as const;
const mono = { fontFamily: '"Roboto Mono", ui-monospace, monospace' };
const numeric = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } as const;

/**
 * A time as "5m ago" or "in 20s", with the absolute time in a tooltip. Relative to the time of the
 * status, not the browser clock, so a late refresh never shows a wrong age.
 */
function RelativeTime({ iso, label }: { iso: string; label: string }) {
  return (
    <Tooltip title={new Date(iso).toUTCString()} describeChild>
      <Box component="time" dateTime={iso} tabIndex={0} sx={{ whiteSpace: 'nowrap' }}>
        {label}
      </Box>
    </Tooltip>
  );
}

function Ago({ iso, reference }: { iso: string | null; reference: number }) {
  if (iso === null) return <>Never</>;
  const seconds = Math.max(0, (reference - Date.parse(iso)) / 1000);
  return <RelativeTime iso={iso} label={seconds < 1 ? 'just now' : `${formatDuration(seconds)} ago`} />;
}

function NextRun({ iso, reference }: { iso: string | null; reference: number }) {
  if (iso === null) return <>Not scheduled</>;
  const seconds = (Date.parse(iso) - reference) / 1000;
  return <RelativeTime iso={iso} label={seconds < 1 ? 'Due now' : `in ${formatDuration(seconds)}`} />;
}

/** A column header with its (i) explanation (FR-UI-05). */
function HeaderCell({ id, align }: { id: HealthExplanationId; align?: 'right' }) {
  return (
    <TableCell align={align} sx={{ verticalAlign: 'bottom' }}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}
      >
        <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
          {X[id].title}
        </Box>
        <InfoPopover explanation={X[id]} />
      </Stack>
    </TableCell>
  );
}

function StateChip({ state }: { state: State }) {
  const s = STATE[state];
  return (
    <Chip
      size="small"
      variant="outlined"
      color={s.color}
      icon={<s.Icon fontSize="small" data-testid={`collector-state-${state}`} />}
      label={s.label}
    />
  );
}

function LastError({ collector, reference }: { collector: CollectorStatus; reference: number }) {
  const error = collector.last_error;
  if (error === null) return <>—</>;
  return (
    <Stack spacing={1} sx={{ minWidth: 280, maxWidth: 480 }}>
      <Typography variant="body2">{error.message}</Typography>
      <Typography variant="caption" color="text.secondary" component="p">
        <Box component="span" sx={mono}>
          {error.kind}
        </Box>{' '}
        · <Ago iso={error.at} reference={reference} />
      </Typography>
      {error.fix_hint !== null && (
        <SnippetBlock
          snippet={{ title: 'How to fix', code: error.fix_hint }}
          copyLabel={`Copy the fix for ${collector.id}`}
        />
      )}
    </Stack>
  );
}

function CollectorsTable({ env, reference }: { env: CollectionEnvironment; reference: number }) {
  if (env.collectors.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        No collector runs for this environment. Check its profile in dcam.config.yaml.
      </Typography>
    );
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label={`Collectors for ${env.env_id}`}>
        <TableHead>
          <TableRow>
            <TableCell>Collector</TableCell>
            <TableCell>Source</TableCell>
            <TableCell>State</TableCell>
            <HeaderCell id="health-last-success" />
            <HeaderCell id="health-next-run" />
            <HeaderCell id="health-lag" align="right" />
            <HeaderCell id="health-cadence" />
            <HeaderCell id="health-failures" align="right" />
            <HeaderCell id="health-error-rate" align="right" />
            <TableCell>Last error</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {env.collectors.map((c) => (
            <TableRow key={c.id} sx={{ verticalAlign: 'top' }}>
              <TableCell sx={{ ...mono, whiteSpace: 'nowrap' }}>{c.id}</TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{SOURCE_NAMES[c.source]}</TableCell>
              <TableCell>
                <StateChip state={c.state} />
              </TableCell>
              <TableCell>
                <Ago iso={c.last_success_at} reference={reference} />
              </TableCell>
              <TableCell>
                <NextRun iso={c.next_run_at} reference={reference} />
              </TableCell>
              <TableCell align="right" sx={numeric}>
                {formatDuration(c.lag_seconds)}
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                {c.cadence_seconds > 0 ? `every ${formatDuration(c.cadence_seconds)}` : '—'}
              </TableCell>
              <TableCell align="right" sx={numeric}>
                {formatInt(c.consecutive_failures)}
              </TableCell>
              <TableCell align="right" sx={numeric}>
                {formatShare(c.error_rate_1h)}
              </TableCell>
              <TableCell>
                <LastError collector={c} reference={reference} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

/** Requests in a window and their share of the budget for that window. */
function Requests({ count, perMinute, window }: { count: number; perMinute: number; window: '1h' | '24h' }) {
  const budget = perMinute * MINUTES[window];
  return (
    <>
      {formatInt(count)}
      <Typography variant="caption" color="text.secondary" component="p" sx={numeric}>
        {budget > 0 ? `${formatShare(count / budget)} of ${formatInt(budget)}` : 'no budget'}
      </Typography>
    </>
  );
}

function FootprintTable({ env }: { env: CollectionEnvironment }) {
  if (env.footprint.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        DCAM has made no requests for this environment yet.
      </Typography>
    );
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label={`Requests to each API from ${env.env_id}`}>
        <TableHead>
          <TableRow>
            <TableCell>API</TableCell>
            <HeaderCell id="health-budget" align="right" />
            <HeaderCell id="health-requests-1h" align="right" />
            <HeaderCell id="health-requests-24h" align="right" />
            <HeaderCell id="health-errors-24h" align="right" />
            <HeaderCell id="health-bytes-24h" align="right" />
            <HeaderCell id="health-p95-latency" align="right" />
          </TableRow>
        </TableHead>
        <TableBody>
          {env.footprint.map((f) => (
            <TableRow key={f.api} sx={{ verticalAlign: 'top' }}>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{API[f.api]}</TableCell>
              <TableCell align="right" sx={numeric}>
                {formatInt(f.budget_per_minute)} per min
              </TableCell>
              <TableCell align="right" sx={numeric}>
                <Requests count={f.requests_1h} perMinute={f.budget_per_minute} window="1h" />
              </TableCell>
              <TableCell align="right" sx={numeric}>
                <Requests count={f.requests_24h} perMinute={f.budget_per_minute} window="24h" />
              </TableCell>
              <TableCell align="right" sx={numeric}>
                {formatInt(f.errors_24h)}
              </TableCell>
              <TableCell align="right" sx={numeric}>
                {formatBytes(f.bytes_24h)}
              </TableCell>
              <TableCell align="right" sx={numeric}>
                {f.p95_latency_ms === null ? '—' : `${formatInt(Math.round(f.p95_latency_ms))} ms`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

function EnvironmentHealth({
  env,
  name,
  reference,
}: {
  env: CollectionEnvironment;
  name: string;
  reference: number;
}) {
  const headingId = `health-${env.env_id}`;
  return (
    <Paper component="section" aria-labelledby={headingId} sx={{ p: 4, minWidth: 0 }}>
      <Stack spacing={4}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography id={headingId} variant="h2" component="h2">
            {name}
          </Typography>
          <Chip size="small" variant="outlined" label={PROFILE[env.profile]} />
          <InfoPopover explanation={X['health-profile']} />
        </Stack>

        {env.failing && (
          <Alert severity="error" variant="outlined">
            <AlertTitle>Collection failing</AlertTitle>
            At least one collector failed three or more cycles in a row, so pages for this environment can
            show older data. Read the last error and its fix below, then run <code>pnpm dcam doctor</code> to
            check access.
          </Alert>
        )}
        {env.reduced_fidelity && (
          <Alert severity="warning" variant="outlined">
            <AlertTitle>Reduced fidelity</AlertTitle>
            DCAM slowed collection to stay within its request budget: a budget ran out in the last 15 minutes.
            Some data can be older than the cadences below. If this lasts, choose a lighter profile for this
            environment in dcam.config.yaml.
          </Alert>
        )}

        <Box>
          <PanelTitle explanation={X['health-collectors']} component="h3" />
          <CollectorsTable env={env} reference={reference} />
        </Box>
        <Box>
          <PanelTitle explanation={X['health-footprint']} component="h3" />
          <FootprintTable env={env} />
        </Box>
        <Box>
          <PanelTitle explanation={X['health-series']} component="h3" />
          <Typography sx={{ fontSize: '1.5rem', fontVariantNumeric: 'tabular-nums' }}>
            {env.series_24h === null ? (
              'Not used'
            ) : (
              <>
                {formatInt(env.series_24h)}{' '}
                <Typography component="span" variant="body1" color="text.secondary">
                  series
                </Typography>
              </>
            )}
          </Typography>
        </Box>
      </Stack>
    </Paper>
  );
}

/** Demo mode has no collectors: say so in plain words, and how to see real collection health. */
function DemoNote() {
  return (
    <Paper component="section" aria-labelledby="health-demo" sx={{ p: 4 }}>
      <Stack spacing={2}>
        <Typography id="health-demo" variant="h2" component="h2">
          Demo mode collects nothing
        </Typography>
        <Typography variant="body2">
          Demo data is simulated on this computer, so DCAM collects nothing and sends no request to Google
          Cloud or Airflow. There are no collectors and no requests to show.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          To see collection health for your own environments, create <code>dcam.config.yaml</code> from{' '}
          <code>dcam.config.example.yaml</code>, then start DCAM with <code>pnpm dcam</code> instead of{' '}
          <code>pnpm dcam --demo</code>.
        </Typography>
      </Stack>
    </Paper>
  );
}

export function HealthPage({ api }: PageProps) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.getMeta() });
  const q = useCollection(api);
  const names = new Map(meta.data?.environments.map((e) => [e.env_id, e.display_name]));
  const c = q.data;

  return (
    <Stack spacing={4}>
      <PageHeader
        title="DCAM health"
        subtitle="What DCAM collects from each environment, how fresh it is, what fails and how many requests DCAM makes."
      />
      <QueryState isPending={q.isPending} error={q.error} what="collection health" />
      {c?.mode === 'demo' && <DemoNote />}
      {c?.mode === 'live' && (
        <>
          {c.environments.length === 0 ? (
            <Typography color="text.secondary">
              No environments are configured. Add one to dcam.config.yaml, then restart DCAM.
            </Typography>
          ) : (
            c.environments.map((env) => (
              <EnvironmentHealth
                key={env.env_id}
                env={env}
                name={names.get(env.env_id) ?? env.env_id}
                reference={Date.parse(c.generated_at)}
              />
            ))
          )}
          <Typography variant="caption" color="text.secondary" component="footer">
            Status as of {new Date(c.generated_at).toUTCString()} · Source: DCAM&apos;s own request log ·
            Refreshed every {COLLECTION_POLL_MS / 1000} s
          </Typography>
        </>
      )}
    </Stack>
  );
}
