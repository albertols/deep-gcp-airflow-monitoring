/**
 * A small hash router (spec §12.2): every page and DAG has a shareable URL such as
 * `#/dags/orders_daily?env=acme-prod`. Hash URLs keep asset paths relative, so the UI also works when
 * embedded under a sub-path (ARCH-EMB-02). Dependency-free on purpose.
 *
 * @implements FR-UI-06
 */
import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { readonly page: 'overview' }
  | { readonly page: 'dags' }
  | { readonly page: 'dag'; readonly dagId: string }
  | { readonly page: 'bottlenecks' }
  | { readonly page: 'fleet' }
  | { readonly page: 'advisor' }
  | { readonly page: 'wiki'; readonly slug?: string }
  | { readonly page: 'alerts' }
  | { readonly page: 'health' };

export type Page = Route['page'];

export interface Location {
  readonly route: Route;
  readonly envId: string | null;
}

type SimplePage = 'dags' | 'bottlenecks' | 'fleet' | 'advisor' | 'wiki' | 'alerts' | 'health';
const SIMPLE: ReadonlySet<string> = new Set<SimplePage>([
  'dags',
  'bottlenecks',
  'fleet',
  'advisor',
  'wiki',
  'alerts',
  'health',
]);
const isSimple = (s: string): s is SimplePage => SIMPLE.has(s);

export function parseLocation(pathname: string, search: string): Location {
  const envId = new URLSearchParams(search).get('env');
  const [first, second, ...rest] = pathname.split('/').filter(Boolean);
  let route: Route = { page: 'overview' };
  if (first === 'dags' && second !== undefined && rest.length === 0) {
    route = { page: 'dag', dagId: decodeURIComponent(second) };
  } else if (first === 'wiki' && second !== undefined && rest.length === 0) {
    route = { page: 'wiki', slug: decodeURIComponent(second) };
  } else if (first !== undefined && second === undefined && isSimple(first)) {
    route = { page: first };
  }
  return { route, envId: envId || null };
}

export function toHref(route: Route, envId: string | null): string {
  let path: string;
  switch (route.page) {
    case 'overview':
      path = '/';
      break;
    case 'dag':
      path = `/dags/${encodeURIComponent(route.dagId)}`;
      break;
    case 'wiki':
      path = route.slug ? `/wiki/${encodeURIComponent(route.slug)}` : '/wiki';
      break;
    default:
      path = `/${route.page}`;
  }
  return envId ? `${path}?env=${encodeURIComponent(envId)}` : path;
}

/** An `href` for links: the route as a hash URL. */
export function linkTo(route: Route, envId: string | null): string {
  return `#${toHref(route, envId)}`;
}

function current(): Location {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const at = raw.indexOf('?');
  return at === -1 ? parseLocation(raw, '') : parseLocation(raw.slice(0, at), raw.slice(at));
}

/** The current location, kept in sync with the URL, and a function to go to a hash URL. */
export function useLocation(): [Location, (href: string) => void] {
  const [location, setLocation] = useState<Location>(current);
  const navigate = useCallback((href: string) => {
    window.location.hash = href.replace(/^#/, '');
  }, []);
  useEffect(() => {
    const onChange = () => {
      setLocation(current());
      window.scrollTo?.(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [location, navigate];
}
