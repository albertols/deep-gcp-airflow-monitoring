/**
 * The "view as table" alternative every chart offers (spec §12.8, NFR-A11Y-01), kept in the URL under the
 * panel's own parameter so a shared link opens the same view (FR-UI-02).
 *
 * @implements NFR-A11Y-01, FR-UI-02
 */
import type { ReactNode } from 'react';
import Button from '@mui/material/Button';
import { usePageParam } from './view';

/** Whether the panel shows its table, and the button that switches. */
export function useTableView(param: string): [boolean, ReactNode] {
  const [view, setView] = usePageParam(param, 'chart');
  const asTable = view === 'table';
  const button = (
    <Button size="small" variant="outlined" onClick={() => setView(asTable ? 'chart' : 'table')}>
      {asTable ? 'View as chart' : 'View as table'}
    </Button>
  );
  return [asTable, button];
}
