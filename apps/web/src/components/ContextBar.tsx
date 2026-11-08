/**
 * The global context bar (FR-UI-01, spec §12.2): environment, time range, time zone, live or paused
 * updates, and how fresh the data on the page is. Everything it shows is in the URL (FR-UI-02).
 *
 * @implements FR-UI-01, FR-UI-02
 */
import type { ReactNode } from 'react';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import PauseOutlined from '@mui/icons-material/PauseOutlined';
import PlayArrowOutlined from '@mui/icons-material/PlayArrowOutlined';
import type { CollectionEnvironment, Meta, Range } from '@dcam/contracts';
import type { ViewState } from '../router';
import { RANGES, RANGE_PRESETS } from './range';
import type { TimeFormat, TimeZoneChoice } from './time';

/** Whether a page follows the selected range, always covers the last 24 hours, or has no time range. */
export type RangeScope = 'range' | 'fixed-24h' | 'none';

const SCOPE_HINT: Record<Exclude<RangeScope, 'range'>, string> = {
  'fixed-24h':
    'This page always covers the last 24 hours. The range applies to the capacity, DAG and bottleneck pages.',
  none: 'This page has no time range. The range applies to the capacity, DAG and bottleneck pages.',
};

export type FreshnessLevel = 'fresh' | 'stale' | 'very-stale' | 'waiting';

export interface Freshness {
  readonly level: FreshnessLevel;
  /** Which collectors make the data stale, and how old their data is. */
  readonly detail: string;
}

const secondsText = (s: number) =>
  s < 120 ? `${Math.round(s)} s` : s < 7_200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3_600)} h`;

/**
 * §12.10 stale: data older than 2 × the collector's cadence is stale (amber), older than 5 × very stale
 * (red). Disabled collectors do not count. Cloud Monitoring data is read only after its ingestion delay
 * (FR-COLL-07), so its lag is always above its cadence; it is named but does not colour the chip.
 */
export function freshnessOf(env: CollectionEnvironment | undefined): Freshness | null {
  const collectors = env?.collectors.filter((c) => c.state !== 'disabled') ?? [];
  if (collectors.length === 0) return null;
  const withData = collectors.filter((c) => c.lag_seconds !== null);
  if (withData.length === 0)
    return { level: 'waiting', detail: 'No collector has finished a cycle yet. Pages fill as data arrives.' };
  let worst = 0;
  const parts: string[] = [];
  for (const c of withData) {
    const lag = c.lag_seconds as number;
    parts.push(`${c.id}: ${secondsText(lag)} old, every ${secondsText(c.cadence_seconds)}`);
    if (c.source === 'SRC-MON' || c.cadence_seconds <= 0) continue;
    worst = Math.max(worst, lag / c.cadence_seconds);
  }
  const level: FreshnessLevel = worst > 5 ? 'very-stale' : worst > 2 ? 'stale' : 'fresh';
  const lead =
    level === 'fresh'
      ? 'Collection is keeping up.'
      : 'Some data is older than its collectors should allow. Open DCAM health to see why.';
  return { level, detail: `${lead} ${parts.join(' · ')}` };
}

const CHIP_COLOR: Record<FreshnessLevel, 'success' | 'warning' | 'error' | 'default'> = {
  fresh: 'success',
  stale: 'warning',
  'very-stale': 'error',
  waiting: 'default',
};

/** "5 Nov, 12:04:31 UTC": the date too, since DCAM may show data collected on another day. */
const asOfText = (at: string, time: TimeFormat) =>
  `${time.day(at)}, ${time.clockSeconds(at)} ${time.zoneName(at)}`;

export interface ContextBarProps {
  readonly environments: Meta['environments'];
  readonly envId: string;
  readonly onEnvironment: (envId: string) => void;
  readonly view: ViewState;
  readonly onView: (patch: Partial<ViewState>) => void;
  readonly rangeScope: RangeScope;
  readonly time: TimeFormat;
  /** Short name of the browser's zone, for the toggle ("CET"). */
  readonly localZoneName: string;
  /** The oldest "data as of" of the page's panels; `null` before they load. */
  readonly dataAsOf: string | null;
  /** Live mode: staleness from the collectors of the selected environment. */
  readonly freshness: Freshness | null;
  /** Badges next to the environment (collection failing, reduced fidelity). */
  readonly badges?: ReactNode;
}

export function ContextBar(p: ContextBarProps) {
  const { view, time } = p;
  // A page with a fixed window shows that window; the selected range stays in the URL for the others.
  const rangeValue: Range = p.rangeScope === 'fixed-24h' ? '24h' : view.range;
  const rangePicker = (
    <TextField
      select
      size="small"
      label="Time range"
      value={rangeValue}
      disabled={p.rangeScope !== 'range'}
      onChange={(e) => p.onView({ range: e.target.value as Range })}
      sx={{ minWidth: 180 }}
    >
      {RANGES.map((r) => (
        <MenuItem key={r} value={r}>
          {RANGE_PRESETS[r].label}
        </MenuItem>
      ))}
    </TextField>
  );
  const freshness = p.freshness;
  const asOf = p.dataAsOf === null ? null : asOfText(p.dataAsOf, time);
  const chipLabel =
    freshness?.level === 'waiting'
      ? 'Waiting for the first collection'
      : asOf === null
        ? 'Loading data'
        : `Data as of ${asOf}`;

  return (
    <Stack
      direction="row"
      role="group"
      aria-label="Context"
      sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}
    >
      <TextField
        select
        size="small"
        label="Environment"
        value={p.envId}
        onChange={(e) => p.onEnvironment(e.target.value)}
        sx={{ minWidth: 200 }}
      >
        {p.environments.map((e) => (
          <MenuItem key={e.env_id} value={e.env_id}>
            {e.display_name} · {e.tier}
          </MenuItem>
        ))}
      </TextField>
      {p.badges}
      {p.rangeScope === 'range' ? (
        rangePicker
      ) : (
        <Tooltip title={SCOPE_HINT[p.rangeScope]} describeChild>
          <span>{rangePicker}</span>
        </Tooltip>
      )}
      <ToggleButtonGroup
        size="small"
        exclusive
        value={view.tz}
        aria-label="Time zone"
        onChange={(_e, tz: TimeZoneChoice | null) => tz && p.onView({ tz })}
      >
        <ToggleButton value="utc">UTC</ToggleButton>
        <ToggleButton value="local" title="Your computer's time zone">
          Local ({p.localZoneName})
        </ToggleButton>
      </ToggleButtonGroup>
      <Button
        size="small"
        variant="outlined"
        color={view.paused ? 'warning' : 'inherit'}
        startIcon={view.paused ? <PlayArrowOutlined /> : <PauseOutlined />}
        aria-label={view.paused ? 'Resume updates' : 'Pause updates'}
        onClick={() => p.onView({ paused: !view.paused })}
      >
        {view.paused ? 'Resume' : 'Pause'}
      </Button>
      <Tooltip
        describeChild
        title={
          view.paused
            ? 'Updates are paused: the page keeps what it shows. Resume to load the latest data.'
            : (freshness?.detail ?? 'Pages refresh every 30 s.')
        }
      >
        <Chip
          role="status"
          size="small"
          variant="outlined"
          color={view.paused ? 'warning' : freshness ? CHIP_COLOR[freshness.level] : 'default'}
          label={
            view.paused ? `Paused · ${chipLabel.charAt(0).toLowerCase()}${chipLabel.slice(1)}` : chipLabel
          }
        />
      </Tooltip>
    </Stack>
  );
}
