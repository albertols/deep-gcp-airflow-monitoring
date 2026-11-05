import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { afterEach, describe, expect, it } from 'vitest';
import type { Meta } from '@dcam/contracts';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { App } from '../src/App';
import { WIKI_PAGES, WIKI_SECTIONS, findWikiPage } from '../src/pages/wiki/content';
import { WikiPage } from '../src/pages/wiki/WikiPage';
import { linkTo, type Route } from '../src/router';

const meta: Meta = {
  name: 'DCAM',
  version: '0.0.0',
  mode: 'demo',
  environments: [{ env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' }],
};
const notYet = () => Promise.reject(new Error('not in this test'));
const api: DcamApi = {
  getMeta: async () => meta,
  getOverview: notYet,
  getDagLeague: notYet,
  getDagDetail: notYet,
  getBottlenecks: notYet,
  getFindings: notYet,
  getAlerts: notYet,
  getFleet: notYet,
};

function renderWiki(slug?: string) {
  const route: Route = slug === undefined ? { page: 'wiki' } : { page: 'wiki', slug };
  return render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <WikiPage
        api={api}
        envId="acme-prod"
        route={route}
        linkTo={(r) => linkTo(r, 'acme-prod')}
        navigate={() => undefined}
      />
    </ThemeProvider>,
  );
}

const wikiSlugOf = (href: string | null) => /^#\/wiki\/([^?]+)/.exec(href ?? '')?.[1];

afterEach(() => {
  window.location.hash = '';
});

describe('wiki page view', () => {
  it('FR-WIKI-01: every page renders by slug, with what it applies to, when it was verified and its sources', () => {
    for (const page of WIKI_PAGES) {
      const view = renderWiki(page.slug);
      const article = screen.getByRole('article', { name: page.title });
      expect(within(article).getByRole('heading', { level: 1, name: page.title })).toBeInTheDocument();
      expect(within(article).getByText(/^Composer 2 and 3/)).toBeInTheDocument();
      expect(within(article).getByText(`Airflow ${page.appliesTo.airflow}`)).toBeInTheDocument();
      expect(article.querySelector(`time[datetime="${page.lastVerified}"]`)).not.toBeNull();

      const sources = within(article).getByRole('region', { name: 'Sources' });
      const links = within(sources).getAllByRole('link');
      expect(links.map((a) => a.getAttribute('href'))).toEqual(page.sources.map((s) => s.url));
      for (const a of links) {
        expect(a).toHaveAttribute('target', '_blank');
        expect(a).toHaveAttribute('rel', 'noopener noreferrer');
      }

      // FR-WIKI-06: every rendered internal link opens an existing page and keeps the environment.
      for (const a of article.querySelectorAll('a[href^="#/wiki/"]')) {
        const href = a.getAttribute('href');
        expect(
          findWikiPage(decodeURIComponent(wikiSlugOf(href) ?? '')),
          `${page.slug} → ${href}`,
        ).toBeDefined();
        expect(href).toMatch(/\?env=acme-prod$/);
      }
      view.unmount();
    }
  }, 60_000);

  it('FR-WIKI-06: links between pages are wiki routes', () => {
    renderWiki('concurrency-stack');
    const article = screen.getByRole('article', { name: 'The concurrency stack' });
    expect(within(article).getAllByRole('link', { name: 'why work waits' })[0]).toHaveAttribute(
      'href',
      '#/wiki/why-work-waits?env=acme-prod',
    );
    expect(within(article).getByRole('link', { name: 'pools' })).toHaveAttribute(
      'href',
      '#/wiki/pools?env=acme-prod',
    );
  });

  it('FR-UI-06: has a breadcrumb back to the index and accessible landmarks', () => {
    renderWiki('pools');
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'Wiki' })).toHaveAttribute(
      'href',
      '#/wiki?env=acme-prod',
    );
    expect(screen.getByRole('region', { name: 'Related pages' })).toBeInTheDocument();
  });

  it('FR-WIKI-05: a runbook shows symptoms, checks, causes, fixes and links, in that order', () => {
    renderWiki('rb-01-tasks-stuck');
    const article = screen.getByRole('article', { name: 'RB-01: Tasks stuck in queued or scheduled' });
    const h2s = within(article)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(h2s.slice(0, 5)).toEqual(['Symptoms', 'Checks', 'Likely causes', 'Fixes', 'Links']);
    expect(h2s).toContain('Sources');
  });

  it('HM-006: the why-work-waits page shows the 13 reasons as an accessible table', () => {
    renderWiki('why-work-waits');
    const table = screen.getByRole('table', { name: /^Reasons in the order DCAM checks them/ });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(14); // header + 13 reasons
    expect(within(rows[5] as HTMLElement).getByText('Pool exhausted')).toBeInTheDocument();
  });

  it('FR-WIKI-07: the glossary renders as a definition list', () => {
    const { container } = renderWiki('glossary');
    const terms = [...container.querySelectorAll('dl dt')].map((dt) => dt.textContent);
    expect(terms).toContain('Effective concurrency');
    expect(terms).toContain('Binding limit');
  });

  it('FR-UI-07: an unknown slug shows a not-found state with a way back', () => {
    renderWiki('no-such-page');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText(/no-such-page/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the wiki index' })).toHaveAttribute(
      'href',
      '#/wiki?env=acme-prod',
    );
  });
});

