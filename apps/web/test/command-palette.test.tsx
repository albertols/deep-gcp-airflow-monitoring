import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DagIndex, EnvironmentOverview, Meta } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { App } from '../src/App';
import { isPaletteShortcut, isTextField } from '../src/components/palette/shortcut';

/** Whole-app tests: jsdom renders MUI slowly on a loaded machine. */
const UI_TIMEOUT_MS = 30_000;

const meta: Meta = {
  name: 'DCAM',
  version: '0.0.0',
  mode: 'demo',
  environments: [
    { env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' },
    { env_id: 'acme-dev', display_name: 'acme-dev', tier: 'dev' },
  ],
};
const overview: EnvironmentOverview = {
  env_id: 'acme-prod',
  range: { from: '2026-11-04T12:00:00.000Z', to: '2026-11-05T12:00:00.000Z' },
  data_as_of: '2026-11-05T12:00:00.000Z',
  sources: ['DEMO'],
  approximate: false,
  total_executor_slot_seconds: 36_000,
  peak_concurrency: 42,
  dag_count: 3,
  active_dag_count: 3,
  pareto_80_dag_count: 2,
  top_dags: [],
};
const dagIndex: DagIndex = {
  env_id: 'acme-prod',
  dags: [
    { dag_id: 'acme_zebra_daily', team: 'finance', paused: false },
    { dag_id: 'acme_zebra_hourly', team: 'finance', paused: true },
    { dag_id: 'zebra_export', team: 'analytics', paused: false },
  ],
};
const notYet = () => Promise.reject(new Error('not in this test'));
const api: DcamApi = {
  getMeta: async () => meta,
  getOverview: async () => overview,
  getDagLeague: notYet,
  getDagDetail: notYet,
  getDagComparison: notYet,
  getCapacity: notYet,
  getForecast: notYet,
  getRunComparison: notYet,
  getDagIndex: vi.fn(async () => dagIndex),
  getBottlenecks: notYet,
  getSchedule: notYet,
  getFindings: notYet,
  getAlerts: notYet,
  getFleet: notYet,
  getCollection: notYet,
};

const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
afterEach(() => {
  window.location.hash = '';
  if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform);
});
const onPlatform = (value: string) =>
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => value });

async function renderApp(hash = '#/?env=acme-prod&range=7d') {
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <App api={api} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  await screen.findByRole('button', { name: /^Jump to/ });
}

const palette = () => screen.findByRole('dialog', { name: 'Jump to' });
const options = (dialog: HTMLElement) => within(within(dialog).getByRole('listbox')).getAllByRole('option');

describe('FR-UI-03 command palette', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-UI-03: Ctrl+K opens it; three characters list ranked matches; Enter opens the DAG and keeps the context bar', async () => {
    onPlatform('Win32');
    await renderApp();
    await userEvent.keyboard('{Control>}k{/Control}');
    const dialog = await palette();
    const input = within(dialog).getByRole('combobox', { name: 'Jump to' });
    expect(input).toHaveFocus();
    await userEvent.type(input, 'zeb');
    await waitFor(() => expect(options(dialog)).toHaveLength(3));
    expect(options(dialog).map((o) => o.textContent)).toEqual([
      expect.stringContaining('zebra_export'),
      expect.stringContaining('acme_zebra_daily'),
      expect.stringContaining('acme_zebra_hourly'),
    ]);
    expect(within(dialog).getByRole('status')).toHaveTextContent('3 matches');
    // The active option is announced through aria-activedescendant; arrows move it.
    expect(input).toHaveAttribute('aria-activedescendant', options(dialog)[0]?.id);
    await userEvent.keyboard('{ArrowDown}');
    expect(options(dialog)[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options(dialog)[1]?.id);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(window.location.hash).toBe('#/dags/acme_zebra_daily?env=acme-prod&range=7d'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Jump to' })).toBeNull());
  });

  it('FR-UI-03: an environment switches the environment on the current page', async () => {
    onPlatform('Linux x86_64');
    await renderApp('#/bottlenecks?env=acme-prod&range=7d');
    await userEvent.click(screen.getByRole('button', { name: /^Jump to/ }));
    const dialog = await palette();
    await userEvent.type(within(dialog).getByRole('combobox'), 'acme-dev');
    await waitFor(() => expect(options(dialog)[0]).toHaveTextContent('acme-dev'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(window.location.hash).toBe('#/bottlenecks?env=acme-dev&range=7d'));
  });

  it('FR-UI-03: Cmd+K on macOS, where Ctrl+K stays with the browser; Esc closes and focus returns', async () => {
    onPlatform('MacIntel');
    await renderApp();
    // fireEvent returns false when a handler prevented the browser's default (it does so as it opens).
    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(true);
    const button = screen.getByRole('button', { name: /^Jump to/ });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
    button.focus();
    expect(fireEvent.keyDown(button, { key: 'k', metaKey: true })).toBe(false);
    await palette();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Jump to' })).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('FR-UI-03: in a text field the shortcut is left to the browser', async () => {
    onPlatform('Win32');
    await renderApp();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    expect(fireEvent.keyDown(field, { key: 'k', ctrlKey: true })).toBe(true);
    field.remove();
    // Outside a text field the same keys open the palette.
    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(false);
    await palette();
  });
});

describe('FR-UI-03 shortcut rules', () => {
  const key = (p: Partial<KeyboardEvent>) =>
    ({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...p }) as KeyboardEvent;

  it('FR-UI-03: Ctrl+K off macOS, Cmd+K on macOS, never with Shift or Alt', () => {
    expect(isPaletteShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(key({ key: 'K', ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isPaletteShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key({ key: 'j', ctrlKey: true }), false)).toBe(false);
  });

  it('FR-UI-03: text inputs, text areas and editable content are text fields; buttons and checkboxes are not', () => {
    const el = (html: string) => {
      const box = document.createElement('div');
      box.innerHTML = html;
      return box.firstElementChild;
    };
    expect(isTextField(el('<input>'))).toBe(true);
    expect(isTextField(el('<input type="search">'))).toBe(true);
    expect(isTextField(el('<textarea></textarea>'))).toBe(true);
    expect(isTextField(el('<div contenteditable="true"></div>'))).toBe(true);
    expect(isTextField(el('<input type="checkbox">'))).toBe(false);
    expect(isTextField(el('<button>Go</button>'))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});
