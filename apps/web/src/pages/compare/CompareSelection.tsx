/**
 * The DAGs compared on S-14 (FR-DAGD-08): 2 to 4 items from any environment, each with its letter and line
 * style, a link to its DAG detail and a remove button; and a form that adds one more from any configured
 * environment. The DAG picker lists the environment's league and shows at most 50 matches, so it stays
 * responsive at 5,000 DAGs (NFR-PERF).
 *
 * @implements FR-DAGD-08, FR-UI-02, NFR-PERF
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Autocomplete, { createFilterOptions } from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import type { DcamApi } from '../../api';
import { Panel } from '../../components/Panel';
import type { SeriesStyle } from '../../components/series';
import { useRefresh, useView } from '../../components/view';
import { COMPARE_EXPLANATIONS as E } from '../dags/compare-explanations';
import { MAX_COMPARE, MIN_COMPARE, itemKey, sameItem, type CompareItem } from './selection';

const MONO = '"Roboto Mono", ui-monospace, monospace';
/** Matches the DAG picker shows: enough to pick from, few enough to render at once. */
const PICKER_MATCHES = 50;
const filterOptions = createFilterOptions<string>({ limit: PICKER_MATCHES });

export function CompareSelection({
  api,
  envId,
  items,
  styles,
  hrefOf,
  onAdd,
  onRemove,
}: {
  api: DcamApi;
  /** The context bar's environment: the picker's default. */
  envId: string;
  items: readonly CompareItem[];
  styles: readonly SeriesStyle[];
  hrefOf: (item: CompareItem) => string;
  onAdd: (item: CompareItem) => void;
  onRemove: (item: CompareItem) => void;
}) {
  const { range } = useView();
  const refresh = useRefresh();
  const [env, setEnv] = useState(envId);
  const [dag, setDag] = useState<string | null>(null);
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.getMeta(), ...refresh });
  const league = useQuery({
    queryKey: ['dag-league', env, range],
    queryFn: () => api.getDagLeague(env, range),
    ...refresh,
  });
  const environments = meta.data?.environments.map((e) => e.env_id) ?? [envId];
  const full = items.length >= MAX_COMPARE;
  const options = (league.data?.rows ?? [])
    .map((r) => r.dag_id)
    .filter((d) => !items.some((x) => sameItem(x, { envId: env, dagId: d })));
  const add = () => {
    if (dag === null) return;
    onAdd({ envId: env, dagId: dag });
    setDag(null);
  };

  return (
    <Panel explanation={E['cmp-selection']}>
      <Stack spacing={2}>
        {items.length > 0 && (
          <Stack component="ul" aria-label="DAGs compared" sx={{ m: 0, p: 0, gap: 1 }}>
            {items.map((item, i) => {
              const style = styles[i];
              return (
                <Stack
                  key={itemKey(item)}
                  component="li"
                  direction="row"
                  sx={{ alignItems: 'center', gap: 1, listStyle: 'none' }}
                >
                  {style && (
                    <svg width={28} height={12} aria-hidden="true">
                      <line
                        x1={1}
                        x2={27}
                        y1={6}
                        y2={6}
                        stroke={style.color}
                        strokeWidth={3}
                        strokeDasharray={style.dash}
                      />
                    </svg>
                  )}
                  <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 16 }}>
                    {style?.letter}
                  </Typography>
                  <Link href={hrefOf(item)} sx={{ fontFamily: MONO }}>
                    {item.dagId}
                  </Link>
                  <Typography variant="body2" color="text.secondary">
                    {item.envId}
                  </Typography>
                  <IconButton
                    size="small"
                    aria-label={`Remove ${itemKey(item)}`}
                    onClick={() => onRemove(item)}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Stack>
              );
            })}
          </Stack>
        )}
        <Stack direction="row" sx={{ gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            select
            size="small"
            label="Environment"
            value={environments.includes(env) ? env : (environments[0] ?? '')}
            onChange={(e) => {
              setEnv(e.target.value);
              setDag(null);
            }}
            disabled={full}
            sx={{ minWidth: 180 }}
          >
            {environments.map((e) => (
              <MenuItem key={e} value={e}>
                {e}
              </MenuItem>
            ))}
          </TextField>
          <Autocomplete
            size="small"
            options={options}
            filterOptions={filterOptions}
            value={dag}
            onChange={(_e, next) => setDag(next)}
            disabled={full}
            loading={league.isPending}
            noOptionsText={league.error ? "Couldn't load the DAGs of this environment" : 'No DAG matches'}
            sx={{ minWidth: 300 }}
            renderInput={(params) => <TextField {...params} label="DAG" />}
          />
          <Button variant="outlined" size="small" onClick={add} disabled={full || dag === null}>
            Add
          </Button>
        </Stack>
        <Box>
          <Typography variant="caption" color="text.secondary">
            {full
              ? `You can compare up to ${MAX_COMPARE} DAGs. Remove one to add another.`
              : items.length < MIN_COMPARE
                ? `Add at least ${items.length === 0 ? MIN_COMPARE : 'one more'} DAG${items.length === 0 ? 's' : ''} to compare: pick them here, or select rows in the DAG league table.`
                : `${items.length} of ${MAX_COMPARE} DAGs. Type to search the DAGs of an environment.`}
          </Typography>
        </Box>
      </Stack>
    </Panel>
  );
}
