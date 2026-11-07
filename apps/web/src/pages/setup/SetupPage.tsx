/**
 * Setup mode (FR-SETUP-02): the configuration file is missing or invalid, so DCAM runs no collector.
 * The page names the file DCAM read, lists every issue with its path and fix hint, and gives the next
 * steps as copy-only commands (spec §17.6), with the `--config` path DCAM was started with. Nothing here
 * calls Google Cloud or Airflow.
 *
 * @implements FR-SETUP-02, FR-AUTH-02, FR-UI-05
 */
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { Meta } from '@dcam/contracts';
import { PageHeader } from '../../components/PageHeader';
import { Panel } from '../../components/Panel';
import { SnippetBlock } from '../advisor/SnippetBlock';
import { SETUP_EXPLANATIONS as X } from './explanations';

type Setup = NonNullable<Meta['setup']>;

const mono = { fontFamily: '"Roboto Mono", ui-monospace, monospace' };

/** A path as one shell word: quoted when it has spaces or other special characters (bash, PowerShell, cmd). */
const shellWord = (path: string): string => (/^[\w@%+=:,./\\-]+$/.test(path) ? path : `"${path}"`);

/** Text with `inline code` spans, as the server writes fix hints: the spans show as code. */
function WithCode({ text }: { text: string }) {
  const parts = text.split('`');
  // An unmatched backtick is shown as it is.
  if (parts.length % 2 === 0) return <>{text}</>;
  return <>{parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}</>;
}

/** A step with a command to copy; DCAM never runs it. */
function CommandStep({ title, command }: { title: string; command: string }) {
  return (
    <Box component="li">
      <SnippetBlock snippet={{ title, code: command }} copyLabel={`Copy ${command}`} />
    </Box>
  );
}

function Status({ setup }: { setup: Setup }) {
  const count = setup.issues.length;
  const flag = setup.config_flag ?? null;
  if (setup.config_path === null)
    return (
      <Alert severity="info" variant="outlined">
        <AlertTitle>No configuration file found</AlertTitle>
        {flag === null ? (
          'DCAM found no configuration file, so it collects nothing yet.'
        ) : (
          <>
            DCAM found no file at <code>{flag}</code>, the path given with --config, so it collects nothing
            yet.
          </>
        )}{' '}
        Follow the steps below to create one.
      </Alert>
    );
  return (
    <Alert severity="error" variant="outlined">
      <AlertTitle>DCAM could not load its configuration</AlertTitle>
      DCAM read <code>{setup.config_path}</code> and found {count} {count === 1 ? 'problem' : 'problems'}. It
      collects nothing until the file is valid. Fix each problem below, then restart DCAM.
    </Alert>
  );
}

function IssuesTable({ issues }: { issues: Setup['issues'] }) {
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Configuration issues">
        <TableHead>
          <TableRow>
            <TableCell>Setting</TableCell>
            <TableCell>Problem</TableCell>
            <TableCell>How to fix</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {issues.map((issue, i) => (
            <TableRow key={`${issue.path}-${i}`} sx={{ verticalAlign: 'top' }}>
              <TableCell sx={{ ...mono, whiteSpace: 'nowrap' }}>
                {issue.path === '' ? (
                  <Box component="span" sx={{ fontFamily: 'inherit', fontStyle: 'italic' }}>
                    Whole file
                  </Box>
                ) : (
                  issue.path
                )}
              </TableCell>
              <TableCell>
                <WithCode text={issue.message} />
              </TableCell>
              <TableCell>
                <WithCode text={issue.fix_hint} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

export function SetupPage({ setup }: { setup: Setup }) {
  // Started with --config: every command names that file, else the default dcam.config.yaml.
  const flag = setup.config_flag ? shellWord(setup.config_flag) : null;
  const file = flag ?? 'dcam.config.yaml';
  const withConfig = flag === null ? '' : ` --config ${flag}`;
  return (
    <Stack spacing={4}>
      <PageHeader
        title="Set up DCAM"
        subtitle="DCAM needs a valid configuration file before it reads anything from your environments."
      />
      <Status setup={setup} />
      {setup.issues.length > 0 && (
        <Panel explanation={X['setup-issues']}>
          <IssuesTable issues={setup.issues} />
        </Panel>
      )}
      <Panel explanation={X['setup-steps']}>
        <Stack spacing={3}>
          <Box
            component="ol"
            aria-label="Steps to set up DCAM"
            sx={{ m: 0, pl: 5, display: 'flex', flexDirection: 'column', gap: 3 }}
          >
            <CommandStep
              title="Create your configuration file from the example, in the DCAM folder"
              command={`cp dcam.config.example.yaml ${file}`}
            />
            <Box component="li">
              <Typography variant="body2">
                Open {file} and set <code>projectId</code>, <code>location</code> and <code>environment</code>{' '}
                for each environment you want to monitor.{' '}
                {flag === null
                  ? 'Git ignores this file, so your project IDs stay on this computer.'
                  : 'It holds your project IDs: keep it out of Git.'}
              </Typography>
            </Box>
            <CommandStep
              title="Sign in with your Google account (Application Default Credentials)"
              command="gcloud auth application-default login"
            />
            <CommandStep
              title="Check credentials, access, the proxy and your Airflow role"
              command={`pnpm dcam doctor${withConfig}`}
            />
            <CommandStep title="Stop DCAM (Ctrl+C), then start it again" command={`pnpm dcam${withConfig}`} />
          </Box>
          <Typography variant="body2" color="text.secondary">
            On Windows Command Prompt, use copy instead of cp. To keep the file in another folder, start DCAM
            with <code>--config &lt;path&gt;</code> or set the <code>DCAM_CONFIG</code> environment variable.
          </Typography>
        </Stack>
      </Panel>
    </Stack>
  );
}
