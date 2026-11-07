/**
 * S-24 "Alerts": the default alert pack evaluated locally while DCAM runs, firing and pending first,
 * with fire counts, mean time to resolve and the 24 h history. Read-only: nothing is sent anywhere.
 *
 * @implements FR-ALRT-01, FR-ALRT-02, FR-ALRT-06, FR-UI-05, FR-UI-07, FR-UI-08
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ComponentType } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import HelpOutlineOutlined from '@mui/icons-material/HelpOutlineOutlined';
import HourglassTopOutlined from '@mui/icons-material/HourglassTopOutlined';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import NotificationsActiveOutlined from '@mui/icons-material/NotificationsActiveOutlined';
import RadioButtonUncheckedOutlined from '@mui/icons-material/RadioButtonUncheckedOutlined';
import ReportOutlined from '@mui/icons-material/ReportOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import type { AlertEvent, AlertRule, AlertState, Severity } from '@dcam/contracts';
import { formatDuration, formatInt } from '../../components/format';
import { PageHeader } from '../../components/PageHeader';
import { Kpi, KpiRow, Panel, ProvenanceFooter, QueryState } from '../../components/Panel';
import type { PageProps } from '../types';
import { RUNBOOK_WIKI_PAGES } from '../wiki/content/slugs';
import { ALERT_EXPLANATIONS as X } from './explanations';
import { FiringTimeline } from './FiringTimeline';
import {
  EXPORT_LABEL,
  SEVERITY_LABEL,
  STATES,
  STATE_LABEL,
  firingPeriods,
  formatTime,
  meanTimeToResolve,
  sortRules,
} from './model';

type Icon = ComponentType<SvgIconProps>;
type Tone = 'error.main' | 'warning.main' | 'success.main' | 'info.main' | 'text.secondary';

const STATE_ICON: Readonly<Record<AlertState, { icon: Icon; tone: Tone }>> = {
  firing: { icon: NotificationsActiveOutlined, tone: 'error.main' },
  pending: { icon: HourglassTopOutlined, tone: 'warning.main' },
  resolved: { icon: CheckCircleOutlined, tone: 'success.main' },
  inactive: { icon: RadioButtonUncheckedOutlined, tone: 'text.secondary' },
  unknown: { icon: HelpOutlineOutlined, tone: 'text.secondary' },
};
const SEVERITY_ICON: Readonly<Record<Severity, { icon: Icon; tone: Tone }>> = {
  critical: { icon: ReportOutlined, tone: 'error.main' },
  warning: { icon: WarningAmberOutlined, tone: 'warning.main' },
  info: { icon: InfoOutlined, tone: 'info.main' },
};
const DAY_MS = 86_400_000;
const ALL = 'all';
const mono = { fontFamily: '"Roboto Mono", ui-monospace, monospace' };

/** An icon with its label: state and severity never rely on colour alone (spec §12.5). */
function Labelled({
  icon: I,
  tone,
  label,
  testId,
}: {
  icon: Icon;
  tone: Tone;
  label: string;
  testId?: string;
}) {
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1, whiteSpace: 'nowrap' }}>
      <I fontSize="small" sx={{ color: tone }} aria-hidden data-testid={testId} />
      <Typography variant="body2">{label}</Typography>
    </Stack>
  );
}

/** A value in the rule's unit: durations humanised, percentages and counts with their unit. */
/** Count units of the alert pack in the singular, for a value of exactly one. */
const SINGULAR_UNIT: Readonly<Record<string, string>> = {
  restarts: 'restart',
  'import errors': 'import error',
  'queued tasks': 'queued task',
  'tasks per hour': 'task per hour',
  days: 'day',
};

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '—';
  if (unit === 's') return formatDuration(value);
  const n = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  if (unit === '') return n;
  if (unit === '%') return `${n} %`;
  return `${n} ${(value === 1 && SINGULAR_UNIT[unit]) || unit}`;
}

