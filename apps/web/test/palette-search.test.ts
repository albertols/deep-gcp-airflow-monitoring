import { describe, expect, it } from 'vitest';
import { buildPaletteIndex, searchPalette, type PaletteTarget } from '../src/components/palette/search';
import { dagTargets, environmentTargets, staticTargets } from '../src/components/palette/targets';

const dag = (dagId: string): PaletteTarget => ({
  key: `dag:${dagId}`,
  kind: 'dag',
  label: dagId,
  action: { kind: 'route', route: { page: 'dag', dagId } },
});
const labels = (q: string, targets: readonly PaletteTarget[], limit?: number) =>
  searchPalette(buildPaletteIndex(targets), q, limit).matches.map((m) => m.target.label);

describe('FR-UI-03 palette ranking', () => {
  const targets = ['records_sync', 'acme_orders_b', 'orders_daily', 'acme_orders_a', 'ord', 'billing'].map(
    dag,
  );

  it('FR-UI-03: exact, then prefix, then word prefix, then substring; no match is left out', () => {
    expect(labels('ord', targets)).toEqual([
      'ord',
      'orders_daily',
      'acme_orders_a',
      'acme_orders_b',
      'records_sync',
    ]);
  });

  it('FR-UI-03: matches ignore case and surrounding spaces; ties sort alphabetically', () => {
    expect(labels('  ORD ', [dag('Ord'), dag('ord'), dag('ordinal')])).toEqual(['Ord', 'ord', 'ordinal']);
    expect(labels('orders', targets)).toEqual(['orders_daily', 'acme_orders_a', 'acme_orders_b']);
  });

  it('FR-UI-03: a word starts after any separator, and a later occurrence can be the word start', () => {
    expect(labels('sync', [dag('acme.partner-sync'), dag('acme_resync_sync'), dag('async_jobs')])).toEqual([
      'acme.partner-sync',
      'acme_resync_sync',
      'async_jobs',
    ]);
  });

  it('FR-UI-03: shows at most the limit and counts every match', () => {
    const many = Array.from({ length: 120 }, (_, i) => dag(`acme_load_${String(i).padStart(3, '0')}`));
    const result = searchPalette(buildPaletteIndex(many), 'load', 50);
    expect(result.total).toBe(120);
    expect(result.matches).toHaveLength(50);
    expect(result.matches[0]?.target.label).toBe('acme_load_000');
  });

  it('FR-UI-03: an empty query matches nothing (the palette lists pages instead)', () => {
    expect(searchPalette(buildPaletteIndex(targets), '   ').total).toBe(0);
  });
});

describe('FR-UI-03 palette targets', () => {
  it('FR-UI-03: pages, wiki pages, advisor rules and alert rules come from their registries', () => {
    const all = staticTargets();
    const kinds = new Set(all.map((t) => t.kind));
    expect([...kinds].sort()).toEqual(['advisor-rule', 'alert-rule', 'page', 'wiki']);
    expect(labels('bottle', all)[0]).toBe('Bottlenecks');
    const rule = all.find((t) => t.kind === 'advisor-rule' && t.label.startsWith('REC-CAP-01'));
    expect(rule?.action).toEqual({ kind: 'route', route: { page: 'wiki', slug: 'advisor-rules' } });
    const alert = all.find((t) => t.kind === 'alert-rule' && t.label.startsWith('AL-05'));
    expect(alert?.action).toEqual({ kind: 'route', route: { page: 'alerts' } });
    expect(new Set(all.map((t) => t.key)).size).toBe(all.length);
  });

  it('FR-UI-03: environments switch the environment; DAGs open the DAG and say their team', () => {
    const [env] = environmentTargets([
      { env_id: 'acme-prod', display_name: 'acme production', tier: 'prod' },
    ]);
    expect(env).toMatchObject({ kind: 'environment', label: 'acme production', detail: 'acme-prod · prod' });
    expect(env?.action).toEqual({ kind: 'environment', envId: 'acme-prod' });
    const [d] = dagTargets([{ dag_id: 'acme_orders', team: 'finance', paused: true }]);
    expect(d).toMatchObject({ kind: 'dag', label: 'acme_orders', detail: 'Team finance · paused' });
    expect(d?.action).toEqual({ kind: 'route', route: { page: 'dag', dagId: 'acme_orders' } });
  });
});

describe('FR-UI-03 / NFR-PERF palette speed', () => {
  it('FR-UI-03: 5,000 DAGs plus every other target answer a three-character query in under 100 ms', () => {
    const domains = ['orders', 'billing', 'fraud', 'crm', 'ledger', 'payments', 'search', 'ml', 'ads', 'hr'];
    const verbs = ['daily', 'hourly', 'sync', 'export', 'load', 'score', 'rollup', 'backfill'];
    const dags = Array.from({ length: 5_000 }, (_, i) => ({
      dag_id: `acme_${domains[i % domains.length]}_${verbs[(i * 7) % verbs.length]}_${i}`,
      team: domains[i % domains.length] ?? 'acme',
      paused: i % 11 === 0,
    }));
    const envs = Array.from({ length: 8 }, (_, i) => ({
      env_id: `acme-env-${i}`,
      display_name: `acme-env-${i}`,
      tier: 'prod' as const,
    }));
    const index = buildPaletteIndex([...staticTargets(), ...environmentTargets(envs), ...dagTargets(dags)]);
    searchPalette(index, 'acm'); // warm up the JIT once
    for (const q of ['acm', 'ord', 'syn', 'ly_', 'rec', 'zzz']) {
      const started = performance.now();
      const result = searchPalette(index, q);
      const ms = performance.now() - started;
      expect(ms, `"${q}" took ${ms.toFixed(1)} ms`).toBeLessThan(100);
      expect(result.matches.length).toBeLessThanOrEqual(50);
    }
    expect(searchPalette(index, 'acm').total).toBeGreaterThanOrEqual(5_008);
  });
});
