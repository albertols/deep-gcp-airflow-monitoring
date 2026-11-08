/**
 * Renders wiki content blocks with MUI on the design tokens: semantic headings, lists, tables with
 * captions and header cells, definition lists, and callouts announced as notes (not alerts).
 *
 * @implements FR-WIKI-01, FR-WIKI-07
 */
import { Fragment } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { findWikiPage, type Block, type Rich } from './content';

/** Builds the link to a wiki page (keeps the selected environment). */
export type WikiHref = (slug: string) => string;

const MONO = '"Roboto Mono", ui-monospace, monospace';
const READING_WIDTH = '75ch';

export function RichText({ content, href }: { content: Rich; href: WikiHref }) {
  return (
    <>
      {content.map((item, i) => {
        if (typeof item === 'string') return <Fragment key={i}>{item}</Fragment>;
        switch (item.kind) {
          case 'code':
            return (
              <Box
                key={i}
                component="code"
                sx={{
                  fontFamily: MONO,
                  fontSize: '0.875em',
                  px: 1,
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                }}
              >
                {item.text}
              </Box>
            );
          case 'strong':
            return <strong key={i}>{item.text}</strong>;
          case 'wiki':
            return (
              <Link key={i} href={href(item.slug)}>
                {item.text}
              </Link>
            );
        }
      })}
    </>
  );
}

function TableBlock({ block, href }: { block: Extract<Block, { kind: 'table' }>; href: WikiHref }) {
  const numeric = new Set(block.numeric ?? []);
  return (
    <TableContainer>
      <Table size="small" sx={{ '& caption': { captionSide: 'top', px: 0, pt: 0, color: 'text.secondary' } }}>
        <caption>{block.caption}</caption>
        <TableHead>
          <TableRow>
            {block.columns.map((col, c) => (
              <TableCell key={col} align={numeric.has(c) ? 'right' : 'left'}>
                {col}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {block.rows.map((row, r) => (
            <TableRow key={r}>
              {row.map((cell, c) => (
                <TableCell
                  key={c}
                  align={numeric.has(c) ? 'right' : 'left'}
                  sx={{ verticalAlign: 'top' }}
                  {...(c === 0 ? { component: 'th' as const, scope: 'row' } : {})}
                >
                  <RichText content={cell} href={href} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function BlockView({ block, href }: { block: Block; href: WikiHref }) {
  switch (block.kind) {
    case 'heading':
      return block.level === 2 ? (
        <Typography variant="h2" component="h2" sx={{ pt: 2 }}>
          {block.text}
        </Typography>
      ) : (
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500 }}>
          {block.text}
        </Typography>
      );
    case 'paragraph':
      return (
        <Typography variant="body1" sx={{ maxWidth: READING_WIDTH }}>
          <RichText content={block.content} href={href} />
        </Typography>
      );
    case 'list':
      return (
        <Box
          component={block.ordered ? 'ol' : 'ul'}
          sx={{ m: 0, pl: 6, maxWidth: READING_WIDTH, '& > li + li': { mt: 1 } }}
        >
          {block.items.map((item, i) => (
            <Typography key={i} component="li" variant="body1">
              <RichText content={item} href={href} />
            </Typography>
          ))}
        </Box>
      );
    case 'code':
      return (
        <Box component="figure" sx={{ m: 0 }}>
          <Typography component="figcaption" variant="caption" color="text.secondary">
            {block.caption}
          </Typography>
          <Box
            component="pre"
            sx={{
              m: 0,
              mt: 1,
              p: 3,
              borderRadius: 1,
              bgcolor: 'action.hover',
              fontFamily: MONO,
              fontSize: '0.875rem',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            <code data-language={block.language}>{block.code}</code>
          </Box>
        </Box>
      );
    case 'callout':
      return (
        <Alert
          role="note"
          variant="outlined"
          severity={block.tone === 'verify' ? 'warning' : block.tone}
          sx={{ maxWidth: READING_WIDTH }}
        >
          <AlertTitle>{block.title}</AlertTitle>
          <RichText content={block.content} href={href} />
        </Alert>
      );
    case 'table':
      return <TableBlock block={block} href={href} />;
    case 'definitions':
      return (
        <Box component="dl" sx={{ m: 0, maxWidth: READING_WIDTH }}>
          {block.items.map((t) => {
            const see = t.see ? findWikiPage(t.see) : undefined;
            return (
              <Fragment key={t.term}>
                <Typography component="dt" variant="body1" sx={{ fontWeight: 500, mt: 4 }}>
                  {t.term}
                </Typography>
                <Typography component="dd" variant="body1" sx={{ ml: 0 }}>
                  <RichText content={t.definition} href={href} />
                  {see && (
                    <>
                      {' See '}
                      <Link href={href(see.slug)}>{see.title}</Link>.
                    </>
                  )}
                </Typography>
              </Fragment>
            );
          })}
        </Box>
      );
  }
}
