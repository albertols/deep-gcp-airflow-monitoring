/**
 * S-17 schedule intelligence: where planned and actual DAG run starts fall in the day (UTC), how strongly
 * they collide (HM-009), the minutes and schedules that collide most, and the REC-SCHED-01 findings. Actual
 * starts follow the context bar's range; the heatmap view and table view are in the URL. The heatmaps stay
 * in UTC whatever the time zone toggle says: they are hours of the day of UTC cron schedules.
 *
 * @implements FR-BOTL-03, HM-009, FR-UI-01, FR-UI-02, FR-UI-05, FR-UI-07, FR-UI-08
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
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
import type { Schedule } from '@dcam/contracts';
import { formatInt, formatShare } from '../../components/format';
import { PageHeader } from '../../components/PageHeader';
import { Kpi, KpiRow, Panel, ProvenanceFooter, QueryState } from '../../components/Panel';
import { RANGE_PRESETS } from '../../components/range';
import { usePageParam, useRefresh, useTimeFormat, useView } from '../../components/view';
import type { PageProps } from '../types';
import { SCHEDULE_EXPLANATIONS as X } from './explanations';
import { Heatmap, cellTime, type HeatCell } from './Heatmap';

const MONO = { fontFamily: '"Roboto Mono", ui-monospace, monospace' } as const;
const perDay = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const pad = (n: number) => String(n).padStart(2, '0');

type View = 'planned' | 'actual';

function HeatmapPanel({ s }: { s: Schedule }) {
  const [viewParam, setView] = usePageParam('heatmap', 'planned');
  const view: View = viewParam === 'actual' ? 'actual' : 'planned';
  const [cellsView, setCellsView] = usePageParam('cells', 'chart');
  const asTable = cellsView === 'table';
  const time = useTimeFormat();
  const cells: HeatCell[] = useMemo(
    () =>
      view === 'planned'
        ? s.planned.cells.map((c) => ({ hour: c.hour, minute: c.minute, value: c.starts_per_day }))
        : s.actual.cells.map((c) => ({ hour: c.hour, minute: c.minute, value: c.runs })),
    [s, view],
  );
  const unit = view === 'planned' ? 'starts per day' : 'runs';
  const busiest = [...cells].sort((a, b) => b.value - a.value || a.hour - b.hour || a.minute - b.minute);
  const top = busiest[0];
  const label =
    view === 'planned'
      ? `Planned starts per day by hour and minute (UTC).${top ? ` Busiest: ${cellTime(top)} with ${perDay.format(top.value)} starts per day.` : ''}`
      : `Runs that started by hour and minute (UTC) over the last ${perDay.format(s.actual.days)} days.${top ? ` Busiest: ${cellTime(top)} with ${formatInt(top.value)} runs.` : ''}`;
  const empty =
    view === 'planned'
      ? 'No DAG has a cron schedule yet, so there are no planned starts. Schedules appear after the first DAG inventory; check the collectors on the DCAM health page.'
      : 'No DAG run started in this range. Runs appear once task instances are collected.';
  // NFR-DATA-03: hours before the task history starts are missing, not zero.
  const historyFrom = s.actual.history_from;
  const partial = view === 'actual' && historyFrom && (s.actual.coverage ?? 1) < 1;

  return (
    <Panel
      explanation={X['sched-heatmap']}
      actions={
        <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={view}
            aria-label="Starts"
            onChange={(_e, next: View | null) => next && setView(next)}
          >
            <ToggleButton value="planned">Planned</ToggleButton>
            <ToggleButton value="actual">Actual</ToggleButton>
          </ToggleButtonGroup>
          <Button size="small" onClick={() => setCellsView(asTable ? 'chart' : 'table')}>
            {asTable ? 'View as a heatmap' : 'View as a table'}
          </Button>
        </Stack>
      }
    >
      {cells.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {empty}
        </Typography>
      ) : asTable ? (
        <Box sx={{ maxHeight: 360, overflow: 'auto' }}>
          <Table size="small" stickyHeader aria-label="Busiest cells">
            <TableHead>
              <TableRow>
                <TableCell>Time (UTC)</TableCell>
                <TableCell align="right">{view === 'planned' ? 'Starts per day' : 'Runs'}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {busiest.slice(0, 50).map((c) => (
                <TableRow key={cellTime(c)}>
                  <TableCell>{cellTime(c)}</TableCell>
                  <TableCell align="right">{perDay.format(c.value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      ) : (
        <Heatmap
          cells={cells}
          label={label}
          describe={(c) => `${cellTime(c)} UTC: ${perDay.format(c.value)} ${unit}`}
        />
      )}
      {partial && (
        <Typography variant="caption" color="text.secondary">
          No history before {time.dateTime(historyFrom)}: earlier hours are missing, not zero.
        </Typography>
      )}
    </Panel>
  );
}

function TopMinutesPanel({ s, linkTo }: { s: Schedule; linkTo: PageProps['linkTo'] }) {
  return (
    <Panel explanation={X['sched-top-minutes']}>
      {s.top_minutes.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No planned starts yet, so no minute collides.
        </Typography>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Most colliding minutes">
            <TableHead>
              <TableRow>
                <TableCell>Minute</TableCell>
                <TableCell align="right">Starts per day</TableCell>
                <TableCell align="right">Share of daily starts</TableCell>
                <TableCell align="right">DAGs</TableCell>
                <TableCell>Schedules</TableCell>
                <TableCell>DAGs starting then</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {s.top_minutes.map((m) => (
                <TableRow key={m.minute}>
                  <TableCell>:{pad(m.minute)}</TableCell>
                  <TableCell align="right">{perDay.format(m.starts_per_day)}</TableCell>
                  <TableCell align="right">{formatShare(m.share)}</TableCell>
                  <TableCell align="right">{formatInt(m.dags)}</TableCell>
                  <TableCell>
                    <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
                      {m.schedules.map((x) => (
                        <Chip
                          key={x.schedule}
                          size="small"
                          variant="outlined"
                          sx={MONO}
                          label={`${x.schedule} × ${formatInt(x.dags)}`}
                        />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    {m.top_dags.slice(0, 5).map((d, i) => (
                      <span key={d}>
                        {i > 0 && ', '}
                        <Link href={linkTo({ page: 'dag', dagId: d })}>{d}</Link>
                      </span>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Panel>
  );
}

function SharedSchedulesPanel({ s, linkTo }: { s: Schedule; linkTo: PageProps['linkTo'] }) {
  return (
    <Panel explanation={X['sched-shared']}>
      {s.top_schedules.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No two unpaused DAGs share a cron schedule.
        </Typography>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Shared schedules">
            <TableHead>
              <TableRow>
                <TableCell>Schedule</TableCell>
                <TableCell align="right">DAGs</TableCell>
                <TableCell align="right">Starts per day</TableCell>
                <TableCell>Start minutes</TableCell>
                <TableCell>For example</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {s.top_schedules.map((x) => (
                <TableRow key={x.schedule}>
                  <TableCell sx={MONO}>{x.schedule}</TableCell>
                  <TableCell align="right">{formatInt(x.dags)}</TableCell>
                  <TableCell align="right">{perDay.format(x.starts_per_day)}</TableCell>
                  <TableCell>{x.minutes.map((m) => `:${pad(m)}`).join(', ')}</TableCell>
                  <TableCell>
                    {x.example_dags.slice(0, 3).map((d, i) => (
                      <span key={d}>
                        {i > 0 && ', '}
                        <Link href={linkTo({ page: 'dag', dagId: d })}>{d}</Link>
                      </span>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Panel>
  );
}

function FindingsPanel({
  api,
  envId,
  s,
  linkTo,
}: Pick<PageProps, 'api' | 'envId' | 'linkTo'> & { s: Schedule }) {
  const f = useQuery({
    queryKey: ['findings', envId],
    queryFn: () => api.getFindings(envId),
    ...useRefresh(),
  });
  const list = (f.data?.findings ?? []).filter((x) => x.rule_id === 'REC-SCHED-01');
  return (
    <Panel explanation={X['sched-findings']}>
      <QueryState isPending={f.isPending} error={f.error} what="the schedule findings" height={80} />
      {f.data &&
        (list.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No schedule-collision finding (REC-SCHED-01): fewer than {formatShare(s.collision.threshold)} of
            daily starts fall in one minute, or waiting does not coincide with that minute.
          </Typography>
        ) : (
          <Stack spacing={2}>
            {list.map((x) => (
              <Box key={x.id}>
                <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                  <Chip
                    size="small"
                    color={x.severity === 'critical' ? 'error' : 'warning'}
                    label={x.severity}
                  />
                  <Typography variant="body1">{x.title}</Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {x.observation}
                </Typography>
              </Box>
            ))}
            <Link href={linkTo({ page: 'advisor' })}>Open the advisor for the stagger snippet</Link>
          </Stack>
        ))}
    </Panel>
  );
}

export function SchedulePage({ api, envId, linkTo }: PageProps) {
  const { range } = useView();
  const q = useQuery({
    queryKey: ['schedule', envId, range],
    queryFn: () => api.getSchedule(envId, range),
    ...useRefresh(),
  });
  const s = q.data;
  const busiest = s?.top_minutes.find((m) => m.minute === s.collision.busiest_minute);

  return (
    <Stack spacing={4}>
      <PageHeader
        title="Schedule intelligence"
        subtitle={`${RANGE_PRESETS[range].label} for actual starts. When DAG runs are planned to start and when they started, by hour and minute (UTC). Runs that start in the same minute compete for worker slots and pools.`}
      />
      <QueryState isPending={q.isPending} error={q.error} what="schedule intelligence" range={range} />
      {s && (
        <>
          <KpiRow>
            <Kpi
              explanation={X['sched-collision-index']}
              value={formatShare(s.collision.index)}
              hint={`REC-SCHED-01 fires at ${formatShare(s.collision.threshold)} or more`}
            />
            <Kpi
              explanation={X['sched-busiest-minute']}
              value={s.collision.busiest_minute === null ? 'None' : `:${pad(s.collision.busiest_minute)}`}
              hint={
                busiest
                  ? `${perDay.format(busiest.starts_per_day)} starts per day, ${formatInt(busiest.dags)} DAGs`
                  : undefined
              }
            />
            <Kpi
              explanation={X['sched-daily-starts']}
              value={formatInt(Math.round(s.collision.total_daily_starts))}
              hint={`${formatInt(s.collision.scheduled_dags)} DAGs with a cron schedule; ${formatInt(s.collision.unscheduled_dags)} without a fixed start minute`}
            />
            <Kpi
              explanation={X['sched-runs']}
              value={formatInt(s.actual.runs)}
              hint={`in the last ${RANGE_PRESETS[range].span}, by first task start`}
            />
          </KpiRow>
          <HeatmapPanel s={s} />
          <TopMinutesPanel s={s} linkTo={linkTo} />
          <SharedSchedulesPanel s={s} linkTo={linkTo} />
          <FindingsPanel api={api} envId={envId} s={s} linkTo={linkTo} />
          <ProvenanceFooter
            dataAsOf={s.data_as_of}
            sources={s.sources}
            note="times in UTC (DAG time zones are not collected); planned starts from the DAG inventory, actual starts by first task start"
          />
        </>
      )}
    </Stack>
  );
}
