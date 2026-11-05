import { describe, expect, it } from 'vitest';
import { parseLocation, toHref, type Route } from '../src/router';

describe('FR-UI-06 deep-linkable routes', () => {
  const cases: Array<[string, Route]> = [
    ['/', { page: 'overview' }],
    ['/dags', { page: 'dags' }],
    ['/dags/orders_daily', { page: 'dag', dagId: 'orders_daily' }],
    ['/bottlenecks', { page: 'bottlenecks' }],
    ['/fleet', { page: 'fleet' }],
    ['/advisor', { page: 'advisor' }],
    ['/wiki', { page: 'wiki' }],
    ['/wiki/slot-seconds', { page: 'wiki', slug: 'slot-seconds' }],
    ['/alerts', { page: 'alerts' }],
  ];

  it.each(cases)('parses %s', (path, route) => {
    expect(parseLocation(path, '')).toEqual({ route, envId: null });
  });

  it.each(cases)('round-trips %s', (path, route) => {
    expect(toHref(route, null)).toBe(path);
  });

  it('keeps the selected environment in the query string', () => {
    expect(parseLocation('/dags', '?env=acme-prod')).toEqual({ route: { page: 'dags' }, envId: 'acme-prod' });
    expect(toHref({ page: 'dags' }, 'acme-prod')).toBe('/dags?env=acme-prod');
  });

  it('decodes and encodes DAG IDs with characters that are special in URLs', () => {
    const dagId = 'team.a/b c';
    const href = toHref({ page: 'dag', dagId }, null);
    expect(href).toBe('/dags/team.a%2Fb%20c');
    expect(parseLocation(href, '')).toEqual({ route: { page: 'dag', dagId }, envId: null });
  });

  it('falls back to the overview for unknown paths', () => {
    expect(parseLocation('/nope/deeper', '')).toEqual({ route: { page: 'overview' }, envId: null });
  });
});
