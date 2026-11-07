/**
 * A small hash router (spec §12.2) with the URL as the view's state (FR-UI-02): every page and DAG has a
 * shareable URL such as `#/dags/orders_daily?env=acme-prod&range=7d&tz=local&run=…`. The context bar's
 * state (environment, range, time zone, paused) comes first, then the page's own filters, selection and
 * tabs; defaults are left out, and values a link cannot mean fall back to them. Hash URLs keep asset
 * paths relative, so the UI also works when embedded under a sub-path (ARCH-EMB-02). Dependency-free on
 * purpose.
 *
 * @implements FR-UI-02, FR-UI-06
 */
import { useCallback, useEffect, useState } from 'react';
import type { Range } from '@dcam/contracts';
import { isRange } from './components/range';
import type { TimeZoneChoice } from './components/time';

export type Route =
  | { readonly page: 'overview' }
  | { readonly page: 'dags' }
  | { readonly page: 'dag'; readonly dagId: string }
  | { readonly page: 'bottlenecks' }
  | { readonly page: 'schedule' }
  | { readonly page: 'fleet' }
  | { readonly page: 'advisor' }
  | { readonly page: 'wiki'; readonly slug?: string }
  | { readonly page: 'alerts' }
  | { readonly page: 'health' };

export type Page = Route['page'];

/** The context bar's state (FR-UI-01), shared by every page. */
export interface ViewState {
  readonly range: Range;
  readonly tz: TimeZoneChoice;
  /** Polling stopped: the page keeps what it shows until the user resumes. */
  readonly paused: boolean;
}

export const DEFAULT_VIEW: ViewState = { range: '24h', tz: 'utc', paused: false };

/** A page's own state in the URL: filters, sort, selection and tabs (FR-UI-02). */
export type PageParams = Readonly<Record<string, string>>;

export interface Location {
  readonly route: Route;
  readonly envId: string | null;
  readonly view: ViewState;
  readonly params: PageParams;
}

/** Query keys of the context bar; pages cannot use them for their own state. */
const GLOBAL_KEYS: ReadonlySet<string> = new Set(['env', 'range', 'tz', 'paused']);

type SimplePage = 'dags' | 'bottlenecks' | 'schedule' | 'fleet' | 'advisor' | 'wiki' | 'alerts' | 'health';
const SIMPLE: ReadonlySet<string> = new Set<SimplePage>([
  'dags',
  'bottlenecks',
  'schedule',
  'fleet',
  'advisor',
  'wiki',
  'alerts',
  'health',
]);
const isSimple = (s: string): s is SimplePage => SIMPLE.has(s);

export function parseLocation(pathname: string, search: string): Location {
  const query = new URLSearchParams(search);
  const envId = query.get('env');
  const [first, second, ...rest] = pathname.split('/').filter(Boolean);
  let route: Route = { page: 'overview' };
  if (first === 'dags' && second !== undefined && rest.length === 0) {
    route = { page: 'dag', dagId: decodeURIComponent(second) };
  } else if (first === 'wiki' && second !== undefined && rest.length === 0) {
    route = { page: 'wiki', slug: decodeURIComponent(second) };
  } else if (first !== undefined && second === undefined && isSimple(first)) {
    route = { page: first };
  }
  const range = query.get('range') ?? '';
  const view: ViewState = {
    range: isRange(range) ? range : DEFAULT_VIEW.range,
    tz: query.get('tz') === 'local' ? 'local' : 'utc',
    paused: query.get('paused') === '1',
  };
  const params: Record<string, string> = {};
  for (const [key, value] of query) if (!GLOBAL_KEYS.has(key) && value !== '') params[key] = value;
  return { route, envId: envId || null, view, params };
}

function pathOf(route: Route): string {
  switch (route.page) {
    case 'overview':
      return '/';
    case 'dag':
      return `/dags/${encodeURIComponent(route.dagId)}`;
    case 'wiki':
      return route.slug ? `/wiki/${encodeURIComponent(route.slug)}` : '/wiki';
    default:
      return `/${route.page}`;
  }
}

/** The path and query of a view: the environment and the context bar first, then the page's own state. */
export function toHref(
  route: Route,
  envId: string | null,
  view: ViewState = DEFAULT_VIEW,
  params: PageParams = {},
): string {
  const query = new URLSearchParams();
  if (envId) query.set('env', envId);
  if (view.range !== DEFAULT_VIEW.range) query.set('range', view.range);
  if (view.tz !== DEFAULT_VIEW.tz) query.set('tz', view.tz);
  if (view.paused) query.set('paused', '1');
  for (const [key, value] of Object.entries(params))
    if (!GLOBAL_KEYS.has(key) && value !== '') query.set(key, value);
  const search = query.toString();
  return search ? `${pathOf(route)}?${search}` : pathOf(route);
}

/** An `href` for links: the route as a hash URL. */
export function linkTo(
  route: Route,
  envId: string | null,
  view: ViewState = DEFAULT_VIEW,
  params: PageParams = {},
): string {
  return `#${toHref(route, envId, view, params)}`;
}

/** The location in the address bar now (changes made with `replace` are there at once). */
export function currentLocation(): Location {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const at = raw.indexOf('?');
  return at === -1 ? parseLocation(raw, '') : parseLocation(raw.slice(0, at), raw.slice(at));
}

export interface NavigateOptions {
  /** Replace the current history entry (filters, toggles) instead of adding one (pages, ranges). */
  readonly replace?: boolean;
}

/** The current location, kept in sync with the URL, and a function to go to a hash URL. */
export function useLocation(): [Location, (href: string, options?: NavigateOptions) => void] {
  const [location, setLocation] = useState<Location>(currentLocation);
  const navigate = useCallback((href: string, options: NavigateOptions = {}) => {
    const hash = `#${href.replace(/^#/, '')}`;
    if (options.replace) {
      // replaceState fires no hashchange: update the location here.
      window.history.replaceState(window.history.state, '', hash);
      setLocation(currentLocation());
    } else {
      window.location.hash = hash;
    }
  }, []);
  useEffect(() => {
    let path = currentLocation().route;
    const onChange = () => {
      const next = currentLocation();
      setLocation(next);
      // A new page starts at the top; a new range or filter on the same page keeps the scroll position.
      if (pathOf(next.route) !== pathOf(path)) window.scrollTo?.(0, 0);
      path = next.route;
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [location, navigate];
}
