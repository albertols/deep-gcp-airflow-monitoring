/**
 * The capacity page's states (spec §12.10): an empty state when the range has no worker figure, a partial
 * banner that lists what is missing with a link to DCAM health, and stale chips when the live snapshot or task
 * history collectors lag over 2 × their cadence (red over 5 ×). Cloud Monitoring is left out of the stale rule,
 * as the context bar does: it is read after its ingestion delay, so its lag always exceeds its cadence.
 *
 * @implements FR-UI-07, FR-ENV-02, NFR-DATA-03
 */
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import type { Capacity } from '@dcam/contracts';
import type { DcamApi } from '../../api';
import { useCollection } from '../../components/collection';
import { formatShare } from '../../components/format';
import { useView } from '../../components/view';
import type { PageProps } from '../types';
import { workerCountSource } from './format';

/** Collectors whose lag makes the capacity page stale, with the words for their data. */
const WATCHED: ReadonlyArray<{ readonly id: string; readonly what: string }> = [
  { id: 'af.live', what: 'Live snapshots' },
  { id: 'af.facts', what: 'Task history' },
];

function age(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3_600)} h`;
}

/** Amber or red chips for the watched collectors that lag; nothing in demo mode or while fresh. */
export function CapacityFreshness({ api, envId }: { api: DcamApi; envId: string }) {
  const { paused } = useView();
  const q = useCollection(api, { paused });
  const env = q.data?.mode === 'live' ? q.data.environments.find((e) => e.env_id === envId) : undefined;
  const chips = WATCHED.flatMap(({ id, what }) => {
    const c = env?.collectors.find((x) => x.id === id && x.state !== 'disabled');
    if (!c || c.lag_seconds === null || c.cadence_seconds <= 0) return [];
    const cycles = c.lag_seconds / c.cadence_seconds;
    return cycles > 2 ? [{ id, label: `${what} ${age(c.lag_seconds)} old`, red: cycles > 5 }] : [];
  });
  return (
    <>
      {chips.map((c) => (
        <Chip
          key={c.id}
          size="small"
          variant="outlined"
          color={c.red ? 'error' : 'warning'}
          icon={<WarningAmberOutlined fontSize="small" />}
          label={c.label}
          title="DCAM has not stored new data from this collector for a while, so the latest minutes may be missing here. The DCAM health page says why."
        />
      ))}
    </>
  );
}

/** What is missing from the capacity figures, one line each (empty when nothing is). */
export function missingLines(c: Capacity, span: string): string[] {
  const lines: string[] = [];
  if (c.summary.coverage < 0.995)
    lines.push(
      `Worker figures cover ${formatShare(c.summary.coverage)} of the last ${span}: the rest are gaps, not zero.`,
    );
  if (c.slots_source === 'hostnames') lines.push(workerCountSource('hostnames') ?? '');
  if (c.limits.worker_concurrency === null)
    lines.push(
      'worker_concurrency is not known, so worker slots, utilisation and capacity-bound minutes are not evaluated (HM-032).',
    );
  if (!c.scale_events.evaluated)
    lines.push(`Scale events are not evaluated: ${c.scale_events.not_evaluated_reason ?? ''}`);
  if (c.workloads.every((w) => w.samples === 0))
    lines.push('No worker CPU and memory samples from Cloud Monitoring in this range.');
  return lines;
}

/** The empty state without any worker figure, else the partial banner, else nothing. */
export function CapacityNotes({
  c,
  span,
  linkTo,
}: {
  c: Capacity;
  span: string;
  linkTo: PageProps['linkTo'];
}) {
  const health = linkTo({ page: 'health' });
  if (c.summary.observed_minutes === 0)
    return (
      <Alert severity="info" variant="outlined">
        No worker figures for the last {span} yet. They come from Cloud Monitoring worker samples or, without
        them, live snapshots from the Airflow REST API. Check the collectors on the{' '}
        <Link href={health}>DCAM health page</Link>.
      </Alert>
    );
  const lines = missingLines(c, span);
  if (lines.length === 0) return null;
  return (
    <Alert severity="info" variant="outlined">
      <AlertTitle>Part of the capacity data is missing</AlertTitle>
      <Box component="ul" sx={{ m: 0, pl: 4 }}>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </Box>
      <Link href={health}>See what DCAM collects on the DCAM health page</Link>.
    </Alert>
  );
}
