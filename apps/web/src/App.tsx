/**
 * Application shell (spec §12.2): the global context bar (environment, time range, time zone, live or
 * paused, freshness), the live or demo indicator and the selected environment's collection badges, left
 * navigation, demo banner, routed content. The URL holds the bar's state and each page's own state
 * (FR-UI-02). Pages are separate chunks loaded on first visit (NFR-PERF-05). Pages learn where the selected
 * environment lives for their "Open in" menus from the shell (FR-UI-04). The command palette opens with
 * Ctrl/Cmd+K or the "Jump to" button and navigates with the bar's state kept (FR-UI-03); it is a chunk of
 * its own too, loaded on first open.
 *
 * @implements FR-UI-01, FR-UI-02, FR-UI-03, FR-UI-04, FR-UI-06, FR-EMU-01, FR-SELF-01, FR-SETUP-02, FR-COLL-11,
 *   FR-COLL-06
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Suspense,
  lazy,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Skeleton from '@mui/material/Skeleton';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import type { DcamApi } from './api';
import { CollectionBadges, LiveChip, useCollection } from './components/collection';
import { ContextBar, freshnessOf, type RangeScope } from './components/ContextBar';
import { EnvironmentPlaceContext, type EnvironmentPlaceValue } from './components/OpenInMenu';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import type { PaletteAction } from './components/palette/search';
import { isMacPlatform, shortcutLabel, usePaletteShortcut } from './components/palette/shortcut';
import { localTimeZone as browserTimeZone, timeFormat } from './components/time';
import {
  PageParamsContext,
  ViewContext,
  refreshOptions,
  type PageParamsValue,
  type View,
} from './components/view';
import { NAV } from './nav';
import { OverviewPage } from './OverviewPage';
import type { PageProps } from './pages/types';
import {
  currentLocation,
  linkTo,
  useLocation,
  type Page,
  type PageParams,
  type Route,
  type ViewState,
} from './router';

const named = <K extends string>(load: () => Promise<Record<K, ComponentType<PageProps>>>, name: K) =>
  lazy(async () => ({ default: (await load())[name] }));

const PAGES: Record<Exclude<Page, 'overview'>, ComponentType<PageProps>> = {
  dags: named(() => import('./pages/dags/DagsPage'), 'DagsPage'),
  dag: named(() => import('./pages/dags/DagDetailPage'), 'DagDetailPage'),
  bottlenecks: named(() => import('./pages/bottlenecks/BottlenecksPage'), 'BottlenecksPage'),
  schedule: named(() => import('./pages/schedule/SchedulePage'), 'SchedulePage'),
  fleet: named(() => import('./pages/fleet/FleetPage'), 'FleetPage'),
  advisor: named(() => import('./pages/advisor/AdvisorPage'), 'AdvisorPage'),
  wiki: named(() => import('./pages/wiki/WikiPage'), 'WikiPage'),
  alerts: named(() => import('./pages/alerts/AlertsPage'), 'AlertsPage'),
  health: named(() => import('./pages/health/HealthPage'), 'HealthPage'),
};

/** Loaded on first open (FR-UI-03), with the wiki and rule registries it searches. */
const CommandPalette = lazy(async () => ({
  default: (await import('./components/palette/CommandPalette')).CommandPalette,
}));

/** Shown only in setup mode (FR-SETUP-02), so it stays out of the main chunk. */
const SetupPage = lazy(async () => ({ default: (await import('./pages/setup/SetupPage')).SetupPage }));

const LOADING = <Skeleton variant="rounded" height={240} aria-label="Loading page" />;

const NAV_WIDTH = 232;

/** Which pages follow the selected range; the others say so in the bar (FR-UI-01). */
const RANGE_SCOPE: Readonly<Record<Page, RangeScope>> = {
  overview: 'range',
  dags: 'range',
  dag: 'range',
  bottlenecks: 'range',
  schedule: 'range',
  fleet: 'fixed-24h',
  advisor: 'fixed-24h',
  alerts: 'fixed-24h',
  health: 'none',
  wiki: 'none',
};

/** Page state that belongs to one range or environment: a selected run is not in another one. */
const SELECTION_PARAMS: readonly string[] = ['run'];
const withoutSelection = (params: PageParams): PageParams =>
  Object.fromEntries(Object.entries(params).filter(([k]) => !SELECTION_PARAMS.includes(k)));

/**
 * The oldest "data as of" among the queries the page shows: every panel on the page is at least this
 * fresh (FR-UI-01 freshness indicator).
 */
function usePageDataAsOf(): string | null {
  const cache = useQueryClient().getQueryCache();
  const subscribe = useCallback((onChange: () => void) => cache.subscribe(onChange), [cache]);
  const read = useCallback(() => {
    let oldest: string | null = null;
    for (const q of cache.findAll({ type: 'active' })) {
      const at = (q.state.data as { data_as_of?: unknown } | undefined)?.data_as_of;
      if (typeof at === 'string' && (oldest === null || Date.parse(at) < Date.parse(oldest))) oldest = at;
    }
    return oldest;
  }, [cache]);
  return useSyncExternalStore(subscribe, read, read);
}

