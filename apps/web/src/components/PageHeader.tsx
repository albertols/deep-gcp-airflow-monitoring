/**
 * Page title, subtitle and actions. The time range lives in the context bar (FR-UI-01), so every panel
 * on a page follows the same range; pages state the range in their subtitle.
 *
 * @implements FR-UI-01
 */
import type { ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { Range } from '@dcam/contracts';
import { formatShare } from './format';
import { RANGE_PRESETS } from './range';

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Stack spacing={1}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}
      >
        <Typography variant="h1">{title}</Typography>
        {children && (
          <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            {children}
          </Stack>
        )}
      </Stack>
      {subtitle && (
        <Typography variant="body2" color="text.secondary">
          {subtitle}
        </Typography>
      )}
    </Stack>
  );
}

/**
 * Says when DCAM has collected less history than the range (§8.1: totals are never presented as the
 * whole range when part of it has no data). `coverage` is the share of the range with collected history.
 */
export function CoverageNote({ coverage, range }: { coverage: number | undefined; range: Range }) {
  if (coverage === undefined || coverage >= 0.995) return null;
  const span = RANGE_PRESETS[range].span;
  return (
    <Alert severity="info" variant="outlined">
      {coverage === 0
        ? `DCAM has no task history in the last ${span} yet. Data appears after the first collection.`
        : `DCAM has task history for ${formatShare(coverage)} of the last ${span}, so totals cover less than the range. Pick a shorter range, or keep DCAM running to fill it.`}
    </Alert>
  );
}
