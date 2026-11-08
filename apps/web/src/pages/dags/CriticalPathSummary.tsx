/**
 * Critical path summary under the run Gantt (HM-007, FR-DAGD-03): the steps of the selected run's path,
 * its running and waiting time, and the tasks most often on the path in the range. Labelled an estimate:
 * DCAM derives it from timing because it has no task dependencies yet.
 *
 * @implements HM-007, FR-DAGD-03 (critical path), NFR-DATA-04
 */
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { DagDetail } from '@dcam/contracts';
import { PanelTitle } from '../../components/Panel';
import { formatDuration, formatInt, formatShare } from '../../components/format';
import { DEPTH_EXPLANATIONS as E } from './depth-explanations';

const MONO = '"Roboto Mono", ui-monospace, monospace';
/** Tasks listed as most often on the critical path. */
const TOP = 5;

function frequent(tasks: DagDetail['tasks']): string | null {
  const on = tasks
    .filter((t) => (t.critical_path_share ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.critical_path_share ?? 0) - (a.critical_path_share ?? 0) || a.task_id.localeCompare(b.task_id),
    )
    .slice(0, TOP)
    .map((t) => `${t.task_id}: ${formatShare(t.critical_path_share ?? 0)} of runs`);
  return on.length > 0 ? on.join(', ') : null;
}

export function CriticalPathSummary({ detail }: { detail: DagDetail }) {
  const { gantt } = detail;
  // Older servers do not report a critical path; nothing to show.
  if (gantt.critical_path === undefined || gantt.run_id === null) return null;
  const path = gantt.critical_path;
  const often = frequent(detail.tasks);
  return (
    <Stack spacing={1} sx={{ mt: 3 }} data-testid="critical-path">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <PanelTitle explanation={E['dagd-critical-path']} component="h3" />
        <Chip size="small" variant="outlined" label="Estimate from timing" />
      </Stack>
      {path === null ? (
        <Typography variant="body2" color="text.secondary">
          The critical path shows once the run has finished. Pick a finished run in the timeline above.
        </Typography>
      ) : (
        <>
          <Typography variant="body2">
            {formatInt(path.row_indexes.length)} steps over {formatDuration(path.duration_seconds)}: running{' '}
            {formatDuration(path.running_seconds)} (
            {formatShare(path.duration_seconds > 0 ? path.running_seconds / path.duration_seconds : null)}),
            waiting {formatDuration(path.waiting_seconds)} (
            {formatShare(path.duration_seconds > 0 ? path.waiting_seconds / path.duration_seconds : null)}).
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: MONO, wordBreak: 'break-word' }}>
            {path.row_indexes
              .map((i) => gantt.rows[i])
              .map((r) => (r ? (r.try_number > 1 ? `${r.task_id} (try ${r.try_number})` : r.task_id) : '?'))
              .join(' → ')}
          </Typography>
        </>
      )}
      {often && (
        <Typography variant="caption" color="text.secondary">
          Most often on the critical path in this range: {often}. Shorten these tasks, or run them in
          parallel, to make runs finish sooner.
        </Typography>
      )}
    </Stack>
  );
}
