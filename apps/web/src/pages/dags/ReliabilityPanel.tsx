/**
 * Failures, retries and flakiness (HM-015, FR-TASK-02): run and try failure rates, retry and flaky rates and
 * time to recovery for the DAG, and per task, flakiest first. Rates need 20 samples; below that the count
 * is shown. Error signatures need Cloud Logging and are marked unavailable. The task table exports as CSV
 * with the counts behind every rate (FR-STORE-04).
 *
 * @implements HM-015, FR-TASK-02, FR-UI-05, FR-UI-07, FR-UI-08, FR-STORE-04
 */
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { DagDetail, TaskReliability } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import type { DcamApi } from '../../api';
import type { CsvColumn } from '../../components/csv';
import { ExportCsvButton } from '../../components/ExportCsv';
import { Kpi, KpiRow, Panel, ProvenanceFooter } from '../../components/Panel';
import { formatDuration, formatInt, formatShare } from '../../components/format';
import { DEPTH_EXPLANATIONS as E, type DepthExplanationId } from './depth-explanations';
import { TaskHistoryFreshness } from './TaskHistoryFreshness';

const MONO = '"Roboto Mono", ui-monospace, monospace';

/** A rate, or the count it would divide when there are fewer than 20 samples (HM-015). */
const rateOrCount = (rate: number | null, part: number, whole: number) =>
  rate !== null ? formatShare(rate) : `${formatInt(part)} of ${formatInt(whole)}`;
const LOW = 'Fewer than 20: a count, not a rate';

function recoveryHint(recoveries: number, unrecovered: number, what: string): string {
  if (recoveries === 0 && unrecovered === 0) return `No failed ${what} in the range`;
  const mean = recoveries === 0 ? `No failed ${what} recovered yet` : `Mean of ${formatInt(recoveries)}`;
  return unrecovered > 0 ? `${mean}; ${formatInt(unrecovered)} not recovered yet` : mean;
}

function Kpis({ r }: { r: NonNullable<DagDetail['reliability']> }) {
  const t = r.tasks;
  return (
    <KpiRow>
      <Kpi
        explanation={E['dagd-rel-run-failure']}
        value={rateOrCount(r.run_failure_rate, r.failed_runs, r.finished_runs)}
        hint={`${formatInt(r.failed_runs)} of ${formatInt(r.finished_runs)} finished runs failed`}
      />
      <Kpi
        explanation={E['dagd-rel-try-failure']}
        value={rateOrCount(t.try_failure_rate, t.failed_tries, t.tries)}
        hint={`${formatInt(t.failed_tries)} of ${formatInt(t.tries)} tries`}
      />
      <Kpi
        explanation={E['dagd-rel-retry']}
        value={rateOrCount(t.retry_rate, t.retried, t.task_instances)}
        hint={`${formatInt(t.retried)} of ${formatInt(t.task_instances)} task instances retried`}
      />
      <Kpi
        explanation={E['dagd-rel-flaky']}
        value={rateOrCount(t.flaky_rate, t.flaky, t.task_instances)}
        hint={`${formatInt(t.flaky)} of ${formatInt(t.task_instances)} task instances${
          t.flaky_inferred > 0 ? `; ${formatInt(t.flaky_inferred)} inferred from the try number` : ''
        }`}
      />
      <Kpi
        explanation={E['dagd-rel-mttr']}
        value={formatDuration(r.run_mttr_seconds)}
        hint={recoveryHint(r.run_recoveries, r.run_unrecovered, 'runs')}
      />
    </KpiRow>
  );
}

const COLUMNS: ReadonlyArray<{ id: DepthExplanationId; numeric: boolean }> = [
  { id: 'dagd-rel-col-task', numeric: false },
  { id: 'dagd-rel-col-instances', numeric: true },
  { id: 'dagd-rel-col-failed', numeric: true },
  { id: 'dagd-rel-col-retry', numeric: true },
  { id: 'dagd-rel-col-flaky', numeric: true },
  { id: 'dagd-rel-col-mttr', numeric: true },
];

type TaskRow = { readonly taskId: string; readonly r: TaskReliability };

/** Flakiest first (a missing rate last), then most failed tries, then by task ID. */
function ordered(tasks: DagDetail['tasks']): TaskRow[] {
  return tasks
    .flatMap((t) => (t.reliability ? [{ taskId: t.task_id, r: t.reliability }] : []))
    .sort(
      (a, b) =>
        (b.r.flaky_rate ?? -1) - (a.r.flaky_rate ?? -1) ||
        b.r.failed_tries - a.r.failed_tries ||
        a.taskId.localeCompare(b.taskId),
    );
}

