/**
 * The in-app wiki (spec §15, S-29): the index at `#/wiki`, a page at `#/wiki/<slug>`, and a clear
 * "page not found" state with a way back. Content is bundled with the UI; there is no API call.
 *
 * @implements FR-WIKI-01, FR-WIKI-05, FR-WIKI-06, FR-WIKI-07, FR-UI-07
 */
import { useCallback, useId } from 'react';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { PageProps } from '../types';
import type { WikiHref } from './Blocks';
import { WIKI_SLUGS, findWikiPage } from './content';
import { WikiArticle } from './WikiArticle';
import { WikiIndex } from './WikiIndex';

function WikiNotFound({ slug, href, indexHref }: { slug: string; href: WikiHref; indexHref: string }) {
  const titleId = useId();
  return (
    <Stack component="section" aria-labelledby={titleId} spacing={3} sx={{ maxWidth: '75ch' }}>
      <Typography id={titleId} variant="h1">
        Page not found
      </Typography>
      <Typography variant="body1">
        There is no wiki page called "{slug}". The link may be out of date, or the page may have been renamed.
      </Typography>
      <Typography variant="body1">
        <Link href={indexHref}>Go to the wiki index</Link> to browse or search every page, or{' '}
        <Link href={href(WIKI_SLUGS.startHere)}>open Start here</Link>.
      </Typography>
    </Stack>
  );
}

export function WikiPage({ route, linkTo }: PageProps) {
  const slug = route.page === 'wiki' ? route.slug : undefined;
  const href = useCallback<WikiHref>((target) => linkTo({ page: 'wiki', slug: target }), [linkTo]);
  const indexHref = linkTo({ page: 'wiki' });

  if (slug === undefined) return <WikiIndex href={href} />;
  const page = findWikiPage(slug);
  if (!page) return <WikiNotFound slug={slug} href={href} indexHref={indexHref} />;
  return <WikiArticle page={page} href={href} indexHref={indexHref} />;
}
