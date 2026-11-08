/**
 * How fresh the task history behind a DAG detail panel is (spec §12.10, "Stale"): an amber chip when the newest
 * task data `af.facts` committed is older than 2 × its cadence, a red one beyond 5 ×. Nothing in demo mode,
 * before the collection status loads, or while the history is fresh.
 *
 * @implements FR-UI-07
 */
import Chip from '@mui/material/Chip';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import type { DcamApi } from '../../api';
import { useCollection } from '../../components/collection';

/** The collector that stores finished task instances (FR-COLL-03). */
const TASK_FACTS = 'af.facts';

function age(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3_600)} h`;
}

export function TaskHistoryFreshness({ api, envId }: { api: DcamApi; envId: string }) {
  const q = useCollection(api);
  const env = q.data?.mode === 'live' ? q.data.environments.find((e) => e.env_id === envId) : undefined;
  const facts = env?.collectors.find((c) => c.id === TASK_FACTS);
  if (!facts || facts.lag_seconds === null || facts.cadence_seconds <= 0) return null;
  const cycles = facts.lag_seconds / facts.cadence_seconds;
  if (cycles <= 2) return null;
  return (
    <Chip
      size="small"
      variant="outlined"
      color={cycles > 5 ? 'error' : 'warning'}
      icon={<WarningAmberOutlined fontSize="small" />}
      label={`Task history ${age(facts.lag_seconds)} old`}
      title="DCAM has not stored new task instances for a while, so the latest runs may be missing here. The DCAM health page says why."
    />
  );
}
