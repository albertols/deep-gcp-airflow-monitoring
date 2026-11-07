import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import type { BackfillStatus, Collection } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { HistoryNote, fillingIn } from '../src/components/backfill';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const running = (over: Partial<BackfillStatus> = {}): BackfillStatus => ({
  collector_id: 'af.backfill',
  kind: 'task_instances',
  state: 'running',
  days: 7,
  from: iso(NOW - 7 * DAY),
  to: iso(NOW),
  covered_from: iso(NOW - 2.4 * DAY),
  items_read: 48_000,
  requests_used: 600,
  eta_seconds: 6 * 3_600,
  ...over,
});

const collection = (backfill: BackfillStatus[], mode: Collection['mode'] = 'live'): Collection => ({
  mode,
  generated_at: iso(NOW),
  environments:
    mode === 'demo'
      ? []
      : [
          {
            env_id: 'acme-prod',
            profile: 'standard',
            reduced_fidelity: false,
            failing: false,
            collectors: [],
            footprint: [],
            series_24h: null,
            backfill,
          },
        ],
});

const reject = () => Promise.reject(new Error('not in this test'));
const api = (c: Collection): DcamApi => ({
  getMeta: reject,
  getOverview: reject,
  getDagLeague: reject,
  getDagDetail: reject,
  getBottlenecks: reject,
  getSchedule: reject,
  getFindings: reject,
  getAlerts: reject,
  getFleet: reject,
  getCollection: async () => c,
});

function renderNote(c: Collection, rangeFrom: string, kinds: BackfillStatus['kind'][] = ['task_instances']) {
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <p>page</p>
        <HistoryNote
          api={api(c)}
          envId="acme-prod"
          rangeFrom={rangeFrom}
          kinds={kinds}
          healthHref="#/health?env=acme-prod"
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('FR-COLL-04 the "history is filling in" note (NFR-DATA-03)', () => {
  it('FR-COLL-04: a range starting before the covered period says how far the history got and that the gap is not zero', async () => {
    renderNote(collection([running()]), iso(NOW - 7 * DAY));
    const note = await screen.findByTestId('history-note');
    expect(note).toHaveTextContent(
      'History is filling in: 2.4 of 7 days of task instances read, about 6h left.',
    );
    expect(note).toHaveTextContent(
      `Before ${new Date(NOW - 2.4 * DAY).toUTCString()} this range has none yet`,
    );
    expect(note).toHaveTextContent('missing, not zero');
    expect(screen.getByRole('link', { name: 'See the progress on the DCAM health page' })).toHaveAttribute(
      'href',
      '#/health?env=acme-prod',
    );
  });

  it('FR-COLL-04: a range inside the covered period, a complete backfill and demo mode show no note', async () => {
    expect(fillingIn([running()], ['task_instances'], iso(NOW - DAY))).toEqual([]);
    expect(fillingIn([running({ state: 'complete' })], ['task_instances'], iso(NOW - 7 * DAY))).toEqual([]);
    expect(fillingIn([running({ state: 'disabled' })], ['task_instances'], iso(NOW - 7 * DAY))).toEqual([]);
    // Only the kinds the page reads.
    expect(fillingIn([running()], ['metrics'], iso(NOW - 7 * DAY))).toEqual([]);
    renderNote(collection([], 'demo'), iso(NOW - 7 * DAY));
    await screen.findByText('page');
    expect(screen.queryByTestId('history-note')).toBeNull();
  });

  it('FR-COLL-04: before the backfill starts, and while its time left is unknown, the note says so in words', async () => {
    const waiting = running({
      collector_id: 'mon.backfill',
      kind: 'metrics',
      state: 'waiting',
      days: 14,
      from: null,
      to: null,
      covered_from: null,
      eta_seconds: null,
    });
    renderNote(collection([running({ eta_seconds: null }), waiting]), iso(NOW - DAY * 3), [
      'task_instances',
      'metrics',
    ]);
    const note = await screen.findByTestId('history-note');
    expect(note).toHaveTextContent('2.4 of 7 days of task instances read, time left not known yet.');
    expect(note).toHaveTextContent(
      'DCAM reads the last 14 days of worker samples in the background once its first collection cycle is done.',
    );
  });
});
