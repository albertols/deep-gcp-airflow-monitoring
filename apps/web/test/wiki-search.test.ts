import { describe, expect, it } from 'vitest';
import { WIKI_PAGES, findWikiPage } from '../src/pages/wiki/content';
import { searchWiki } from '../src/pages/wiki/search';

const slugsFor = (query: string) => searchWiki(WIKI_PAGES, query).map((hit) => hit.page.slug);

describe('wiki search (bundled pages)', () => {
  it('FR-WIKI-08: finds a page by a word that appears only in its body, with a snippet around it', () => {
    const health = findWikiPage('health-score');
    expect(`${health?.title} ${health?.summary}`).not.toContain('airflow_monitoring');
    const hits = searchWiki(WIKI_PAGES, 'airflow_monitoring');
    expect(hits.map((h) => h.page.slug)).toEqual(['health-score']);
    expect(hits[0]?.snippet).toMatch(/airflow_monitoring/);
    expect(hits[0]?.snippet.length).toBeLessThanOrEqual(200);
  });

  it('FR-WIKI-08: ignores case and requires every word of the query', () => {
    expect(slugsFor('QUEUE WAIT')[0]).toBe('queue-wait');
    const both = slugsFor('triggerer heartbeat');
    for (const slug of both) {
      const text = JSON.stringify(findWikiPage(slug)).toLowerCase();
      expect(text).toContain('triggerer');
      expect(text).toContain('heartbeat');
    }
  });

  it('FR-WIKI-08: ranks pages whose title matches above pages that only mention the word', () => {
    expect(slugsFor('pools')[0]).toBe('pools');
    expect(slugsFor('glossary')[0]).toBe('glossary');
  });

  it('FR-WIKI-08: returns nothing for an empty query or a word no page contains', () => {
    expect(searchWiki(WIKI_PAGES, '   ')).toEqual([]);
    expect(searchWiki(WIKI_PAGES, 'zyxwvut')).toEqual([]);
  });
});