describe('wiki index', () => {
  it('FR-WIKI-01: groups every page under its section', () => {
    renderWiki();
    expect(screen.getByRole('heading', { level: 1, name: 'Wiki' })).toBeInTheDocument();
    for (const section of WIKI_SECTIONS) {
      const region = screen.getByRole('region', { name: section });
      for (const page of WIKI_PAGES.filter((p) => p.section === section)) {
        expect(within(region).getByRole('link', { name: page.title })).toHaveAttribute(
          'href',
          `#/wiki/${page.slug}?env=acme-prod`,
        );
      }
    }
  });

  it('FR-WIKI-08: search finds a page by a word in its body', async () => {
    renderWiki();
    const search = screen.getByRole('search', { name: 'Wiki' });
    await userEvent.type(
      within(search).getByRole('searchbox', { name: 'Search the wiki' }),
      'airflow_monitoring',
    );
    expect(screen.getByRole('status')).toHaveTextContent('1 page matches "airflow_monitoring"');
    const results = screen.getByRole('region', { name: 'Search results' });
    expect(within(results).getByRole('link', { name: 'Health score' })).toHaveAttribute(
      'href',
      '#/wiki/health-score?env=acme-prod',
    );
    expect(screen.queryByRole('region', { name: 'Concepts' })).toBeNull();
  });

  it('FR-WIKI-08: a search without results says what to try next', async () => {
    renderWiki();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the wiki' }), 'zyxwvut');
    expect(screen.getByRole('status')).toHaveTextContent(
      /No pages match "zyxwvut"\. Try a shorter or different word/,
    );
  });
});

// The wiki is a lazy chunk with long pages; on a loaded CI runner it can take more than the default 1 s.
const LAZY_PAGE = { timeout: 5_000 };

describe('wiki in the app shell', () => {
  it('FR-UI-06: opens the wiki page named in the URL, and links lead to other pages', async () => {
    window.location.hash = '#/wiki/pools?env=acme-prod';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider theme={createDcamTheme('dark')}>
        <QueryClientProvider client={client}>
          <App api={api} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Pools' }, LAZY_PAGE)).toBeInTheDocument();
    const article = screen.getByRole('article', { name: 'Pools' });
    await userEvent.click(within(article).getAllByRole('link', { name: 'Pool exhausted' })[0] as HTMLElement);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Why work waits' }, LAZY_PAGE),
    ).toBeInTheDocument();
  }, 20_000);
});
