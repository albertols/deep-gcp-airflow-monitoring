import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import { createDcamTheme } from '@dcam/ui-kit';
import {
  EnvironmentPlaceContext,
  OpenInMenu,
  type EnvironmentPlaceValue,
} from '../src/components/OpenInMenu';
import type { LinkTarget } from '../src/components/open-in-links';
import { EXPLANATIONS } from '../src/explanations';

const PLACE = {
  composer: { project_id: 'acme-prod-123', location: 'us-central1', environment: 'acme-composer-prod' },
  airflow_uri: 'https://acme-composer-prod.airflow.example',
};
const WINDOW = { from: '2026-11-05T11:00:00.000Z', to: '2026-11-06T11:00:00.000Z' };
const DAG: LinkTarget = { page: 'dag', dagId: 'acme_orders_daily', run: null };

function renderMenu(value: EnvironmentPlaceValue | null, target: LinkTarget = DAG, label?: string) {
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <EnvironmentPlaceContext.Provider value={value}>
        <OpenInMenu target={target} timeWindow={WINDOW} {...(label === undefined ? {} : { label })} />
      </EnvironmentPlaceContext.Provider>
    </ThemeProvider>,
  );
}

const openMenu = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Open in' }));
  return screen.findByRole('menu');
};

describe('"Open in" menu (FR-UI-04)', () => {
  it('FR-UI-04: every link opens in a new tab without giving the page access to DCAM', async () => {
    renderMenu({ mode: 'live', place: PLACE });
    const menu = await openMenu();
    const links = within(menu)
      .getAllByRole('menuitem')
      .filter((i) => i.tagName === 'A');
    expect(links.map((l) => l.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Composer environments'),
        expect.stringContaining('Logs Explorer: DAG worker logs'),
        expect.stringContaining('DAG grid'),
      ]),
    );
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link.getAttribute('href')).toMatch(/^https:\/\//);
      // Screen readers hear that the link opens a new tab.
      expect(link).toHaveAccessibleName(/opens in a new tab/);
    }
    expect(within(menu).getByText('Cloud console')).toBeInTheDocument();
    expect(within(menu).getByText('Airflow UI')).toBeInTheDocument();
  });

  it('FR-UI-04: a missing field is a disabled item that says what to do, never a link', async () => {
    renderMenu({ mode: 'live', place: PLACE });
    const menu = await openMenu();
    const run = within(menu).getByRole('menuitem', { name: /Selected run/ });
    expect(run.tagName).not.toBe('A');
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).toHaveTextContent('No run of this DAG in the range. Pick a longer range.');
  });

  it('FR-UI-04: the menu works with the keyboard: open, move, Escape returns to the button', async () => {
    renderMenu({ mode: 'live', place: PLACE });
    const button = screen.getByRole('button', { name: 'Open in' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    button.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const first = within(menu).getAllByRole('menuitem')[0];
    expect(first).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(within(menu).getAllByRole('menuitem')[1]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('FR-UI-04: disabled items can be reached with the keyboard, so their reason is read out', async () => {
    renderMenu({ mode: 'live', place: { airflow_uri: 'http://127.0.0.1:8080' } }, { page: 'environment' });
    const menu = await openMenu();
    const items = within(menu).getAllByRole('menuitem');
    expect(items[0]).toHaveTextContent(/self-managed Airflow/);
    expect(items[0]).toHaveFocus();
  });

  it('FR-UI-04: in demo mode the menu says the links lead to fictitious resources', async () => {
    renderMenu({ mode: 'demo', place: PLACE });
    const menu = await openMenu();
    const note = within(menu).getByRole('menuitem', { name: /Demo data/ });
    // The console links are real pages: say what the user will see there, not "nothing".
    expect(note).toHaveTextContent(/acme projects are made up/);
    expect(note).toHaveTextContent(/Cloud console will say it cannot find them/);
    expect(note).toHaveTextContent(/\.example addresses that do not exist/);
  });

  it('FR-UI-04: without the environment place every group says DCAM could not read it', async () => {
    renderMenu(null);
    const menu = await openMenu();
    expect(within(menu).getAllByText(/could not read where this environment lives/)).toHaveLength(2);
    expect(
      within(menu)
        .queryAllByRole('menuitem')
        .filter((i) => i.tagName === 'A'),
    ).toEqual([]);
  });

  it('FR-UI-04: hints show the range in the page time zone', async () => {
    renderMenu({ mode: 'live', place: PLACE });
    const menu = await openMenu();
    expect(within(menu).getByRole('menuitem', { name: /Metrics Explorer/ })).toHaveTextContent(
      'Set the time range to 5 Nov, 11:00 UTC to 6 Nov, 11:00 UTC there',
    );
  });

  it('FR-UI-04: a row menu has its own accessible name', async () => {
    renderMenu({ mode: 'live', place: PLACE }, DAG, 'Open in: load_orders');
    expect(screen.getByRole('button', { name: 'Open in: load_orders' })).toHaveTextContent('Open in');
  });

  it('FR-UI-05: the menu has an (i) explanation entry', async () => {
    expect(EXPLANATIONS['open-in']).toBeDefined();
    renderMenu({ mode: 'live', place: PLACE });
    await userEvent.click(screen.getByRole('button', { name: `About ${EXPLANATIONS['open-in'].title}` }));
    const dialog = await screen.findByRole('dialog', { name: EXPLANATIONS['open-in'].title });
    expect(dialog).toHaveTextContent(/never requests these addresses/);
  });
});
