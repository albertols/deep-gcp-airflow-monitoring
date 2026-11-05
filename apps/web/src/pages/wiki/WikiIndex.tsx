/**
 * The wiki index: every page grouped by section (spec §15.1), with a client-side search over titles
 * and text. Results are announced through a status region.
 *
 * @implements FR-WIKI-01, FR-WIKI-08
 */
import { useId, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { PageHeader } from '../../components/PageHeader';
import type { WikiHref } from './Blocks';
import { WIKI_PAGES, WIKI_SECTIONS, type WikiPage, type WikiSection } from './content';
import { searchWiki } from './search';

function statusText(query: string, count: number): string {
  if (!query) return '';
  if (count === 0)
    return `No pages match "${query}". Try a shorter or different word, or clear the search to browse by section.`;
  return `${count} ${count === 1 ? 'page matches' : 'pages match'} "${query}"`;
}

function PageLink({ page, href, detail }: { page: WikiPage; href: WikiHref; detail: string }) {
  return (
    <Box component="li" sx={{ listStyle: 'none' }}>
      <Link href={href(page.slug)} variant="body1">
        {page.title}
      </Link>
      <Typography variant="body2" color="text.secondary">
        {detail}
      </Typography>
    </Box>
  );
}

function Section({ section, href }: { section: WikiSection; href: WikiHref }) {
  const id = useId();
  const pages = WIKI_PAGES.filter((p) => p.section === section);
  return (
    <Paper component="section" aria-labelledby={id} sx={{ p: 4, minWidth: 0 }}>
      <Typography id={id} variant="h2" component="h2" sx={{ mb: 2 }}>
        {section}
      </Typography>
      <Stack component="ul" spacing={2} sx={{ m: 0, p: 0 }}>
        {pages.map((page) => (
          <PageLink key={page.slug} page={page} href={href} detail={page.summary} />
        ))}
      </Stack>
    </Paper>
  );
}

export function WikiIndex({ href }: { href: WikiHref }) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const hits = useMemo(() => searchWiki(WIKI_PAGES, trimmed), [trimmed]);
  const resultsId = useId();

  return (
    <Stack spacing={6}>
      <PageHeader
        title="Wiki"
        subtitle="How Composer and Airflow schedule work, and how DCAM computes every number it shows. New here? Open Start here."
      />
      <Box component="form" role="search" aria-label="Wiki" onSubmit={(e) => e.preventDefault()}>
        <TextField
          type="search"
          label="Search the wiki"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          size="small"
          fullWidth
          sx={{ maxWidth: 480 }}
        />
        <Typography role="status" variant="body2" color="text.secondary" sx={{ mt: 2, minHeight: '1.5em' }}>
          {statusText(trimmed, hits.length)}
        </Typography>
      </Box>

      {trimmed ? (
        hits.length > 0 && (
          <Box component="section" aria-labelledby={resultsId}>
            <Typography id={resultsId} variant="h2" component="h2" sx={{ mb: 2 }}>
              Search results
            </Typography>
            <Stack component="ul" spacing={3} sx={{ m: 0, p: 0 }}>
              {hits.map((hit) => (
                <PageLink
                  key={hit.page.slug}
                  page={hit.page}
                  href={href}
                  detail={`${hit.page.section} · ${hit.snippet}`}
                />
              ))}
            </Stack>
          </Box>
        )
      ) : (
        <Box
          sx={{
            display: 'grid',
            gap: 4,
            gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
          }}
        >
          {WIKI_SECTIONS.map((section) => (
            <Section key={section} section={section} href={href} />
          ))}
        </Box>
      )}
    </Stack>
  );
}
