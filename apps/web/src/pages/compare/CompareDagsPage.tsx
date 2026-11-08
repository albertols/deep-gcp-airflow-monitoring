/**
 * S-14 Compare DAGs (FR-DAGD-08): 2 to 4 DAGs from the same or different environments, listed in the URL.
 *
 * @implements FR-DAGD-08, FR-UI-02
 */
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { PageHeader } from '../../components/PageHeader';
import { usePageParam } from '../../components/view';
import type { PageProps } from '../types';
import { MIN_COMPARE, itemKey, parseSelection } from './selection';

export function CompareDagsPage(_props: PageProps) {
  const [param] = usePageParam('dags');
  const items = parseSelection(param);
  return (
    <Stack spacing={4}>
      <PageHeader title="Compare DAGs" subtitle="2 to 4 DAGs from any environment, side by side." />
      {items.length < MIN_COMPARE && (
        <Typography variant="body2" color="text.secondary">
          Pick at least {MIN_COMPARE} DAGs to compare.
        </Typography>
      )}
      <Stack component="ul" sx={{ m: 0, pl: 2.5 }}>
        {items.map((item) => (
          <li key={itemKey(item)}>{itemKey(item)}</li>
        ))}
      </Stack>
    </Stack>
  );
}
