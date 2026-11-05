/**
 * Application shell (spec §12.2): top context bar, left navigation, demo banner, routed content.
 * Pages are separate chunks loaded on first visit (NFR-PERF-05).
 *
 * @implements FR-UI-06, FR-EMU-01, FR-SELF-01, FR-SETUP-02
 */
import { useQuery } from '@tanstack/react-query';
import { Suspense, lazy, useCallback, type ComponentType } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import type { DcamApi } from './api';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { OverviewPage } from './OverviewPage';
import type { PageProps } from './pages/types';
import { linkTo, useLocation, type Page, type Route } from './router';

const named = <K extends string>(load: () => Promise<Record<K, ComponentType<PageProps>>>, name: K) =>
  lazy(async () => ({ default: (await load())[name] }));

const PAGES: Record<Exclude<Page, 'overview'>, ComponentType<PageProps>> = {
  dags: named(() => import('./pages/dags/DagsPage'), 'DagsPage'),
  dag: named(() => import('./pages/dags/DagDetailPage'), 'DagDetailPage'),
  bottlenecks: named(() => import('./pages/bottlenecks/BottlenecksPage'), 'BottlenecksPage'),
  fleet: named(() => import('./pages/fleet/FleetPage'), 'FleetPage'),
  advisor: named(() => import('./pages/advisor/AdvisorPage'), 'AdvisorPage'),
  wiki: named(() => import('./pages/wiki/WikiPage'), 'WikiPage'),
  alerts: named(() => import('./pages/alerts/AlertsPage'), 'AlertsPage'),
  health: named(() => import('./pages/health/HealthPage'), 'HealthPage'),
};

/** Shown only in setup mode (FR-SETUP-02), so it stays out of the main chunk. */
const SetupPage = lazy(async () => ({ default: (await import('./pages/setup/SetupPage')).SetupPage }));

const LOADING = <Skeleton variant="rounded" height={240} aria-label="Loading page" />;

const NAV: ReadonlyArray<{ label: string; route: Route; hint: string; matches: readonly Page[] }> = [
  { label: 'Fleet', route: { page: 'fleet' }, hint: 'Every environment', matches: ['fleet'] },
  { label: 'Capacity overview', route: { page: 'overview' }, hint: 'One environment', matches: ['overview'] },
  { label: 'DAG league table', route: { page: 'dags' }, hint: 'Who uses capacity', matches: ['dags', 'dag'] },
  { label: 'Bottlenecks', route: { page: 'bottlenecks' }, hint: 'Why work waits', matches: ['bottlenecks'] },
  { label: 'Advisor', route: { page: 'advisor' }, hint: 'What to change', matches: ['advisor'] },
  { label: 'Alerts', route: { page: 'alerts' }, hint: 'Local alert rules', matches: ['alerts'] },
  { label: 'DCAM health', route: { page: 'health' }, hint: 'What DCAM collects', matches: ['health'] },
  { label: 'Wiki', route: { page: 'wiki' }, hint: 'How it works', matches: ['wiki'] },
];

const NAV_WIDTH = 232;

export function App({ api }: { api: DcamApi }) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.getMeta() });
  const [location, go] = useLocation();
  const environments = meta.data?.environments ?? [];
  const envId =
    environments.find((e) => e.env_id === location.envId)?.env_id ?? environments[0]?.env_id ?? null;
  const link = useCallback((route: Route) => linkTo(route, envId), [envId]);
  const navigate = useCallback((route: Route) => go(linkTo(route, envId)), [go, envId]);
  const { route } = location;
  // Setup mode (FR-SETUP-02): no environment is configured, so only the setup page applies.
  const setup = meta.data?.setup;
  const PageComponent = route.page === 'overview' ? null : PAGES[route.page];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static" elevation={0}>
        <Toolbar sx={{ gap: 4, minHeight: { xs: 64 }, py: 2 }}>
          <Typography component="div" sx={{ fontWeight: 500, fontSize: '1.125rem' }}>
            DCAM
            <Typography
              component="span"
              variant="body2"
              color="text.secondary"
              sx={{ ml: 2, display: { xs: 'none', md: 'inline' } }}
            >
              deep-gcp-airflow-monitoring
            </Typography>
          </Typography>
          {envId && (
            <TextField
              select
              size="small"
              label="Environment"
              value={envId}
              onChange={(e) => go(linkTo(route, e.target.value))}
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
          {meta.data?.mode === 'demo' && (
            <Chip size="small" color="warning" variant="outlined" label="Demo data" />
          )}
          {setup && <Chip size="small" color="warning" variant="outlined" label="Setup needed" />}
          {meta.data && (
            <Typography variant="caption" color="text.secondary">
              v{meta.data.version}
            </Typography>
          )}
        </Toolbar>
      </AppBar>

      {meta.data?.mode === 'demo' && (
        <Alert
          severity="info"
          variant="outlined"
          sx={{ borderRadius: 0, borderLeft: 0, borderRight: 0, borderTop: 0 }}
        >
          You're viewing demo data for the fictitious "acme" organisation. Nothing here comes from Google
          Cloud.
        </Alert>
      )}

      {setup ? (
        <Box component="main" sx={{ flex: 1, p: { xs: 4, md: 6 }, minWidth: 0, maxWidth: 1100 }}>
          <PageErrorBoundary resetKey="setup">
            <Suspense fallback={LOADING}>
              <SetupPage setup={setup} />
            </Suspense>
          </PageErrorBoundary>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flex: 1, flexDirection: { xs: 'column', md: 'row' } }}>
          <Box
            component="nav"
            aria-label="Main"
            sx={{
              width: { md: NAV_WIDTH },
              flexShrink: 0,
              borderRight: { md: 1 },
              borderBottom: { xs: 1, md: 0 },
              borderColor: 'divider',
            }}
          >
            <List dense>
              {NAV.map((item) => {
                const current = item.matches.includes(route.page);
                return (
                  <ListItemButton
                    key={item.label}
                    component="a"
                    href={link(item.route)}
                    selected={current}
                    aria-current={current ? 'page' : undefined}
                  >
                    <ListItemText primary={item.label} secondary={item.hint} />
                  </ListItemButton>
                );
              })}
            </List>
          </Box>
          <Box component="main" sx={{ flex: 1, p: { xs: 4, md: 6 }, minWidth: 0 }}>
            {meta.isError && (
              <Alert severity="error">
                Couldn't reach the DCAM server. Check that it is still running, then reload the page.
              </Alert>
            )}
            <PageErrorBoundary resetKey={linkTo(route, envId)}>
              {envId && route.page === 'overview' && <OverviewPage api={api} envId={envId} />}
              {envId && PageComponent && (
                <Suspense fallback={LOADING}>
                  <PageComponent api={api} envId={envId} route={route} linkTo={link} navigate={navigate} />
                </Suspense>
              )}
            </PageErrorBoundary>
          </Box>
        </Box>
      )}
    </Box>
  );
}
