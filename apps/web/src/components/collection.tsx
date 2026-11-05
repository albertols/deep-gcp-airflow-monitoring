/**
 * Collection status shared by the shell (environment badges) and the DCAM health page: one query,
 * polled while DCAM collects live data. Kept out of the page chunk so the shell stays small.
 *
 * @implements FR-COLL-11, FR-SELF-01
 */
import { useQuery } from '@tanstack/react-query';
import type { DcamApi } from '../api';

/**
 * How often the collection status refreshes in live mode. TanStack Query pauses the interval while
 * the browser tab is hidden. (FR-SELF-01 asks for 10 s; 15 s keeps the local polling light.)
 */
export const COLLECTION_POLL_MS = 15_000;

export function useCollection(api: DcamApi, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['collection'],
    queryFn: () => api.getCollection(),
    enabled,
    // Demo data has no collectors and never changes; live status changes every cycle.
    refetchInterval: (query) => (query.state.data?.mode === 'live' ? COLLECTION_POLL_MS : false),
  });
}
