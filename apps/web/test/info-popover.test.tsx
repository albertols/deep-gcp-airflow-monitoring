import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import { createDcamTheme, InfoPopover, type Explanation } from '@dcam/ui-kit';

const base: Explanation = {
  id: 'hm-003-slot-seconds',
  title: 'Executor slot-hours',
  summary: 'Total time task instance tries held a worker slot in the selected range, in hours.',
  sources: ['SRC-AF-API'],
  docs: [{ title: 'Airflow documentation: pools', url: 'https://airflow.apache.org/docs/' }],
};

async function open(explanation: Explanation) {
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <InfoPopover explanation={explanation} />
    </ThemeProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: `About ${explanation.title}` }));
  return screen.findByRole('dialog', { name: explanation.title });
}

describe('(i) explanation to wiki link', () => {
  it('FR-UI-05 / FR-WIKI-06: links to the wiki page named by the explanation, in the same tab', async () => {
    const dialog = await open({ ...base, wiki: { href: '#/wiki/executor-slot-seconds' } });
    const link = within(dialog).getByRole('link', { name: 'Learn more in the wiki' });
    expect(link).toHaveAttribute('href', '#/wiki/executor-slot-seconds');
    expect(link).not.toHaveAttribute('target');
  });

  it('FR-UI-05: names the wiki page in the link when a title is given', async () => {
    const dialog = await open({
      ...base,
      wiki: { href: '#/wiki/executor-slot-seconds', title: 'Executor slot-seconds' },
    });
    expect(
      within(dialog).getByRole('link', { name: 'Learn more in the wiki: Executor slot-seconds' }),
    ).toHaveAttribute('href', '#/wiki/executor-slot-seconds');
  });

  it('FR-UI-05: explanations without a wiki page keep only their documentation links', async () => {
    const dialog = await open(base);
    expect(within(dialog).queryByRole('link', { name: /Learn more in the wiki/ })).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'Airflow documentation: pools' })).toHaveAttribute(
      'target',
      '_blank',
    );
  });
});
