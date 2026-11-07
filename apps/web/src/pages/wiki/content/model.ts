/**
 * The wiki's content model (spec §15.1, §15.6): typed pages made of a small set of blocks, so the
 * build can check metadata and links (FR-WIKI-06) without an MDX toolchain. Page text is plain data;
 * the renderer decides how it looks.
 *
 * @implements FR-WIKI-01, FR-WIKI-05
 */
import type { WikiSlug } from './slugs';

/** Inline content of a paragraph, list item, callout or table cell. */
export type Inline =
  | string
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'wiki'; readonly slug: WikiSlug; readonly text: string };

export type Rich = readonly Inline[];

export type CalloutTone = 'info' | 'warning' | 'verify';

export type Block =
  | { readonly kind: 'heading'; readonly text: string; readonly level: 2 | 3 }
  | { readonly kind: 'paragraph'; readonly content: Rich }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly Rich[] }
  | { readonly kind: 'code'; readonly language: string; readonly code: string; readonly caption: string }
  | { readonly kind: 'callout'; readonly tone: CalloutTone; readonly title: string; readonly content: Rich }
  | {
      readonly kind: 'table';
      readonly caption: string;
      readonly columns: readonly string[];
      readonly rows: ReadonlyArray<readonly Rich[]>;
      /** Column indexes that hold numbers: right-aligned, tabular figures (spec §12.7). */
      readonly numeric?: readonly number[];
    }
  | { readonly kind: 'definitions'; readonly items: readonly GlossaryTerm[] };

export const WIKI_SECTIONS = [
  'Start here',
  'Concepts',
  'How DCAM computes things',
  'Best practices',
  'Alerts',
  'Runbooks',
  'Glossary',
] as const;

export type WikiSection = (typeof WIKI_SECTIONS)[number];

export type ComposerGeneration = '2' | '3';

export interface Source {
  readonly title: string;
  readonly url: string;
}

export interface GlossaryTerm {
  readonly term: string;
  readonly definition: Rich;
  /** The wiki page that explains the term in depth. */
  readonly see?: WikiSlug;
}

export interface RunbookMeta {
  readonly id: string;
  readonly relatedRules: readonly string[];
}

export interface WikiPage {
  readonly slug: WikiSlug;
  readonly title: string;
  readonly section: WikiSection;
  /** One sentence for the index and search results. */
  readonly summary: string;
  readonly appliesTo: { readonly composer: readonly ComposerGeneration[]; readonly airflow: string };
  /** ISO date (YYYY-MM-DD) on which the content was last checked against its sources. */
  readonly lastVerified: string;
  /** Official documentation the page is based on. */
  readonly sources: readonly Source[];
  /** Signal IDs (`HM-…`) the page explains. */
  readonly signals?: readonly string[];
  readonly runbook?: RunbookMeta;
  readonly related?: readonly WikiSlug[];
  readonly body: readonly Block[];
}

// ---- Authoring helpers: short names keep the content readable. ----

type RichInput = Inline | Rich;
const isRich = (input: RichInput): input is Rich => Array.isArray(input);
const rich = (input: RichInput): Rich => (isRich(input) ? input : [input]);

export const code = (text: string): Inline => ({ kind: 'code', text });
export const strong = (text: string): Inline => ({ kind: 'strong', text });
export const link = (slug: WikiSlug, text: string): Inline => ({ kind: 'wiki', slug, text });

export const h2 = (text: string): Block => ({ kind: 'heading', text, level: 2 });
export const h3 = (text: string): Block => ({ kind: 'heading', text, level: 3 });
export const p = (...content: Inline[]): Block => ({ kind: 'paragraph', content });
export const ul = (...items: RichInput[]): Block => ({
  kind: 'list',
  ordered: false,
  items: items.map(rich),
});
export const ol = (...items: RichInput[]): Block => ({ kind: 'list', ordered: true, items: items.map(rich) });
export const codeBlock = (language: string, caption: string, source: string): Block => ({
  kind: 'code',
  language,
  caption,
  code: source,
});
export const callout = (tone: CalloutTone, title: string, ...content: Inline[]): Block => ({
  kind: 'callout',
  tone,
  title,
  content,
});
export const table = (
  caption: string,
  columns: readonly string[],
  rows: ReadonlyArray<readonly RichInput[]>,
  numeric?: readonly number[],
): Block => ({
  kind: 'table',
  caption,
  columns,
  rows: rows.map((row) => row.map(rich)),
  ...(numeric ? { numeric } : {}),
});
export const definitions = (items: readonly GlossaryTerm[]): Block => ({ kind: 'definitions', items });

/** Runbook body in the fixed order of spec §15.4 (FR-WIKI-05). */
export function runbookBody(r: {
  readonly symptoms: readonly RichInput[];
  readonly checks: ReadonlyArray<{ readonly question: string; readonly signal: string; readonly how: Rich }>;
  readonly causes: readonly RichInput[];
  readonly fixes: readonly Block[];
  readonly links: readonly RichInput[];
}): Block[] {
  return [
    h2('Symptoms'),
    ul(...r.symptoms),
    h2('Checks'),
    ol(...r.checks.map((c): Rich => [strong(c.question), ` (${c.signal}). `, ...c.how])),
    h2('Likely causes'),
    ul(...r.causes),
    h2('Fixes'),
    ...r.fixes,
    h2('Links'),
    ul(...r.links),
  ];
}

// ---- Reading helpers for search, tests and the renderer. ----

export const richText = (content: Rich): string =>
  content.map((i) => (typeof i === 'string' ? i : i.text)).join('');

function blockText(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return block.text;
    case 'paragraph':
    case 'callout':
      return `${block.kind === 'callout' ? `${block.title} ` : ''}${richText(block.content)}`;
    case 'list':
      return block.items.map(richText).join(' ');
    case 'code':
      return `${block.caption} ${block.code}`;
    case 'table':
      return [block.caption, ...block.columns, ...block.rows.flatMap((r) => r.map(richText))].join(' ');
    case 'definitions':
      return block.items.map((t) => `${t.term} ${richText(t.definition)}`).join(' ');
  }
}

/** The page body as plain text (search and checks). */
export const bodyText = (page: WikiPage): string => page.body.map(blockText).join(' ');

/** Title, summary and body as plain text. */
export const pageText = (page: WikiPage): string => `${page.title} ${page.summary} ${bodyText(page)}`;

function richLinks(content: Rich): WikiSlug[] {
  return content.flatMap((i) => (typeof i !== 'string' && i.kind === 'wiki' ? [i.slug] : []));
}

/** Every wiki page a page links to, from its body and its related pages (FR-WIKI-06). */
export function internalLinks(page: WikiPage): WikiSlug[] {
  const fromBlocks = page.body.flatMap((block): WikiSlug[] => {
    switch (block.kind) {
      case 'paragraph':
      case 'callout':
        return richLinks(block.content);
      case 'list':
        return block.items.flatMap(richLinks);
      case 'table':
        return block.rows.flatMap((r) => r.flatMap(richLinks));
      case 'definitions':
        return block.items.flatMap((t) => [...richLinks(t.definition), ...(t.see ? [t.see] : [])]);
      default:
        return [];
    }
  });
  return [...fromBlocks, ...(page.related ?? [])];
}
