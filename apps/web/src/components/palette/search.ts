/**
 * Ranked search for the command palette (FR-UI-03). Matches are ranked exact, then prefix, then word
 * prefix (the query starts a word: after `_`, `-`, `.`, a space or any other character that is not a
 * letter or digit), then substring; ties sort alphabetically. Case and surrounding spaces are ignored.
 *
 * The index is sorted once, alphabetically, when it is built; a search is then one pass that drops each
 * match into its tier's bucket, so the buckets are already in order and nothing is sorted per keystroke.
 * At 5,000 DAGs a three-character query takes a few milliseconds (NFR-PERF; the budget is 100 ms).
 *
 * @implements FR-UI-03, NFR-PERF
 */
import type { Route } from '../../router';

export type PaletteTargetKind = 'environment' | 'page' | 'dag' | 'wiki' | 'advisor-rule' | 'alert-rule';

/** What choosing a target does: open a route, or switch the environment and stay on the page. */
export type PaletteAction =
  | { readonly kind: 'route'; readonly route: Route }
  | { readonly kind: 'environment'; readonly envId: string };

export interface PaletteTarget {
  /** Unique across targets, for example `dag:acme_orders`. */
  readonly key: string;
  readonly kind: PaletteTargetKind;
  /** The text that is searched and shown. */
  readonly label: string;
  /** Secondary text shown under the label; not searched. */
  readonly detail?: string;
  readonly action: PaletteAction;
}

export type MatchTier = 'exact' | 'prefix' | 'word-prefix' | 'substring';

export interface PaletteMatch {
  readonly target: PaletteTarget;
  readonly tier: MatchTier;
}

export interface PaletteResult {
  /** Best first, at most the limit. */
  readonly matches: readonly PaletteMatch[];
  /** Every target that matches. */
  readonly total: number;
}

interface Entry {
  readonly target: PaletteTarget;
  /** The label in lower case. */
  readonly text: string;
}

/** Targets in alphabetical order, ready to search. */
export interface PaletteIndex {
  readonly entries: readonly Entry[];
}

/** Matches shown at most. */
export const PALETTE_LIMIT = 50;

const TIERS: readonly MatchTier[] = ['exact', 'prefix', 'word-prefix', 'substring'];

/** For equal labels: environments, then pages, DAGs, wiki pages and rules. */
const KIND_RANK: Readonly<Record<PaletteTargetKind, number>> = {
  environment: 0,
  page: 1,
  dag: 2,
  wiki: 3,
  'advisor-rule': 4,
  'alert-rule': 5,
};

/** Code point order: the same in every locale, and fast. */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const alphabetical = (a: Entry, b: Entry) =>
  byCodePoint(a.text, b.text) ||
  KIND_RANK[a.target.kind] - KIND_RANK[b.target.kind] ||
  byCodePoint(a.target.label, b.target.label) ||
  byCodePoint(a.target.key, b.target.key);

export function buildPaletteIndex(targets: readonly PaletteTarget[]): PaletteIndex {
  const entries = targets.map((target) => ({ target, text: target.label.toLowerCase() }));
  return { entries: entries.sort(alphabetical) };
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Letters and digits make words; anything else separates them. */
function isWordChar(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  if (code < 128)
    return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
  return LETTER_OR_DIGIT.test(text.charAt(at));
}

/** The tier's index in {@link TIERS}, or -1 when the text does not contain the query. */
function tierOf(text: string, query: string): number {
  let at = text.indexOf(query);
  if (at === -1) return -1;
  if (at === 0) return text.length === query.length ? 0 : 1;
  while (at !== -1) {
    if (!isWordChar(text, at - 1)) return 2;
    at = text.indexOf(query, at + 1);
  }
  return 3;
}

/** The best matches for a query, at most `limit`, and how many targets match in all. */
export function searchPalette(index: PaletteIndex, query: string, limit = PALETTE_LIMIT): PaletteResult {
  const q = query.trim().toLowerCase();
  if (q === '') return { matches: [], total: 0 };
  const buckets: PaletteMatch[][] = TIERS.map(() => []);
  let total = 0;
  for (const entry of index.entries) {
    const tier = tierOf(entry.text, q);
    if (tier === -1) continue;
    total += 1;
    const bucket = buckets[tier];
    if (bucket && bucket.length < limit)
      bucket.push({ target: entry.target, tier: TIERS[tier] ?? 'substring' });
  }
  return { matches: buckets.flat().slice(0, limit), total };
}
