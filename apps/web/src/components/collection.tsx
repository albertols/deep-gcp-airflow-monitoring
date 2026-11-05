/**
 * Collection status shared by the shell (live indicator, environment badges) and the DCAM health
 * page: one query, polled while DCAM collects live data. Kept out of the page chunk so the shell
 * stays small.
 *
 * @implements FR-COLL-11, FR-COLL-06, FR-SELF-01
 */
import { useQuery } from '@tanstack/react-query';
import Chip from '@mui/material/Chip';
import ErrorOutlined from '@mui/icons-material/ErrorOutlined';
import SensorsOutlined from '@mui/icons-material/SensorsOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import type { CollectionEnvironment } from '@dcam/contracts';
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

/** The header's live indicator: DCAM reads the configured environments (the demo has its own chip). */
export function LiveChip() {
  return (
    <Chip
      size="small"
      color="success"
      variant="outlined"
      icon={<SensorsOutlined fontSize="small" />}
      label="Live"
      title="DCAM reads your configured environments, read-only"
    />
  );
}

/**
 * Badges next to the environment selector when that environment's collection fails (three or more
 * failed cycles in a row, FR-COLL-11) or runs at reduced fidelity (FR-COLL-06). Each opens the DCAM
 * health page, which says what happened and what to do.
 */
export function CollectionBadges({ env, href }: { env: CollectionEnvironment | undefined; href: string }) {
  if (!env) return null;
  return (
    <>
      {env.failing && (
        <Chip
          component="a"
          href={href}
          clickable
          size="small"
          color="error"
          icon={<ErrorOutlined fontSize="small" />}
          label="Collection failing"
        />
      )}
      {env.reduced_fidelity && (
        <Chip
          component="a"
          href={href}
          clickable
          size="small"
          color="warning"
          variant="outlined"
          icon={<WarningAmberOutlined fontSize="small" />}
          label="Reduced fidelity"
        />
      )}
    </>
  );
}
