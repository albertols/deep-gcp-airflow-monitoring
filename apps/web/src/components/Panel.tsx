/**
 * Panels and KPIs with the (i) explanation pattern (FR-UI-05) and a provenance footer (FR-UI-08).
 */
import type { ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { SourceId } from '@dcam/contracts';
import { InfoPopover, type Explanation } from '@dcam/ui-kit';

export function PanelTitle({
  explanation,
  component = 'h2',
}: {
  explanation: Explanation;
  component?: 'h2' | 'h3';
}) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <Typography variant="body2" color="text.secondary" component={component}>
        {explanation.title}
      </Typography>
      <InfoPopover explanation={explanation} />
    </Stack>
  );
}

export function Panel({
  explanation,
  actions,
  children,
}: {
  explanation: Explanation;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Paper component="section" aria-label={explanation.title} sx={{ p: 4, minWidth: 0 }}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', mb: 2 }}
      >
        <PanelTitle explanation={explanation} />
        {actions}
      </Stack>
      {children}
    </Paper>
  );
}

export function Kpi({
  explanation,
  value,
  unit,
  hint,
}: {
  explanation: Explanation;
  value: string;
  unit?: string;
  hint?: string;
}) {
  return (
    <Paper sx={{ p: 4, flex: '1 1 200px', minWidth: 0 }}>
      <PanelTitle explanation={explanation} />
      <Typography sx={{ fontSize: '2rem', fontVariantNumeric: 'tabular-nums', mt: 1 }}>
        {value}
        {unit && (
          <Typography component="span" variant="body1" color="text.secondary" sx={{ ml: 1 }}>
            {unit}
          </Typography>
        )}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      )}
    </Paper>
  );
}

export function KpiRow({ children }: { children: ReactNode }) {
  return (
    <Stack direction="row" sx={{ gap: 4, flexWrap: 'wrap' }}>
      {children}
    </Stack>
  );
}

/** Loading and error states for a query (FR-UI-07). */
export function QueryState({
  isPending,
  error,
  what,
  height = 160,
}: {
  isPending: boolean;
  error: Error | null;
  what: string;
  height?: number;
}) {
  if (error)
    return (
      <Alert severity="error">
        Couldn't load {what}: {error.message}. Check that DCAM is still running, then reload the page.
      </Alert>
    );
  if (isPending) return <Skeleton variant="rounded" height={height} aria-label={`Loading ${what}`} />;
  return null;
}

const SOURCE_NAMES: Record<SourceId, string> = {
  'SRC-AF-API': 'Airflow REST API',
  'SRC-MON': 'Cloud Monitoring',
  'SRC-COMPOSER': 'Cloud Composer API',
  DEMO: 'demo data',
};

/** Data source and freshness for a page or panel (FR-UI-08). */
export function ProvenanceFooter({
  dataAsOf,
  sources,
  note,
}: {
  dataAsOf: string;
  sources: readonly SourceId[];
  note?: string;
}) {
  return (
    <Typography variant="caption" color="text.secondary" component="footer">
      Data as of {new Date(dataAsOf).toUTCString()} · Source: {sources.map((s) => SOURCE_NAMES[s]).join(', ')}
      {note ? ` · ${note}` : ''}
    </Typography>
  );
}
