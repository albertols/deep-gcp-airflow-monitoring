/**
 * The DAG's impact on its environment (FR-DAGD-06): its share of the environment's executor load per time
 * bucket (HM-003) and of the executor slots there were (HM-011), and its noisy-neighbour score (HM-017)
 * with the 95 % interval and the confidence level, or, without a score, the reason and the minimums it
 * missed: never a zero it did not measure. The wording stays with association, not cause.
 *
 * @implements FR-DAGD-06, HM-003, HM-011, HM-017, NFR-DATA-03, NFR-DATA-04, FR-UI-05, FR-UI-07, FR-UI-08
 */
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { DagDetail, DagImpact, DagNoisyNeighbour, NoisyNeighbour } from '@dcam/contracts';
import type { DcamApi } from '../../api';
import { HistoryNote } from '../../components/backfill';
import { bucketLabels } from '../../components/charts';
import { formatDuration, formatInt, formatShare, formatSlotHours } from '../../components/format';
import { LineChart } from '../../components/line-chart';
import { Panel, PanelTitle, ProvenanceFooter } from '../../components/Panel';
import { seriesStyle } from '../../components/series';
import type { TimeFormat } from '../../components/time';
import { useTableView } from '../../components/view-toggle';
import { useTimeFormat } from '../../components/view';
import type { PageProps } from '../types';
import { COMPARE_EXPLANATIONS as E } from './compare-explanations';
import { TaskHistoryFreshness } from './TaskHistoryFreshness';

const NO_HISTORY = 'No history for this bucket';

/** A signed duration: `+45s`, `−5s`. */
export const signedDuration = (seconds: number) =>
  `${seconds < 0 ? '−' : '+'}${formatDuration(Math.abs(seconds))}`;

const CONFIDENCE: Readonly<
  Record<NoisyNeighbour['confidence'], { label: string; color: 'success' | 'warning' | 'default' }>
> = {
  high: { label: 'High confidence', color: 'success' },
  medium: { label: 'Medium confidence', color: 'warning' },
  low: { label: 'Low confidence', color: 'default' },
};

/** An overlap window as `5 Nov, 10:00–10:24 UTC` in the context bar's zone. */
function windowText(w: { from: string; to: string }, time: TimeFormat): string {
  const end = time.day(w.from) === time.day(w.to) ? time.clock(w.to) : time.dayClock(w.to);
  return `${time.dayClock(w.from)}–${end} ${time.zoneName(w.from)}`;
}

/** The share over the buckets with history: DAG ÷ environment slot-seconds, both summed. */
function overallShare(series: DagImpact['series']): number | null {
  let dag = 0;
  let env = 0;
  for (const b of series)
    if (b.dag_slot_seconds !== null && b.environment_slot_seconds !== null) {
      dag += b.dag_slot_seconds;
      env += b.environment_slot_seconds;
    }
  return env > 0 ? dag / env : null;
}

function ShareChart({ impact }: { impact: DagImpact }) {
  const mode = useTheme().palette.mode;
  const time = useTimeFormat();
  const starts = impact.series.map((b) => Date.parse(b.start));
  const labels = bucketLabels(time, starts.length, impact.bucket_seconds * 1000);
  const [a, b] = [0, 1].map((i) => seriesStyle(mode, i));
  let peak: { share: number; at: number } | null = null;
  impact.series.forEach((x, i) => {
    if (x.share !== null && (peak === null || x.share > peak.share))
      peak = { share: x.share, at: starts[i] ?? 0 };
  });
  const top = peak as { share: number; at: number } | null;
  const overall = overallShare(impact.series);
  const estimate = impact.slots_source === 'hostnames';
  const description = `Share of the environment's executor slot-hours per ${formatDuration(impact.bucket_seconds)} bucket: ${
    top === null ? 'no load in the range' : `peak ${formatShare(top.share)} at ${labels.range(top.at)}`
  }${overall === null ? '' : `, ${formatShare(overall)} over the buckets with history`}.`;
  return (
    <Stack spacing={1}>
      <Typography variant="body2">
        {overall === null
          ? 'DCAM has no load of this environment in the range yet.'
          : `Over the buckets with history, this DAG used ${formatShare(overall)} of the environment’s executor slot-hours${top === null ? '' : `, at most ${formatShare(top.share)} in one bucket (${labels.range(top.at)})`}.`}
      </Typography>
      <LineChart
        count={starts.length}
        lines={[
          {
            key: 'share',
            label: 'Share of the slot-hours used (HM-003)',
            values: impact.series.map((x) => x.share),
            color: a?.color ?? '',
          },
          {
            key: 'capacity',
            label: `Share of the executor slots${estimate ? ' (estimate)' : ''} (HM-011)`,
            values: impact.series.map((x) => x.capacity_share),
            color: b?.color ?? '',
            dash: b?.dash ?? 'none',
          },
        ]}
        tick={(i) => labels.tick(starts[i] ?? 0)}
        title={(i) => labels.range(starts[i] ?? 0)}
        format={formatShare}
        label={description}
      />
    </Stack>
  );
}

