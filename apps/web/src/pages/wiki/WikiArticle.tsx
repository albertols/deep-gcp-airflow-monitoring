/**
 * One wiki page: breadcrumb, title, what it applies to and when it was last verified, the body,
 * related pages and the official sources it is based on (spec §15.6).
 *
 * @implements FR-WIKI-01, FR-WIKI-06
 */
import { useId, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import OpenInNew from '@mui/icons-material/OpenInNew';
import { BlockView, type WikiHref } from './Blocks';
import { findWikiPage, type ComposerGeneration, type WikiPage } from './content';

const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: '1px', // in MUI sx a bare 1 means 100 %
  height: '1px',
  margin: '-1px',
  padding: 0,
  border: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

export function composerLabel(composer: readonly ComposerGeneration[]): string {
  if (composer.includes('2') && composer.includes('3')) return 'Composer 2 and 3';
  return `Composer ${composer.join(', ')} only`;
}

/** `2026-11-05` → `5 November 2026`, independent of the viewer's time zone. */
export function formatVerified(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function LinkSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Box component="section" aria-labelledby={id}>
      <Typography id={id} variant="h2" component="h2" sx={{ pt: 2, mb: 2 }}>
        {title}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 6, '& > li + li': { mt: 1 } }}>
        {children}
      </Box>
    </Box>
  );
}

export function WikiArticle({
  page,
  href,
  indexHref,
}: {
  page: WikiPage;
  href: WikiHref;
  indexHref: string;
}) {
  const titleId = useId();
  const related = (page.related ?? []).flatMap((slug) => {
    const target = findWikiPage(slug);
    return target ? [target] : [];
  });
  return (
    <Stack component="article" aria-labelledby={titleId} spacing={4} sx={{ maxWidth: 1040 }}>
      <Breadcrumbs aria-label="Breadcrumb">
        <Link href={indexHref}>Wiki</Link>
        <Typography color="text.secondary">{page.section}</Typography>
      </Breadcrumbs>

      <Stack spacing={1}>
        <Typography id={titleId} variant="h1">
          {page.title}
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ maxWidth: '75ch' }}>
          {page.summary}
        </Typography>
      </Stack>

      <Box
        component="dl"
        sx={{ m: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 3, rowGap: 1 }}
      >
        <Typography component="dt" variant="body2" color="text.secondary">
          Applies to
        </Typography>
        <Typography component="dd" variant="body2" sx={{ m: 0 }}>
          <span>{composerLabel(page.appliesTo.composer)}</span>
          {' · '}
          <span>Airflow {page.appliesTo.airflow}</span>
        </Typography>
        <Typography component="dt" variant="body2" color="text.secondary">
          Last verified
        </Typography>
        <Typography component="dd" variant="body2" sx={{ m: 0 }}>
          <time dateTime={page.lastVerified}>{formatVerified(page.lastVerified)}</time>
        </Typography>
      </Box>

      {page.body.map((block, i) => (
        <BlockView key={i} block={block} href={href} />
      ))}

      {related.length > 0 && (
        <LinkSection title="Related pages">
          {related.map((target) => (
            <Typography key={target.slug} component="li" variant="body1">
              <Link href={href(target.slug)}>{target.title}</Link>
            </Typography>
          ))}
        </LinkSection>
      )}

      <LinkSection title="Sources">
        {page.sources.map((source) => (
          <Typography key={source.url} component="li" variant="body1">
            <Link href={source.url} target="_blank" rel="noopener noreferrer">
              {source.title}
              <OpenInNew fontSize="inherit" aria-hidden sx={{ ml: 1, verticalAlign: 'middle' }} />
              <Box component="span" sx={VISUALLY_HIDDEN}>
                (opens in a new tab)
              </Box>
            </Link>
          </Typography>
        ))}
      </LinkSection>
    </Stack>
  );
}
