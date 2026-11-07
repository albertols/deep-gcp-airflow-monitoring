import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meta } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { App } from '../src/App';
import { SetupPage } from '../src/pages/setup/SetupPage';
import { SETUP_EXPLANATIONS, SETUP_PANELS } from '../src/pages/setup/explanations';

type Setup = NonNullable<Meta['setup']>;

const INVALID: Setup = {
  config_path: '/home/acme/deep-gcp-airflow-monitoring/dcam.config.yaml',
  issues: [
    {
      path: 'environments.0.projectId',
      message: 'Required.',
      fix_hint: 'Set projectId to the Google Cloud project of the environment, for example acme-prod-123.',
    },
    {
      path: '',
      message: 'The file is not valid YAML.',
      fix_hint: 'Check the indentation near line 4.',
    },
  ],
};
const MISSING: Setup = { config_path: null, issues: [] };
const COMMANDS = [
  'cp dcam.config.example.yaml dcam.config.yaml',
  'gcloud auth application-default login',
  'pnpm dcam doctor',
  'pnpm dcam',
];

function renderPage(setup: Setup) {
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <SetupPage setup={setup} />
    </ThemeProvider>,
  );
}

const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
afterEach(() => {
  if (originalClipboard) Object.defineProperty(window.navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(window.navigator, 'clipboard');
});

describe('setup page (FR-SETUP-02)', () => {
  it('FR-SETUP-02: an invalid file says what happened and which file DCAM read', () => {
    renderPage(INVALID);
    expect(screen.getByRole('heading', { level: 1, name: 'Set up DCAM' })).toBeInTheDocument();
    expect(screen.getByText('DCAM could not load its configuration')).toBeInTheDocument();
    expect(screen.getByText(INVALID.config_path ?? '').tagName).toBe('CODE');
    expect(screen.getByText(/found 2 problems/)).toBeInTheDocument();
    expect(screen.getByText(/collects nothing until the file is valid/)).toBeInTheDocument();
  });

  it('FR-SETUP-02: lists every issue with its path, message and fix hint', () => {
    renderPage(INVALID);
    const table = screen.getByRole('table', { name: 'Configuration issues' });
    const first = within(table).getByRole('row', { name: /environments\.0\.projectId/ });
    expect(first).toHaveTextContent('Required.');
    expect(first).toHaveTextContent('Set projectId to the Google Cloud project of the environment');
    const whole = within(table).getByRole('row', { name: /not valid YAML/ });
    expect(within(whole).getByText('Whole file')).toBeInTheDocument();
    expect(whole).toHaveTextContent('Check the indentation near line 4.');
  });

  it('FR-SETUP-02: one problem is counted in the singular', () => {
    renderPage({ ...INVALID, issues: INVALID.issues.slice(0, 1) });
    expect(screen.getByText(/found 1 problem\./)).toBeInTheDocument();
  });

  it('FR-SETUP-02: a missing file says so and shows no issue table', () => {
    renderPage(MISSING);
    expect(screen.getByText('No configuration file found')).toBeInTheDocument();
    expect(screen.getByText(/found no configuration file, so it collects nothing yet/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Configuration issues' })).toBeNull();
  });

  it('FR-SETUP-02: a missing --config file is named, and every command repeats --config', () => {
    const flag = '/home/acme/configs/acme dcam.yaml';
    renderPage({
      config_path: null,
      config_flag: flag,
      issues: [
        {
          path: '',
          message: `No configuration file was found at ${flag}.`,
          fix_hint: 'Check the path given with --config.',
        },
      ],
    });
    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent(/folder it was started from/);
    expect(within(alert).getByText(flag).tagName).toBe('CODE');
    const steps = screen.getByRole('list', { name: 'Steps to set up DCAM' });
    expect(steps).toHaveTextContent('keep it out of Git');
    for (const command of [
      `cp dcam.config.example.yaml "${flag}"`,
      `pnpm dcam doctor --config "${flag}"`,
      `pnpm dcam --config "${flag}"`,
    ])
      expect(within(steps).getByText(command).tagName).toBe('CODE');
  });

  it('FR-SETUP-02: an invalid --config file keeps --config in the commands', () => {
    renderPage({ ...INVALID, config_path: '/home/acme/acme.yaml', config_flag: '/home/acme/acme.yaml' });
    const steps = screen.getByRole('list', { name: 'Steps to set up DCAM' });
    expect(within(steps).getByText('pnpm dcam doctor --config /home/acme/acme.yaml').tagName).toBe('CODE');
    expect(within(steps).getByText('pnpm dcam --config /home/acme/acme.yaml').tagName).toBe('CODE');
  });

  it('FR-SETUP-02: commands in backticks in a fix hint show as code, without the backticks', () => {
    renderPage({
      config_path: null,
      issues: [
        {
          path: '',
          message: 'No configuration file was found at /home/acme/dcam/dcam.config.yaml.',
          fix_hint:
            'To create it, run `cp dcam.config.example.yaml dcam.config.yaml` in the DCAM folder. To try DCAM without Google Cloud, run `pnpm dcam --demo`.',
        },
      ],
    });
    const table = screen.getByRole('table', { name: 'Configuration issues' });
    const row = within(table).getByRole('row', { name: /No configuration file was found/ });
    expect(row).not.toHaveTextContent('`');
    expect(within(row).getByText('cp dcam.config.example.yaml dcam.config.yaml').tagName).toBe('CODE');
    expect(within(row).getByText('pnpm dcam --demo').tagName).toBe('CODE');
    expect(row).toHaveTextContent(
      'To create it, run cp dcam.config.example.yaml dcam.config.yaml in the DCAM folder.',
    );
  });

  it('FR-SETUP-02: a missing file still lists the issues the server reported', () => {
    renderPage({
      config_path: null,
      issues: [
        { path: '', message: 'DCAM_CONFIG names a file that does not exist.', fix_hint: 'Fix the path.' },
      ],
    });
    expect(screen.getByText('No configuration file found')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Configuration issues' });
    expect(within(table).getByRole('row', { name: /does not exist/ })).toHaveTextContent('Fix the path.');
  });

  it('FR-SETUP-02: shows the steps to run against your own environment (spec §17.6)', () => {
    renderPage(MISSING);
    const steps = screen.getByRole('list', { name: 'Steps to set up DCAM' });
    const items = within(steps).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('cp dcam.config.example.yaml dcam.config.yaml'),
      expect.stringMatching(/projectId.*location.*environment/),
      expect.stringContaining('gcloud auth application-default login'),
      expect.stringContaining('pnpm dcam doctor'),
      expect.stringContaining('pnpm dcam'),
    ]);
    for (const command of COMMANDS) expect(within(steps).getByText(command).tagName).toBe('CODE');
    expect(screen.getByText(/--config/)).toBeInTheDocument();
    expect(screen.getByText(/DCAM_CONFIG/)).toBeInTheDocument();
  });

  it('FR-SETUP-02: every command has its own Copy button and is copy-only', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPage(MISSING);
    const steps = screen.getByRole('list', { name: 'Steps to set up DCAM' });
    for (const command of COMMANDS)
      expect(within(steps).getByRole('button', { name: `Copy ${command}` })).toBeInTheDocument();
    fireEvent.click(within(steps).getByRole('button', { name: 'Copy pnpm dcam doctor' }));
    expect(writeText).toHaveBeenCalledWith('pnpm dcam doctor');
    expect(await within(steps).findByText('Copied to the clipboard.')).toBeInTheDocument();
  });

  it('FR-UI-05: every panel has an explanation with its (i) button', () => {
    renderPage(INVALID);
    for (const id of SETUP_PANELS) {
      expect(SETUP_EXPLANATIONS[id], id).toBeDefined();
      expect(
        screen.getByRole('button', { name: `About ${SETUP_EXPLANATIONS[id].title}` }),
      ).toBeInTheDocument();
    }
  });
});

describe('setup mode in the shell (FR-SETUP-02)', () => {
  const SETUP_META: Meta = {
    name: 'DCAM',
    version: '0.1.0',
    mode: 'live',
    environments: [],
    setup: {
      config_path: '/home/acme/deep-gcp-airflow-monitoring/dcam.config.yaml',
      issues: [{ path: 'environments.0.location', message: 'Required.', fix_hint: 'Set location.' }],
    },
  };
  const reject = () => Promise.reject(new Error('not in this test'));

  afterEach(() => {
    window.location.hash = '';
  });

  it('FR-SETUP-02: shows the setup page on every route, without navigation or collection status', async () => {
    window.location.hash = '#/dags';
    const getCollection = vi.fn(reject);
    const api: DcamApi = {
      getMeta: async () => SETUP_META,
      getOverview: reject,
      getDagLeague: reject,
      getDagDetail: reject,
      getBottlenecks: reject,
      getFindings: reject,
      getAlerts: reject,
      getFleet: reject,
      getCollection,
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider theme={createDcamTheme('dark')}>
        <QueryClientProvider client={client}>
          <App api={api} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up DCAM' })).toBeInTheDocument();
    expect(screen.getByText('environments.0.location')).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByText('Setup needed')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'DAG league table' })).toBeNull();
    expect(screen.queryByText(/demo data for the fictitious "acme" organisation/i)).toBeNull();
    expect(getCollection).not.toHaveBeenCalled();
  });
});
