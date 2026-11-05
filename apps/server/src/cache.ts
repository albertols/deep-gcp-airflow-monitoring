/**
 * A short-lived, bounded memo for aggregated views (NFR-PERF-01). Results only change once per
 * collection cycle, so serving the same answer for a few seconds is within the stated freshness.
 * Concurrent requests share one computation; failures are never kept.
 */
export interface MemoOptions {
  readonly ttlMs: number;
  readonly now?: () => number;
  readonly maxEntries?: number;
}

export type Memo = <T>(key: string, compute: () => Promise<T>) => Promise<T>;

export function createMemo({ ttlMs, now = Date.now, maxEntries = 256 }: MemoOptions): Memo {
  const entries = new Map<string, { at: number; value: Promise<unknown> }>();
  return <T>(key: string, compute: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = compute();
    entries.delete(key);
    entries.set(key, { at: now(), value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return value;
  };
}
