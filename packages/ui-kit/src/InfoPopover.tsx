/**
 * The (i) explanation pattern (spec §12.9): every panel, KPI and column explains itself, and can point
 * to the in-app wiki page that explains the concept in depth (spec §15).
 *
 * @implements FR-UI-05, FR-WIKI-06
 */
import { useId, useState } from 'react';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import InfoOutlined from '@mui/icons-material/InfoOutlined';

export interface Explanation {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly whyItMatters?: string;
  readonly formula?: string;
  readonly howToRead?: string;
  readonly sources: readonly string[];
  readonly freshness?: string;
  readonly caveats?: readonly string[];
  readonly docs?: ReadonlyArray<{ readonly title: string; readonly url: string }>;
  /** In-app wiki page, for example `#/wiki/executor-slot-seconds`; opens in the same tab. */
  readonly wiki?: { readonly href: string; readonly title?: string };
}

export function InfoPopover({ explanation }: { explanation: Explanation }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const headingId = useId();
  return (
    <>
      <IconButton
        size="small"
        aria-label={`About ${explanation.title}`}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        <InfoOutlined fontSize="inherit" />
      </IconButton>
      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { role: 'dialog', 'aria-labelledby': headingId, sx: { p: 4, maxWidth: 420 } } }}
      >
        <Stack spacing={2}>
          <Typography id={headingId} variant="h2" component="h2">
            {explanation.title}
          </Typography>
          <Typography variant="body2">{explanation.summary}</Typography>
          {explanation.whyItMatters && (
            <Typography variant="body2" color="text.secondary">
              {explanation.whyItMatters}
            </Typography>
          )}
          {explanation.formula && (
            <Typography variant="body2" sx={{ fontFamily: '"Roboto Mono", ui-monospace, monospace' }}>
              {explanation.formula}
            </Typography>
          )}
          {explanation.howToRead && <Typography variant="body2">{explanation.howToRead}</Typography>}
          {explanation.caveats?.map((c) => (
            <Typography key={c} variant="caption" color="text.secondary">
              {c}
            </Typography>
          ))}
          <Typography variant="caption" color="text.secondary">
            Source: {explanation.sources.join(', ')}
            {explanation.freshness ? ` · Freshness: ${explanation.freshness}` : ''}
          </Typography>
          {explanation.wiki && (
            <Link href={explanation.wiki.href} variant="body2" onClick={() => setAnchor(null)}>
              {explanation.wiki.title
                ? `Learn more in the wiki: ${explanation.wiki.title}`
                : 'Learn more in the wiki'}
            </Link>
          )}
          {explanation.docs?.map((d) => (
            <Link key={d.url} href={d.url} target="_blank" rel="noopener noreferrer" variant="body2">
              {d.title}
            </Link>
          ))}
        </Stack>
      </Popover>
    </>
  );
}
