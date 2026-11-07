/**
 * Client-side search over the bundled wiki pages. Every word of the query must appear in a page's
 * title, summary or body (case-insensitive); title matches rank first. The unified search across the
 * glossary, configuration knowledge base and rules (FR-WIKI-08) builds on this later.
 *
 * @implements FR-WIKI-08
 */
import { bodyText, type WikiPage } from './content';

export interface WikiSearchHit {
  readonly page: WikiPage;
  /** Body text around the first match, or the page summary when only the title or summary match. */
  readonly snippet: string;
  readonly score: number;
}

const WEIGHT = { title: 10, summary: 3, body: 1 } as const;
const SNIPPET_RADIUS = 80;

interface Indexed {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly bodyLower: string;
}

const index = new WeakMap<WikiPage, Indexed>();

function indexed(page: WikiPage): Indexed {
  let entry = index.get(page);
  if (!entry) {
    const body = bodyText(page);
    entry = {
      title: page.title.toLowerCase(),
      summary: page.summary.toLowerCase(),
      body,
      bodyLower: body.toLowerCase(),
    };
    index.set(page, entry);
  }
  return entry;
}

function snippetFor(entry: Indexed, words: readonly string[], fallback: string): string {
  const positions = words.map((w) => entry.bodyLower.indexOf(w)).filter((i) => i >= 0);
  if (positions.length === 0) return fallback;
  const at = Math.min(...positions);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(entry.body.length, at + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${entry.body.slice(start, end).trim()}${end < entry.body.length ? '…' : ''}`;
}

export function searchWiki(pages: readonly WikiPage[], query: string): WikiSearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: WikiSearchHit[] = [];
  for (const page of pages) {
    const entry = indexed(page);
    let score = 0;
    let everyWord = true;
    for (const word of words) {
      const inTitle = entry.title.includes(word);
      const inSummary = entry.summary.includes(word);
      const inBody = entry.bodyLower.includes(word);
      if (!inTitle && !inSummary && !inBody) {
        everyWord = false;
        break;
      }
      score += (inTitle ? WEIGHT.title : 0) + (inSummary ? WEIGHT.summary : 0) + (inBody ? WEIGHT.body : 0);
    }
    if (everyWord) hits.push({ page, score, snippet: snippetFor(entry, words, page.summary) });
  }
  return hits.sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title, 'en'));
}
