/**
 * The command palette (FR-UI-03): a dialog that jumps to pages, environments, the selected environment's
 * DAGs, wiki pages, advisor rules and alert rules. It follows the ARIA combobox pattern: the text field
 * owns a listbox of options, arrow keys move the active option (announced through
 * `aria-activedescendant`), Enter opens it, Esc closes the dialog and focus returns to where it was; a
 * live region says how many targets match. The dialog traps focus while it is open.
 *
 * The DAG list is read once per open (`GET …/dag-index`, not polled); the search itself runs on every
 * keystroke over an index built once (see `search.ts`). This module is its own chunk, loaded on first use.
 *
 * @implements FR-UI-03, NFR-A11Y-01, NFR-PERF
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { DagIndex, Meta } from '@dcam/contracts';
import type { DcamApi } from '../../api';
import { formatInt } from '../format';
import {
  PALETTE_LIMIT,
  buildPaletteIndex,
  searchPalette,
  type PaletteAction,
  type PaletteTarget,
  type PaletteTargetKind,
} from './search';
import { dagTargets, environmentTargets, staticTargets } from './targets';

const KIND_LABEL: Readonly<Record<PaletteTargetKind, string>> = {
  environment: 'Environment',
  page: 'Page',
  dag: 'DAG',
  wiki: 'Wiki',
  'advisor-rule': 'Advisor rule',
  'alert-rule': 'Alert rule',
};
const MONO = { fontFamily: '"Roboto Mono", ui-monospace, monospace' } as const;
const NO_DAGS: DagIndex['dags'] = [];
/** The DAG list changes with the inventory, every few minutes at most. */
const DAG_INDEX_STALE_MS = 60_000;

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly api: DcamApi;
  /** The selected environment, whose DAGs are listed; `null` before the workspace loads. */
  readonly envId: string | null;
  readonly environments: Meta['environments'];
  readonly onChoose: (action: PaletteAction) => void;
}

export function CommandPalette({ open, onClose, ...body }: CommandPaletteProps) {
  const titleId = useId();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { alignSelf: 'flex-start', mt: '10vh' } } }}
    >
      <DialogContent sx={{ p: 3 }}>
        <Typography id={titleId} variant="body2" color="text.secondary" component="h2" sx={{ mb: 2 }}>
          Jump to
        </Typography>
        {/* Rendered only while open, so every open starts with an empty query. */}
        <PaletteBody {...body} />
      </DialogContent>
    </Dialog>
  );
}

function statusText(browsing: boolean, total: number, dags: { loading: boolean; failed: boolean }): string {
  const parts = [
    browsing
      ? 'Pages and environments. Type to search DAGs, wiki pages and rules too.'
      : total === 0
        ? 'No matches. Try part of a DAG ID, a page title or a rule ID such as REC-CAP-01.'
        : total <= PALETTE_LIMIT
          ? `${formatInt(total)} ${total === 1 ? 'match' : 'matches'}`
          : `The best ${PALETTE_LIMIT} of ${formatInt(total)} matches. Type more to narrow them.`,
  ];
  if (dags.loading) parts.push('Loading DAGs…');
  if (dags.failed) parts.push("Couldn't load the DAG list; the other targets still work.");
  return parts.join(' ');
}

function PaletteBody({ api, envId, environments, onChoose }: Omit<CommandPaletteProps, 'open' | 'onClose'>) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-option-${i}`;
  const canListDags = envId !== null && api.getDagIndex !== undefined;
  const dagIndex = useQuery({
    queryKey: ['dag-index', envId],
    queryFn: async () =>
      envId !== null && api.getDagIndex ? api.getDagIndex(envId) : { env_id: '', dags: NO_DAGS },
    enabled: canListDags,
    staleTime: DAG_INDEX_STALE_MS,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const dags = dagIndex.data?.env_id === envId ? dagIndex.data.dags : NO_DAGS;
  const fixed = useMemo(() => [...staticTargets(), ...environmentTargets(environments)], [environments]);
  const index = useMemo(() => buildPaletteIndex([...fixed, ...dagTargets(dags)]), [fixed, dags]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const result = useMemo(() => searchPalette(index, query), [index, query]);
  const browsing = query.trim() === '';
  const shown: readonly PaletteTarget[] = browsing
    ? fixed.filter((t) => t.kind === 'page' || t.kind === 'environment')
    : result.matches.map((m) => m.target);
  const activeIndex = Math.min(active, shown.length - 1);
  const current = activeIndex >= 0 ? shown[activeIndex] : undefined;
  const activeId = current ? optionId(activeIndex) : undefined;

  // The dialog opens on its search field (ARIA dialog pattern); the focus trap keeps focus inside.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  // Keep the active option in view while the arrow keys move it.
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const onKeyDown = (e: KeyboardEvent) => {
    const n = shown.length;
    if (e.key === 'ArrowDown' && n > 0) {
      e.preventDefault();
      setActive((activeIndex + 1) % n);
    } else if (e.key === 'ArrowUp' && n > 0) {
      e.preventDefault();
      setActive((activeIndex - 1 + n) % n);
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      onChoose(current.action);
    }
  };

  return (
    <Stack spacing={2}>
      <TextField
        inputRef={inputRef}
        fullWidth
        size="small"
        placeholder="A page, environment, DAG, wiki page or rule"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        slotProps={{
          htmlInput: {
            role: 'combobox',
            'aria-label': 'Jump to',
            'aria-autocomplete': 'list',
            'aria-expanded': shown.length > 0,
            'aria-controls': shown.length > 0 ? listboxId : undefined,
            'aria-activedescendant': activeId,
            autoComplete: 'off',
            spellCheck: false,
          },
        }}
      />
      <Typography variant="caption" color="text.secondary" role="status">
        {statusText(browsing, result.total, {
          loading: canListDags && dagIndex.isPending,
          failed: dagIndex.isError,
        })}
      </Typography>
      {shown.length > 0 && (
        <Box
          component="ul"
          role="listbox"
          id={listboxId}
          aria-label="Matches"
          sx={{ listStyle: 'none', m: 0, p: 0, maxHeight: 360, overflow: 'auto' }}
        >
          {shown.map((t, i) => (
            <Box
              component="li"
              role="option"
              key={t.key}
              id={optionId(i)}
              aria-selected={i === activeIndex}
              onClick={() => onChoose(t.action)}
              onMouseMove={() => i !== activeIndex && setActive(i)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                px: 2,
                py: 1,
                borderRadius: 1,
                cursor: 'pointer',
                bgcolor: i === activeIndex ? 'action.selected' : 'transparent',
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap sx={t.kind === 'dag' ? MONO : undefined}>
                  {t.label}
                </Typography>
                {t.detail && (
                  <Typography variant="caption" color="text.secondary" component="p" noWrap>
                    {t.detail}
                  </Typography>
                )}
              </Box>
              <Chip size="small" variant="outlined" label={KIND_LABEL[t.kind]} />
            </Box>
          ))}
        </Box>
      )}
      <Typography variant="caption" color="text.secondary" aria-hidden>
        ↑ ↓ to move · Enter to open · Esc to close
      </Typography>
    </Stack>
  );
}
