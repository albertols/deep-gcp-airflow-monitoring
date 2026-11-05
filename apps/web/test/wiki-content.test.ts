import { describe, expect, it } from 'vitest';
import {
  ADVISOR_RULES,
  GLOSSARY,
  RULE_WIKI_PAGES,
  RUNBOOK_WIKI_PAGES,
  SIGNAL_WIKI_PAGES,
  WIKI_PAGES,
  WIKI_SECTIONS,
  WIKI_SLUGS,
  findWikiPage,
  internalLinks,
  pageText,
  richText,
  wikiHref,
  type Block,
  type WikiPage,
} from '../src/pages/wiki/content';

const slugs = new Set<string>(WIKI_PAGES.map((p) => p.slug));
const page = (slug: string): WikiPage => {
  const found = findWikiPage(slug);
  if (!found) throw new Error(`no wiki page ${slug}`);
  return found;
};
const headings = (p: WikiPage) =>
  p.body.filter((b): b is Extract<Block, { kind: 'heading' }> => b.kind === 'heading').map((b) => b.text);
const tableByCaption = (p: WikiPage, caption: RegExp) => {
  const table = p.body.find(
    (b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table' && caption.test(b.caption),
  );
  if (!table) throw new Error(`no table ${String(caption)} on ${p.slug}`);
  return table;
};

describe('wiki content model (spec §15)', () => {
  it('FR-WIKI-01: seeds the sections and topic pages of spec §15.1 for feature 001', () => {
    expect(WIKI_SECTIONS).toEqual([
      'Start here',
      'Concepts',
      'How DCAM computes things',
      'Best practices',
      'Alerts',
      'Runbooks',
      'Glossary',
    ]);
    for (const section of WIKI_SECTIONS) {
      expect(
        WIKI_PAGES.some((p) => p.section === section),
        section,
      ).toBe(true);
    }
    for (const slug of [
      'start-here',
      'concurrency-stack',
      'pools',
      'scheduled-vs-queued',
      'executor-slot-seconds',
      'queue-wait',
      'why-work-waits',
      'worker-capacity-and-autoscaling',
      'schedule-collisions',
      'sensor-slot-waste',
      'health-score',
      'advisor-rules',
      'default-alert-pack',
      'rb-01-tasks-stuck',
      'glossary',
    ]) {
      expect(slugs.has(slug), slug).toBe(true);
    }
  });

  it('FR-WIKI-01: every page declares appliesTo, lastVerified and at least one official https source', () => {
    for (const p of WIKI_PAGES) {
      expect(p.appliesTo.composer.length, p.slug).toBeGreaterThan(0);
      for (const c of p.appliesTo.composer) expect(['2', '3']).toContain(c);
      expect(p.appliesTo.airflow.trim(), p.slug).not.toBe('');
      expect(p.lastVerified, p.slug).toBe('2026-11-05');
      expect(p.sources.length, p.slug).toBeGreaterThan(0);
      for (const s of p.sources) {
        expect(s.url, p.slug).toMatch(/^https:\/\/[^\s]+$/);
        expect(s.title.trim(), p.slug).not.toBe('');
      }
      expect(p.summary.trim(), p.slug).not.toBe('');
      expect(p.body.length, p.slug).toBeGreaterThan(0);
    }
  });

  it('FR-UI-06: page slugs are unique and safe in a URL path segment', () => {
    expect(slugs.size).toBe(WIKI_PAGES.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('FR-WIKI-06: every internal wiki link resolves to an existing page', () => {
    for (const p of WIKI_PAGES) {
      for (const target of internalLinks(p)) expect(slugs.has(target), `${p.slug} → ${target}`).toBe(true);
    }
  });

  it('FR-WIKI-06: WIKI_SLUGS and the pages match one to one, so other pages can link safely', () => {
    const exported = Object.values(WIKI_SLUGS);
    expect(exported).toHaveLength(WIKI_PAGES.length);
    expect(new Set<string>(exported)).toEqual(slugs);
    expect(wikiHref(WIKI_SLUGS.queueWait)).toBe('#/wiki/queue-wait');
  });

  it('FR-WIKI-06: every advisor rule links to a best-practice page that names it, and to a topic page', () => {
    expect(ADVISOR_RULES.map((r) => r.id)).toEqual([
      'REC-CAP-01',
      'REC-CAP-05',
      'REC-CAP-08',
      'REC-CONC-01',
      'REC-CONC-02',
      'REC-CONC-03',
      'REC-CONC-04',
      'REC-DAG-01',
      'REC-DAG-05',
      'REC-SCHED-01',
    ]);
    for (const rule of ADVISOR_RULES) {
      const target = page(RULE_WIKI_PAGES[rule.id]);
      expect(target.section, rule.id).toBe('Best practices');
      expect(pageText(target), rule.id).toContain(rule.id);
      expect(slugs.has(rule.learnMore), rule.id).toBe(true);
      expect(richText(rule.trigger).trim(), rule.id).not.toBe('');
      expect(richText(rule.action).trim(), rule.id).not.toBe('');
    }
  });

  it('FR-WIKI-06: signal and runbook IDs map to the page that explains them', () => {
    for (const [signal, slug] of Object.entries(SIGNAL_WIKI_PAGES)) {
      expect(page(slug).signals ?? [], signal).toContain(signal);
    }
    for (const [id, slug] of Object.entries(RUNBOOK_WIKI_PAGES)) {
      expect(page(slug).runbook?.id, id).toBe(id);
    }
  });

  it('FR-WIKI-05: runbooks read symptoms → checks → causes → fixes → links', () => {
    const runbooks = WIKI_PAGES.filter((p) => p.section === 'Runbooks');
    expect(runbooks.map((p) => p.runbook?.id)).toEqual(['RB-01', 'RB-14']);
    for (const p of runbooks) {
      expect(headings(p), p.slug).toEqual(['Symptoms', 'Checks', 'Likely causes', 'Fixes', 'Links']);
      expect(p.runbook?.relatedRules.length, p.slug).toBeGreaterThan(0);
    }
    expect(page('rb-01-tasks-stuck').runbook?.relatedRules).toEqual([
      'REC-CAP-01',
      'REC-CONC-01',
      'REC-CONC-02',
      'REC-DAG-01',
      'REC-SCHED-01',
    ]);
  });

  it('FR-WIKI-07: the glossary defines the core terms of spec §6.2, in alphabetical order', () => {
    const terms = GLOSSARY.map((t) => t.term);
    for (const term of [
      'Slot',
      'Effective concurrency',
      'Binding limit',
      'Queue wait',
      'Scheduling delay',
      'Slot-seconds',
      'Critical path',
      'Deferral',
      'Parse loop',
      'Stale DAG',
      'Zombie (heartbeat timeout)',
      'Noisy neighbour',
      'Observer budget',
      'Source lag',
      'Tenant project',
      'DCU',
      'Provenance',
    ]) {
      expect(terms, term).toContain(term);
    }
    expect(terms).toEqual([...terms].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
    for (const t of GLOSSARY) {
      expect(richText(t.definition).trim(), t.term).not.toBe('');
      if (t.see) expect(slugs.has(t.see), t.term).toBe(true);
    }
    expect(pageText(page('glossary'))).toContain('Effective concurrency');
  });

  it('HM-006: the why-work-waits page lists the 13 reasons in the classifier order', () => {
    const table = tableByCaption(page('why-work-waits'), /^Reasons/);
    expect(table.rows.map((row) => richText(row[1] ?? []))).toEqual([
      'DAG max_active_runs',
      'Pool does not exist',
      'Task larger than its pool',
      'Global parallelism',
      'Pool exhausted',
      'DAG max_active_tasks',
      'Task-level limit',
      'Scheduler throughput',
      'Autoscaling lag',
      'Executor slots exhausted',
      'Worker pickup',
      'Triggerer capacity',
      'Unknown',
    ]);
    expect(table.rows.map((row) => richText(row[2] ?? []))).toEqual([
      'Run',
      ...Array<string>(7).fill('Pre-queue'),
      ...Array<string>(3).fill('Post-queue'),
      'Deferral',
      'Any',
    ]);
    expect(pageText(page('why-work-waits'))).toMatch(/normal latency/i);
  });

  it('HM-028: the health score page lists the nine checks with weights that add up to 100', () => {
    const table = tableByCaption(page('health-score'), /^Health checks/);
    expect(table.rows).toHaveLength(9);
    const weights = table.rows.map((row) => Number(richText(row[2] ?? [])));
    expect(weights.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('FR-ALRT-02: the alert pack page lists AL-01 to AL-19', () => {
    const table = tableByCaption(page('default-alert-pack'), /^Default alert pack/);
    expect(table.rows.map((row) => richText(row[0] ?? []))).toEqual(
      Array.from({ length: 19 }, (_, i) => `AL-${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('keeps the ⚠️ VERIFY markers the spec carries for open facts', () => {
    for (const slug of [
      'executor-slot-seconds',
      'why-work-waits',
      'worker-capacity-and-autoscaling',
      'health-score',
      'concurrency-stack',
    ]) {
      expect(pageText(page(slug)), slug).toContain('⚠️ VERIFY');
    }
  });
});
