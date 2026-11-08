import { describe, expect, it } from 'vitest';
import {
  MAX_COMPARE,
  MIN_COMPARE,
  addToSelection,
  canCompare,
  formatSelection,
  parseSelection,
  removeFromSelection,
} from '../src/pages/compare/selection';

const A = { envId: 'acme-prod', dagId: 'orders_daily' };
const B = { envId: 'acme-test', dagId: 'orders_daily' };
const C = { envId: 'acme-prod', dagId: 'search_index_rebuild' };
const D = { envId: 'acme-dev', dagId: 'team.a-b' };
const E = { envId: 'acme-prod', dagId: 'payments_daily' };

describe('FR-DAGD-08 compare selection', () => {
  it('FR-DAGD-08: compares 2 to 4 DAGs', () => {
    expect([MIN_COMPARE, MAX_COMPARE]).toEqual([2, 4]);
    expect(canCompare([])).toBe(false);
    expect(canCompare([A])).toBe(false);
    expect(canCompare([A, B])).toBe(true);
    expect(canCompare([A, B, C, D])).toBe(true);
  });

  it('FR-DAGD-08 / FR-UI-02: env:dag items split at the first colon and round-trip', () => {
    const items = [A, B, C, D];
    const param = formatSelection(items);
    expect(param).toBe(
      'acme-prod:orders_daily,acme-test:orders_daily,acme-prod:search_index_rebuild,acme-dev:team.a-b',
    );
    expect(parseSelection(param)).toEqual(items);
  });

  it('FR-DAGD-08: a hand-edited link keeps the valid items, without duplicates, and at most 4', () => {
    expect(parseSelection('')).toEqual([]);
    expect(parseSelection('orders_daily,:x,acme-prod:,Bad_Env:x,acme-prod:orders_daily')).toEqual([A]);
    expect(parseSelection(formatSelection([A, A, B]))).toEqual([A, B]);
    expect(parseSelection(formatSelection([A, B, C, D, E]))).toEqual([A, B, C, D]);
  });

  it('FR-DAGD-08: adding stops at 4 and ignores a DAG already compared; removing keeps the order', () => {
    expect(addToSelection([A, B, C], D)).toEqual([A, B, C, D]);
    expect(addToSelection([A, B, C, D], E)).toEqual([A, B, C, D]);
    expect(addToSelection([A, B], { ...A })).toEqual([A, B]);
    expect(removeFromSelection([A, B, C], B)).toEqual([A, C]);
  });
});
