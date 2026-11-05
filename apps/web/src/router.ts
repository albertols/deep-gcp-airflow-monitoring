/**
 * A small History-API router (spec §12.2): every page and DAG has a shareable URL, and the selected
 * environment travels in `?env=`. Dependency-free on purpose; the server already answers unknown
 * non-API paths with index.html.
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
  | { readonly page: 'alerts' };

export type Page = Route['page'];

export interface Location {
  readonly route: Route;
  readonly envId: string | null;
}

type SimplePage = 'dags' | 'bottlenecks' | 'fleet' | 'advisor' | 'wiki' | 'alerts';
const SIMPLE: ReadonlySet<string> = new Set<SimplePage>([
  'dags',
  'bottlenecks',
  'fleet',
  'advisor',
  'wiki',
  'alerts',
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

const current = (): Location => parseLocation(window.location.pathname, window.location.search);

/** Current location plus a navigate function; also turns clicks on internal links into navigation. */
export function useLocation(): [Location, (href: string) => void] {
  const [location, setLocation] = useState<Location>(current);

  const navigate = useCallback((href: string) => {
    window.history.pushState(null, '', href);
    setLocation(current());
    window.scrollTo?.(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => setLocation(current());
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a');
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith('/api/')) return;
      e.preventDefault();
      navigate(url.pathname + url.search);
    };
    window.addEventListener('popstate', onPop);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('click', onClick);
    };
  }, [navigate]);

  return [location, navigate];
}
