/**
 * Backfill progress (FR-COLL-04) as pages show it: plain-word labels shared with the DCAM health page, and
 * the "history is filling in" note for pages whose range starts before the history read so far. A range
 * that reaches past the covered period has a gap there, and the note says so instead of letting it read as
 * zero (NFR-DATA-03). Demo mode has no collectors, so it never shows the note.
 *
 * @implements FR-COLL-04, NFR-DATA-03, FR-UI-07
 */
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import type { BackfillStatus } from '@dcam/contracts';
import type { DcamApi } from '../api';
import { useCollection } from './collection';
import { formatDuration } from './format';
import type { TimeFormat } from './time';
import { useTimeFormat, useView } from './view';

const DAY_S = 86_400;
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export const BACKFILL_KIND: Readonly<Record<BackfillStatus['kind'], string>> = {
  task_instances: 'Task instances',
  metrics: 'Worker metrics',
};
const WHAT: Readonly<Record<BackfillStatus['kind'], string>> = {
  task_instances: 'task instances',
  metrics: 'worker samples',
};

/** Durations with days, like `2d 13h`; under a day as {@link formatDuration}. */
export function formatLongDuration(seconds: number): string {
  if (seconds < DAY_S) return formatDuration(seconds);
  const d = Math.floor(seconds / DAY_S);
  const h = Math.round((seconds % DAY_S) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Days of history read so far: from `covered_from` to `to`; 0 before the backfill started. */
export function daysRead(b: BackfillStatus): number {
  if (b.state === 'complete') return b.days;
  if (b.to === null || b.covered_from === null) return 0;
  return Math.max(0, Math.min(b.days, (Date.parse(b.to) - Date.parse(b.covered_from)) / 1000 / DAY_S));
}

export const formatDays = (n: number) => oneDecimal.format(n);

/** "about 5h 30m", or "Not known yet" while it cannot be estimated. */
export const formatEta = (b: BackfillStatus) =>
  b.state === 'complete'
    ? 'Done'
    : b.eta_seconds === null
      ? 'Not known yet'
      : `about ${formatLongDuration(b.eta_seconds)}`;

/** The backfills of `kinds` still filling in a range that starts at `rangeFrom` (ISO). */
export function fillingIn(
  backfill: readonly BackfillStatus[] | undefined,
  kinds: readonly BackfillStatus['kind'][],
  rangeFrom: string,
): BackfillStatus[] {
  const from = Date.parse(rangeFrom);
  return (backfill ?? []).filter((b) => {
    if (!kinds.includes(b.kind)) return false;
    if (b.state === 'waiting') return true;
    if (b.state !== 'running' || b.covered_from === null) return false;
    return from < Date.parse(b.covered_from);
  });
}

function sentence(b: BackfillStatus, time: TimeFormat): string {
  if (b.state === 'waiting')
    return `History is filling in: DCAM reads the last ${b.days} days of ${WHAT[b.kind]} in the background once its first collection cycle is done. Until then this range shows only what DCAM collected since it started.`;
  const covered = b.covered_from === null ? '' : time.full(b.covered_from);
  const left =
    b.eta_seconds === null ? 'time left not known yet' : `about ${formatLongDuration(b.eta_seconds)} left`;
  return `History is filling in: ${formatDays(daysRead(b))} of ${b.days} days of ${WHAT[b.kind]} read, ${left}. Before ${covered} this range has none yet: that part is missing, not zero.`;
}

/**
 * A small note on pages whose range starts before the history read so far (FR-COLL-04). Renders nothing
 * when the history covers the range, in demo mode, or before the collection status has loaded.
 */
export function HistoryNote({
  api,
  envId,
  rangeFrom,
  kinds,
  healthHref,
}: {
  api: DcamApi;
  envId: string;
  rangeFrom: string;
  kinds: readonly BackfillStatus['kind'][];
  healthHref: string;
}) {
  const { paused } = useView();
  const time = useTimeFormat();
  const q = useCollection(api, { paused });
  const env = q.data?.mode === 'live' ? q.data.environments.find((e) => e.env_id === envId) : undefined;
  const open = fillingIn(env?.backfill, kinds, rangeFrom);
  if (open.length === 0) return null;
  return (
    <Alert severity="info" variant="outlined" sx={{ py: 0 }} data-testid="history-note">
      {open.map((b) => (
        <span key={b.collector_id}>{sentence(b, time)} </span>
      ))}
      <Link href={healthHref}>See the progress on the DCAM health page</Link>.
    </Alert>
  );
}