export function AlertsPage({ api, envId, linkTo }: PageProps) {
  // `null` follows the environment selected in the top bar.
  const [choice, setChoice] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<AlertState | typeof ALL>(ALL);
  const [eventFilter, setEventFilter] = useState<AlertEvent['kind'] | typeof ALL>(ALL);
  const scope = choice ?? envId;
  const filterEnv = scope === ALL ? undefined : scope;

  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.getMeta() });
  const q = useQuery({
    queryKey: ['alerts', scope],
    queryFn: () => api.getAlerts(filterEnv),
  });
  const a = q.data;
  const environments = meta.data?.environments ?? [{ env_id: envId, display_name: envId, tier: 'other' }];

  const view = useMemo(() => {
    if (!a) return null;
    const to = Math.max(Date.parse(a.data_as_of), ...a.events.map((e) => Date.parse(e.at)));
    const units = new Map(a.rules.map((r) => [`${r.env_id}\u0000${r.id}`, r.unit]));
    const count = (s: AlertState) => a.rules.filter((r) => r.state === s).length;
    return {
      to,
      from: to - DAY_MS,
      sorted: sortRules(a.rules),
      counts: Object.fromEntries(STATES.map((s) => [s, count(s)])) as Record<AlertState, number>,
      fired: a.events.filter((e) => e.kind === 'fired').length,
      // Firing now without a "fired" event in the window: it fired earlier, or is a health reading
      // that carries no start time (§16.7). Counted apart, so "firing now" and "fired" agree.
      firingWithoutEvent: a.rules.filter(
        (r) =>
          r.state === 'firing' &&
          !a.events.some((e) => e.kind === 'fired' && e.rule_id === r.id && e.env_id === r.env_id),
      ).length,
      mttr: meanTimeToResolve(a.events),
      unitOf: (e: AlertEvent) => units.get(`${e.env_id}\u0000${e.rule_id}`) ?? '',
    };
  }, [a]);
  const rules = view ? view.sorted.filter((r) => stateFilter === ALL || r.state === stateFilter) : [];
  const events = a ? a.events.filter((e) => eventFilter === ALL || e.kind === eventFilter) : [];
  const many = filterEnv === undefined;

  return (
    <Stack spacing={4}>
      <PageHeader
        title="Alerts"
        subtitle="The default alert pack, evaluated every minute over the last 24 hours. Firing and pending alerts come first."
      >
        <TextField
          select
          size="small"
          label="Show alerts for"
          value={scope}
          onChange={(e) => setChoice(e.target.value)}
          slotProps={{ select: { native: true } }}
          sx={{ minWidth: 200 }}
        >
          <option value={ALL}>All environments</option>
          {environments.map((e) => (
            <option key={e.env_id} value={e.env_id}>
              {e.display_name}
            </option>
          ))}
        </TextField>
      </PageHeader>

      <Alert severity="info" variant="outlined">
        <Typography variant="body2" component="p">
          DCAM evaluates these alerts on this machine, only while DCAM runs, and shows them here. It does not
          page anyone and never changes Cloud Monitoring. Exporting rules as Cloud Monitoring alert policies,
          for round-the-clock coverage, comes later and will be copy-only (FR-ALRT-07).
        </Typography>
      </Alert>

      <QueryState isPending={q.isPending} error={q.error} what="alerts" />
      {a && view && (
        <>
          <KpiRow>
            <Kpi explanation={X['alerts-firing']} value={formatInt(view.counts.firing)} />
            <Kpi explanation={X['alerts-pending']} value={formatInt(view.counts.pending)} />
            <Kpi
              explanation={X['alerts-fired-24h']}
              value={formatInt(view.fired)}
              unit="times"
              hint={
                view.firingWithoutEvent === 0
                  ? undefined
                  : `${formatInt(view.firingWithoutEvent)} firing ${
                      view.firingWithoutEvent === 1 ? 'alert started' : 'alerts started'
                    } before the last 24 h or ${view.firingWithoutEvent === 1 ? 'has' : 'have'} no known start`
              }
            />
            <Kpi
              explanation={X['alerts-mttr']}
              value={formatDuration(view.mttr.seconds)}
              hint={
                view.mttr.count
                  ? `Over ${view.mttr.count} resolved ${view.mttr.count === 1 ? 'alert' : 'alerts'}`
                  : 'No alert resolved in the last 24 h'
              }
            />
            <Kpi
              explanation={X['alerts-unknown']}
              value={formatInt(view.counts.unknown)}
              hint={`of ${formatInt(a.rules.length)} rules`}
            />
          </KpiRow>

          <Panel
            explanation={X['alerts-rules']}
            actions={
              <ToggleButtonGroup
                size="small"
                exclusive
                value={stateFilter}
                aria-label="Filter rules by state"
                onChange={(_e, next: AlertState | typeof ALL | null) => next && setStateFilter(next)}
                sx={{ flexWrap: 'wrap' }}
              >
                <ToggleButton value={ALL}>All ({a.rules.length})</ToggleButton>
                {STATES.map((s) => (
                  <ToggleButton key={s} value={s}>
                    {STATE_LABEL[s]} ({view.counts[s]})
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            }
          >
            {rules.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {stateFilter === ALL
                  ? 'No alert rules are configured for this scope.'
                  : `No rule is ${STATE_LABEL[stateFilter].toLowerCase()} right now. Pick another state to see the rest.`}
              </Typography>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label="Alert rules">
                  <TableHead>
                    <TableRow>
                      <TableCell>State</TableCell>
                      <TableCell>Rule</TableCell>
                      <TableCell>Severity</TableCell>
                      <TableCell>Environment</TableCell>
                      <TableCell>Condition</TableCell>
                      <TableCell align="right">Current value</TableCell>
                      <TableCell>Since</TableCell>
                      <TableCell align="right">Fires (24 h)</TableCell>
                      <TableCell>Runbook</TableCell>
                      <TableCell>Export</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rules.map((r) => (
                      <RuleRow key={`${r.env_id}/${r.id}`} rule={r} asOf={a.data_as_of} linkTo={linkTo} />
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </Panel>

          <Panel explanation={X['alerts-timeline']}>
            <FiringTimeline
              periods={firingPeriods(a.events, a.rules, view.from, view.to)}
              from={view.from}
              to={view.to}
              showEnvironment={many}
            />
          </Panel>

          <Panel
            explanation={X['alerts-history']}
            actions={
              <ToggleButtonGroup
                size="small"
                exclusive
                value={eventFilter}
                aria-label="Filter events"
                onChange={(_e, next: AlertEvent['kind'] | typeof ALL | null) => next && setEventFilter(next)}
              >
                <ToggleButton value={ALL} aria-label="All events">
                  All
                </ToggleButton>
                <ToggleButton value="fired" aria-label="Fired events">
                  Fired
                </ToggleButton>
                <ToggleButton value="resolved" aria-label="Resolved events">
                  Resolved
                </ToggleButton>
              </ToggleButtonGroup>
            }
          >
            {events.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No {eventFilter === ALL ? '' : `${eventFilter} `}events in the last 24 hours.
              </Typography>
            ) : (
              <Box sx={{ maxHeight: 420, overflow: 'auto' }}>
                <Table size="small" stickyHeader aria-label="Alert history">
                  <TableHead>
                    <TableRow>
                      <TableCell>Time</TableCell>
                      <TableCell>Event</TableCell>
                      <TableCell>Rule</TableCell>
                      <TableCell>Severity</TableCell>
                      <TableCell>Environment</TableCell>
                      <TableCell align="right">Value</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {events.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                          {formatTime(e.at, a.data_as_of)}
                        </TableCell>
                        <TableCell>
                          {e.kind === 'fired' ? (
                            <Labelled {...STATE_ICON.firing} label="Fired" />
                          ) : (
                            <Labelled {...STATE_ICON.resolved} label="Resolved" />
                          )}
                        </TableCell>
                        <TableCell sx={mono}>{e.rule_id}</TableCell>
                        <TableCell>
                          <Labelled {...SEVERITY_ICON[e.severity]} label={SEVERITY_LABEL[e.severity]} />
                        </TableCell>
                        <TableCell>{e.env_id}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                          {formatValue(e.value, view.unitOf(e))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </Panel>

          <ProvenanceFooter
            dataAsOf={a.data_as_of}
            sources={a.sources}
            note="evaluated every minute; a source older than 3 × its cadence makes a rule unknown"
          />
        </>
      )}
    </Stack>
  );
}

function RuleRow({ rule: r, asOf, linkTo }: { rule: AlertRule; asOf: string; linkTo: PageProps['linkTo'] }) {
  return (
    <TableRow hover>
      <TableCell>
        <Labelled {...STATE_ICON[r.state]} label={STATE_LABEL[r.state]} testId={`state-icon-${r.state}`} />
      </TableCell>
      <TableCell sx={{ minWidth: 220 }}>
        <Typography variant="body2" sx={mono}>
          {r.id}
        </Typography>
        <Typography variant="body2">{r.name}</Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          {r.summary}
        </Typography>
      </TableCell>
      <TableCell>
        <Labelled {...SEVERITY_ICON[r.severity]} label={SEVERITY_LABEL[r.severity]} />
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.env_id}</TableCell>
      <TableCell sx={{ minWidth: 200 }}>
        <Typography variant="body2">{r.condition}</Typography>
        {r.state === 'pending' && r.for_seconds > 0 && (
          <Typography variant="caption" color="text.secondary" component="p">
            Fires once this has held for {formatDuration(r.for_seconds)}.
          </Typography>
        )}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {formatValue(r.value, r.unit)}
        {r.threshold !== null && (
          <Typography variant="caption" color="text.secondary" component="p">
            threshold {formatValue(r.threshold, r.unit)}
          </Typography>
        )}
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.since ? formatTime(r.since, asOf) : '—'}</TableCell>
      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatInt(r.fired_count_24h)}
      </TableCell>
      <TableCell>
        <RunbookLink id={r.runbook} linkTo={linkTo} />
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{EXPORT_LABEL[r.export_cloud_monitoring]}</TableCell>
    </TableRow>
  );
}

/** A runbook links to its wiki page once that page is written; until then it is named only. */
function RunbookLink({ id, linkTo }: { id: string | null; linkTo: PageProps['linkTo'] }) {
  if (id === null) return <>—</>;
  const slug = (RUNBOOK_WIKI_PAGES as Partial<Record<string, string>>)[id];
  if (slug) return <Link href={linkTo({ page: 'wiki', slug })}>{id}</Link>;
  return (
    <Typography variant="body2" component="span" title="This runbook is not in the wiki yet.">
      {id}
    </Typography>
  );
}
