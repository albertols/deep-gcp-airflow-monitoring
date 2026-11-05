import type { ReactNode } from 'react';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { Range } from '@dcam/contracts';

export function RangeToggle({ value, onChange }: { value: Range; onChange: (range: Range) => void }) {
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={value}
      aria-label="Time range"
      onChange={(_e, next: Range | null) => next && onChange(next)}
    >
      <ToggleButton value="1h">1 h</ToggleButton>
      <ToggleButton value="6h">6 h</ToggleButton>
      <ToggleButton value="24h">24 h</ToggleButton>
    </ToggleButtonGroup>
  );
}

export function PageHeader({
  title,
  subtitle,
  range,
  onRangeChange,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  range?: Range;
  onRangeChange?: (range: Range) => void;
  children?: ReactNode;
}) {
  return (
    <Stack spacing={1}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}
      >
        <Typography variant="h1">{title}</Typography>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          {children}
          {range && onRangeChange && <RangeToggle value={range} onChange={onRangeChange} />}
        </Stack>
      </Stack>
      {subtitle && (
        <Typography variant="body2" color="text.secondary">
          {subtitle}
        </Typography>
      )}
    </Stack>
  );
}
