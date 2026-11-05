/**
 * Application shell (spec §12.2): top context bar, left navigation, demo banner, main content.
 *
 * @implements FR-UI-06, FR-EMU-01
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import type { DcamApi } from './api';
import { OverviewPage } from './OverviewPage';

const NAV: ReadonlyArray<{ label: string; milestone?: string }> = [
  { label: 'Capacity overview' },
  { label: 'DAG league table', milestone: 'M2' },
  { label: 'Bottlenecks', milestone: 'M3' },
  { label: 'Fleet', milestone: 'M4' },
  { label: 'Advisor', milestone: 'M5' },
  { label: 'Wiki', milestone: 'M6' },
  { label: 'Alerts', milestone: 'M7' },
];

const NAV_WIDTH = 232;

export function App({ api }: { api: DcamApi }) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.getMeta() });
  const [envId, setEnvId] = useState<string | null>(null);
  const environments = meta.data?.environments ?? [];
  const selected = envId ?? environments[0]?.env_id ?? null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static" elevation={0}>
        <Toolbar sx={{ gap: 4, minHeight: { xs: 64 }, py: 2 }}>
          <Typography component="div" sx={{ fontWeight: 500, fontSize: '1.125rem' }}>
            DCAM
            <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 2, display: { xs: 'none', md: 'inline' } }}>
              deep-gcp-airflow-monitoring
            </Typography>
          </Typography>
          {environments.length > 0 && selected && (
            <TextField
              select
              size="small"
              label="Environment"
              value={selected}
              onChange={(e) => setEnvId(e.target.value)}
              sx={{ minWidth: 200 }}
            >
              {environments.map((e) => (
                <MenuItem key={e.env_id} value={e.env_id}>
                  {e.display_name} · {e.tier}
                </MenuItem>
              ))}
            </TextField>
          )}
          <Box sx={{ flex: 1 }} />
          {meta.data?.mode === 'demo' && <Chip size="small" color="warning" variant="outlined" label="Demo data" />}
          {meta.data && (
            <Typography variant="caption" color="text.secondary">
              v{meta.data.version}
            </Typography>
          )}
        </Toolbar>
      </AppBar>

      {meta.data?.mode === 'demo' && (
        <Alert severity="info" variant="outlined" sx={{ borderRadius: 0, borderLeft: 0, borderRight: 0, borderTop: 0 }}>
          You're viewing demo data for the fictitious "acme" organisation. Nothing here comes from Google Cloud.
        </Alert>
      )}

      <Box sx={{ display: 'flex', flex: 1, flexDirection: { xs: 'column', md: 'row' } }}>
        <Box
          component="nav"
          aria-label="Main"
          sx={{ width: { md: NAV_WIDTH }, flexShrink: 0, borderRight: { md: 1 }, borderBottom: { xs: 1, md: 0 }, borderColor: 'divider' }}
        >
          <List dense>
            {NAV.map((item) => (
              <ListItemButton key={item.label} selected={!item.milestone} disabled={Boolean(item.milestone)}>
                <ListItemText primary={item.label} secondary={item.milestone ? `Coming in ${item.milestone}` : undefined} />
              </ListItemButton>
            ))}
          </List>
        </Box>
        <Box component="main" sx={{ flex: 1, p: { xs: 4, md: 6 }, minWidth: 0 }}>
          {meta.isError && <Alert severity="error">Couldn't reach the DCAM server. Check that it is still running, then reload the page.</Alert>}
          {selected && <OverviewPage api={api} envId={selected} />}
        </Box>
      </Box>
    </Box>
  );
}
