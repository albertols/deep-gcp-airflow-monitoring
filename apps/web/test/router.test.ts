import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, parseLocation, toHref, type Route } from '../src/router';

const at = (route: Route, envId: string | null = null) => ({ route, envId, view: DEFAULT_VIEW, params: {} });

describe('FR-UI-06 deep-linkable routes', () => {
  const cases: Array<[string, Route]> = [
    ['/', { page: 'overview' }],
    ['/dags', { page: 'dags' }],
    ['/dags/orders_daily', { page: 'dag', dagId: 'orders_daily' }],
    ['/bottlenecks', { page: 'bottlenecks' }],
    ['/schedule', { page: 'schedule' }],
    ['/fleet', { page: 'fleet' }],
    ['/advisor', { page: 'advisor' }],
    ['/wiki', { page: 'wiki' }],
    ['/wiki/slot-seconds', { page: 'wiki', slug: 'slot-seconds' }],
    ['/alerts', { page: 'alerts' }],
    ['/health', { page: 'health' }],
  ];

  it.each(cases)('parses %s', (path, route) => {
    expect(parseLocation(path, '')).toEqual(at(route));
  });

  it.each(cases)('round-trips %s', (path, route) => {
    expect(toHref(route, null)).toBe(path);
  });

  it('keeps the selected environment in the query string', () => {
    expect(parseLocation('/dags', '?env=acme-prod')).toEqual(at({ page: 'dags' }, 'acme-prod'));
    expect(toHref({ page: 'dags' }, 'acme-prod')).toBe('/dags?env=acme-prod');
  });

  it('decodes and encodes DAG IDs with characters that are special in URLs', () => {
    const dagId = 'team.a/b c';
    const href = toHref({ page: 'dag', dagId }, null);
    expect(href).toBe('/dags/team.a%2Fb%20c');
    expect(parseLocation(href, '')).toEqual(at({ page: 'dag', dagId }));
  });

  it('falls back to the overview for unknown paths', () => {
    expect(parseLocation('/nope/deeper', '')).toEqual(at({ page: 'overview' }));
  });
});

describe('FR-UI-02 URL as state', () => {
  it('FR-UI-02: encodes the range, time zone and paused state, and leaves defaults out', () => {
    expect(toHref({ page: 'dags' }, 'acme-prod', { range: '7d', tz: 'local', paused: true })).toBe(
      '/dags?env=acme-prod&range=7d&tz=local&paused=1',
    );
    expect(toHref({ page: 'dags' }, 'acme-prod', DEFAULT_VIEW)).toBe('/dags?env=acme-prod');
    expect(parseLocation('/dags', '?env=acme-prod&range=30d&tz=local&paused=1').view).toEqual({
      range: '30d',
      tz: 'local',
      paused: true,
    });
  });

  it('FR-UI-02: page filters, selection and tabs follow the global state and round-trip', () => {
    const href = toHref(
      { page: 'dags' },
      'acme-prod',
      { ...DEFAULT_VIEW, range: '90d' },
      {
        q: 'orders & co',
        team: 'finance-data',
        sort: 'runs.asc',
      },
    );
    expect(href).toBe('/dags?env=acme-prod&range=90d&q=orders+%26+co&team=finance-data&sort=runs.asc');
    const [path, search] = href.split('?') as [string, string];
    expect(parseLocation(path, `?${search}`)).toEqual({
      route: { page: 'dags' },
      envId: 'acme-prod',
      view: { ...DEFAULT_VIEW, range: '90d' },
      params: { q: 'orders & co', team: 'finance-data', sort: 'runs.asc' },
    });
  });

  it('FR-UI-02: values a link cannot mean fall back to the defaults; empty page values are left out', () => {
    expect(parseLocation('/dags', '?range=2d&tz=mars&paused=yes').view).toEqual(DEFAULT_VIEW);
    expect(toHref({ page: 'dags' }, null, DEFAULT_VIEW, { team: '', env: 'acme-dev' })).toBe('/dags');
    expect(parseLocation('/dags', '?team=&range=7d').params).toEqual({});
  });
});