function ShareTable({ impact }: { impact: DagImpact }) {
  const time = useTimeFormat();
  const labels = bucketLabels(time, impact.series.length, impact.bucket_seconds * 1000);
  const gap = (v: number | null, text: string) => (
    <TableCell align="right" title={v === null ? NO_HISTORY : undefined}>
      {v === null ? '—' : text}
    </TableCell>
  );
  return (
    <TableContainer sx={{ maxHeight: 420 }}>
      <Table size="small" stickyHeader aria-label="Share of the environment per bucket">
        <TableHead>
          <TableRow>
            <TableCell>Time</TableCell>
            <TableCell align="right">This DAG (slot-hours)</TableCell>
            <TableCell align="right">Environment (slot-hours)</TableCell>
            <TableCell align="right">Share of the slot-hours used</TableCell>
            <TableCell align="right">Share of the executor slots</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {impact.series.map((b) => (
            <TableRow key={b.start}>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{labels.range(Date.parse(b.start))}</TableCell>
              {gap(b.dag_slot_seconds, formatSlotHours(b.dag_slot_seconds ?? 0))}
              {gap(b.environment_slot_seconds, formatSlotHours(b.environment_slot_seconds ?? 0))}
              {gap(b.share, formatShare(b.share))}
              {gap(b.capacity_share, formatShare(b.capacity_share))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function Score({ n, score }: { n: DagNoisyNeighbour; score: NoisyNeighbour }) {
  const time = useTimeFormat();
  const c = CONFIDENCE[score.confidence];
  const interval =
    score.ci_low_seconds === null || score.ci_high_seconds === null
      ? 'no interval'
      : `95 % interval ${signedDuration(score.ci_low_seconds)} to ${signedDuration(score.ci_high_seconds)}`;
  return (
    <Stack spacing={1}>
      <Stack direction="row" sx={{ alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: '1.5rem', fontVariantNumeric: 'tabular-nums' }}>
          {signedDuration(score.effect_seconds)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          median queue wait of other DAGs while this DAG held at least {formatShare(n.active_share)} of the
          executor slots ({interval})
        </Typography>
        <Chip size="small" variant="outlined" color={c.color} label={c.label} />
      </Stack>
      <Typography variant="body2">
        {n.status === 'associated'
          ? 'Associated with longer queue waits of other DAGs, which is not proof that it causes them. '
          : 'Not associated with longer queue waits of other DAGs. '}
        {n.reason}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {formatInt(score.active_minutes)} active minutes; {formatInt(score.affected_tries)} tries of other
        DAGs queued in {formatInt(score.affected_minutes ?? n.affected_minutes)} of them, against{' '}
        {formatInt(score.control_tries)} in matched quiet minutes ({formatShare(score.matched_share)}{' '}
        matched); median wait {formatDuration(score.median_wait_active_seconds)} while active,{' '}
        {formatDuration(score.median_wait_inactive_seconds)} otherwise.
        {score.overlap_windows.length > 0 &&
          ` Active: ${score.overlap_windows
            .slice(0, 3)
            .map((w) => windowText(w, time))
            .join(', ')}.`}
      </Typography>
    </Stack>
  );
}

function Minimums({ n }: { n: DagNoisyNeighbour }) {
  const measured = n.status !== 'not_evaluated';
  const share = formatShare(n.active_share);
  const rows: ReadonlyArray<readonly [string, number, number]> = [
    [`Active minutes (≥ ${share} of the executor slots)`, n.active_minutes, n.min_active_minutes],
    ["Other DAGs' tries queued while it was active", n.affected_tries, n.min_affected_tries],
    ['Distinct active minutes with those tries', n.affected_minutes, n.min_affected_minutes],
    ['Tries of other DAGs in matched quiet minutes', n.control_tries, n.min_control_tries],
  ];
  return (
    <TableContainer>
      <Table size="small" aria-label="What the score needs">
        <TableHead>
          <TableRow>
            <TableCell>Minimum</TableCell>
            <TableCell align="right">Needed</TableCell>
            <TableCell align="right">This DAG</TableCell>
            <TableCell>Status</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(([label, value, needed]) => (
            <TableRow key={label}>
              <TableCell>{label}</TableCell>
              <TableCell align="right">{formatInt(needed)}</TableCell>
              <TableCell align="right">{measured ? formatInt(value) : 'Not measured'}</TableCell>
              <TableCell>{!measured ? 'Not measured' : value >= needed ? 'Met' : 'Not met'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function NoisyNeighbourBlock({ n }: { n: DagNoisyNeighbour }) {
  return (
    <Stack spacing={1} data-testid="noisy-neighbour">
      <PanelTitle explanation={E['dagd-noisy-neighbour']} component="h3" />
      {n.score ? (
        <Score n={n} score={n.score} />
      ) : (
        <>
          <Alert severity="info" variant="outlined">
            Not scored in this range. {n.reason}
          </Alert>
          <Minimums n={n} />
        </>
      )}
    </Stack>
  );
}

export function ImpactPanel({
  detail,
  api,
  envId,
  linkTo,
}: {
  detail: DagDetail;
  api: DcamApi;
  envId: string;
  linkTo: PageProps['linkTo'];
}) {
  const time = useTimeFormat();
  const [asTable, toggle] = useTableView('impact');
  const impact = detail.impact;
  const hasLoad = impact?.series.some((b) => b.share !== null || b.capacity_share !== null) ?? false;
  return (
    <Panel
      explanation={E['dagd-impact']}
      actions={
        <Stack direction="row" sx={{ gap: 2, alignItems: 'center' }}>
          {impact?.slots_source === 'hostnames' && (
            <Chip
              size="small"
              variant="outlined"
              label="Estimate"
              title="Worker counts from the hostnames of running tasks: a lower bound, so the share of the executor slots may read high."
            />
          )}
          <TaskHistoryFreshness api={api} envId={envId} />
          {hasLoad && toggle}
        </Stack>
      }
    >
      {impact === undefined ? (
        <Typography variant="body2" color="text.secondary">
          This DCAM server does not report the impact on the environment yet. Update DCAM to see it.
        </Typography>
      ) : (
        <Stack spacing={3}>
          <HistoryNote
            api={api}
            envId={envId}
            rangeFrom={detail.range.from}
            kinds={['task_instances']}
            healthHref={linkTo({ page: 'health' })}
          />
          {!hasLoad ? (
            <Typography variant="body2" color="text.secondary">
              DCAM has no load of this environment in the range yet. Pick a longer range, or check the DCAM
              health page.
            </Typography>
          ) : asTable ? (
            <ShareTable impact={impact} />
          ) : (
            <ShareChart impact={impact} />
          )}
          <NoisyNeighbourBlock n={impact.noisy_neighbour} />
          <ProvenanceFooter
            as="p"
            dataAsOf={detail.data_as_of}
            sources={detail.sources}
            note={`share of executor slot-seconds (HM-003)${impact.slots_source ? `, executor slots from ${impact.slots_source === 'monitoring' ? 'Cloud Monitoring' : impact.slots_source === 'config' ? 'the configured workers' : 'hostnames (an estimate)'}` : ''}; noisy-neighbour method ${impact.noisy_neighbour.method}, ${formatInt(impact.noisy_neighbour.resamples)} bootstrap resamples; association, not cause · range ${time.dateTime(detail.range.from)} to ${time.dateTime(detail.range.to)}`}
          />
        </Stack>
      )}
    </Panel>
  );
}