/** The task table as CSV: counts and rates (null below 20 samples), mean time to recover in seconds. */
const RELIABILITY_CSV: readonly CsvColumn<TaskRow>[] = [
  { name: 'task_id', value: (x) => x.taskId },
  { name: 'task_instances', value: (x) => x.r.task_instances },
  { name: 'tries', value: (x) => x.r.tries },
  { name: 'failed_tries', value: (x) => x.r.failed_tries },
  { name: 'try_failure_rate_ratio', value: (x) => x.r.try_failure_rate },
  { name: 'retried', value: (x) => x.r.retried },
  { name: 'retry_rate_ratio', value: (x) => x.r.retry_rate },
  { name: 'flaky', value: (x) => x.r.flaky },
  { name: 'flaky_inferred', value: (x) => x.r.flaky_inferred },
  { name: 'flaky_rate_ratio', value: (x) => x.r.flaky_rate },
  { name: 'recoveries', value: (x) => x.r.recoveries },
  { name: 'unrecovered', value: (x) => x.r.unrecovered },
  { name: 'mttr_seconds', value: (x) => x.r.mttr_seconds },
];

function TaskTable({ rows }: { rows: readonly TaskRow[] }) {
  return (
    <TableContainer sx={{ maxHeight: 420 }}>
      <Table size="small" stickyHeader aria-label="Task reliability">
        <TableHead>
          <TableRow>
            {COLUMNS.map((c) => (
              <TableCell key={c.id} align={c.numeric ? 'right' : 'left'} sx={{ whiteSpace: 'nowrap' }}>
                {E[c.id].title}
                <InfoPopover explanation={E[c.id]} />
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(({ taskId, r }) => (
            <TableRow key={taskId} hover>
              <TableCell sx={{ fontFamily: MONO }}>{taskId}</TableCell>
              <TableCell align="right">{formatInt(r.task_instances)}</TableCell>
              <TableCell
                align="right"
                title={r.try_failure_rate === null ? LOW : `${formatShare(r.try_failure_rate)} of tries`}
              >
                {`${formatInt(r.failed_tries)} of ${formatInt(r.tries)}`}
              </TableCell>
              <TableCell align="right" title={r.retry_rate === null ? LOW : undefined}>
                {rateOrCount(r.retry_rate, r.retried, r.task_instances)}
              </TableCell>
              <TableCell
                align="right"
                title={
                  r.flaky_rate === null
                    ? LOW
                    : r.flaky_inferred > 0
                      ? `${formatInt(r.flaky_inferred)} of ${formatInt(r.flaky)} inferred from the try number`
                      : undefined
                }
              >
                {rateOrCount(r.flaky_rate, r.flaky, r.task_instances)}
              </TableCell>
              <TableCell align="right" title={recoveryHint(r.recoveries, r.unrecovered, 'tries')}>
                {formatDuration(r.mttr_seconds)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function ReliabilityPanel({ detail, api, envId }: { detail: DagDetail; api: DcamApi; envId: string }) {
  const r = detail.reliability;
  const rows = ordered(detail.tasks);
  return (
    <Panel
      explanation={E['dagd-reliability']}
      actions={
        <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <TaskHistoryFreshness api={api} envId={envId} />
          <ExportCsvButton
            view="task-reliability"
            what="Task reliability"
            rows={rows}
            columns={RELIABILITY_CSV}
          />
        </Stack>
      }
    >
      {r === undefined ? (
        <Typography variant="body2" color="text.secondary">
          This DCAM server does not report this yet. Update DCAM to see failures, retries and flakiness.
        </Typography>
      ) : (
        <Stack spacing={3}>
          <Kpis r={r} />
          {rows.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No task of this DAG ran in the range. Pick a longer range to see failures and retries.
            </Typography>
          ) : (
            <TaskTable rows={rows} />
          )}
          <Typography variant="caption" color="text.secondary">
            Error signatures need Cloud Logging, which DCAM does not read yet. Open a failed try&apos;s log in
            the Airflow UI to see its error.
          </Typography>
          <ProvenanceFooter
            dataAsOf={detail.data_as_of}
            sources={detail.sources}
            note="Rates from 20 samples; counts below that"
          />
        </Stack>
      )}
    </Panel>
  );
}