export function App({ api, localTimeZone }: { api: DcamApi; localTimeZone?: string }) {
  const [location, go] = useLocation();
  const { route, view, params } = location;
  const queryClient = useQueryClient();
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.getMeta(), ...refreshOptions(view.paused) });
  const environments = meta.data?.environments ?? [];
  const envId =
    environments.find((e) => e.env_id === location.envId)?.env_id ?? environments[0]?.env_id ?? null;
  // Where the selected environment lives, for the pages' "Open in" menus (FR-UI-04).
  const mode = meta.data?.mode;
  const summary = environments.find((e) => e.env_id === envId);
  const place = useMemo<EnvironmentPlaceValue | null>(
    () => (mode && summary ? { mode, place: summary } : null),
    [mode, summary],
  );
  const local = localTimeZone ?? browserTimeZone();
  const time = timeFormat(view.tz, local);
  const pageView = useMemo<View>(() => ({ ...view, time }), [view, time]);
  // Links to other pages keep the context bar's state, not this page's filters.
  const link = useCallback((r: Route) => linkTo(r, envId, view), [envId, view]);
  const navigate = useCallback((r: Route) => go(linkTo(r, envId, view)), [go, envId, view]);

  const setView = (patch: Partial<ViewState>) => {
    const next = { ...view, ...patch };
    const rangeChanged = next.range !== view.range;
    // A new range is a new view (back returns to the old one); the zone and pausing are toggles.
    go(linkTo(route, envId, next, rangeChanged ? withoutSelection(params) : params), {
      replace: !rangeChanged,
    });
    // Resuming loads the latest data at once instead of at the next poll.
    if (view.paused && !next.paused) void queryClient.invalidateQueries();
  };

  // Page parameters merge with the address bar as it is now, so several changes in one event all stay.
  const setParams = useCallback(
    (patch: Readonly<Record<string, string | null>>) => {
      const next: Record<string, string> = { ...currentLocation().params };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') delete next[key];
        else next[key] = value;
      }
      go(linkTo(route, envId, view, next), { replace: true });
    },
    [go, route, envId, view],
  );
  const pageParams = useMemo<PageParamsValue>(() => ({ params, set: setParams }), [params, setParams]);

  // Setup mode (FR-SETUP-02): no environment is configured, so only the setup page applies.
  const setup = meta.data?.setup;
  // Only live mode has collectors; the badges poll their status (FR-COLL-11).
  const live = meta.data?.mode === 'live' && !setup;
  const collection = useCollection(api, { enabled: live, paused: view.paused });
  const envCollection = live ? collection.data?.environments.find((e) => e.env_id === envId) : undefined;
  const dataAsOf = usePageDataAsOf();
  const PageComponent = route.page === 'overview' ? null : PAGES[route.page];

  // The command palette (FR-UI-03): mounted from its first open on, so closing restores focus.
  const [palette, setPalette] = useState({ open: false, used: false });
  const setPaletteOpen = useCallback(
    (open: boolean) => setPalette((p) => ({ open, used: p.used || open })),
    [],
  );
  usePaletteShortcut(palette.open, setPaletteOpen, !setup);
  const keys = useMemo(() => shortcutLabel(isMacPlatform()), []);
  const choose = (action: PaletteAction) => {
    setPaletteOpen(false);
    if (action.kind === 'environment') go(linkTo(route, action.envId, view, withoutSelection(params)));
    else navigate(action.route);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static" elevation={0}>
        <Toolbar sx={{ gap: 4, minHeight: { xs: 64 }, py: 2, flexWrap: 'wrap' }}>
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
          {envId && !setup && (
            <ContextBar
              environments={environments}
              envId={envId}
              onEnvironment={(next) => go(linkTo(route, next, view, withoutSelection(params)))}
              view={view}
              onView={setView}
              rangeScope={RANGE_SCOPE[route.page]}
              time={time}
              localZoneName={timeFormat('local', local).zoneName()}
              dataAsOf={dataAsOf}
              freshness={live ? freshnessOf(envCollection) : null}
              badges={<CollectionBadges env={envCollection} href={link({ page: 'health' })} />}
            />
          )}
          {!setup && (
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              startIcon={<SearchOutlined aria-hidden />}
              onClick={() => setPaletteOpen(true)}
              aria-keyshortcuts={keys.aria}
              sx={{ textTransform: 'none' }}
            >
              Jump to
              <Box
                component="kbd"
                sx={{
                  ml: 2,
                  px: 1,
                  borderRadius: 0.5,
                  border: 1,
                  borderColor: 'divider',
                  fontSize: '0.75rem',
                }}
              >
                {keys.text}
              </Box>
            </Button>
          )}
          <Box sx={{ flex: 1 }} />
          {meta.data?.mode === 'demo' && (
            <Chip size="small" color="warning" variant="outlined" label="Demo data" />
          )}
          {live && <LiveChip />}
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
            <ViewContext.Provider value={pageView}>
              <PageParamsContext.Provider value={pageParams}>
                <EnvironmentPlaceContext.Provider value={place}>
                  <PageErrorBoundary resetKey={linkTo(route, envId, view)}>
                    {envId && route.page === 'overview' && <OverviewPage api={api} envId={envId} />}
                    {envId && PageComponent && (
                      <Suspense fallback={LOADING}>
                        <PageComponent
                          api={api}
                          envId={envId}
                          route={route}
                          linkTo={link}
                          navigate={navigate}
                        />
                      </Suspense>
                    )}
                  </PageErrorBoundary>
                </EnvironmentPlaceContext.Provider>
              </PageParamsContext.Provider>
            </ViewContext.Provider>
          </Box>
        </Box>
      )}

      {palette.used && (
        <Suspense fallback={null}>
          <CommandPalette
            open={palette.open}
            onClose={() => setPaletteOpen(false)}
            api={api}
            envId={envId}
            environments={environments}
            onChoose={choose}
          />
        </Suspense>
      )}
    </Box>
  );
}
