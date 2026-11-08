/**
 * The bundled wiki (spec §15): every page, in index order, plus the stable slugs other pages use to
 * link here. Import `WIKI_SLUGS` and `wikiHref` from this module (or `./slugs`) to link to the wiki.
 *
 * @implements FR-WIKI-01, FR-WIKI-05, FR-WIKI-06, FR-WIKI-07
 */
import type { WikiPage } from './model';
import { advisorRules } from './pages/best-practices';
import { alertPack } from './pages/alerts';
import { scheduleCollisions, sensorSlotWaste, whyWorkWaits } from './pages/bottleneck-signals';
import { executorSlotSeconds, queueWait, workerCapacity } from './pages/capacity-signals';
import { concurrencyStack, pools, scheduledVsQueued } from './pages/concepts';
import { glossary } from './pages/glossary';
import { healthScore } from './pages/health-score';
import { rb01, rb14 } from './pages/runbooks';
import { startHere } from './pages/start-here';

export const WIKI_PAGES: readonly WikiPage[] = [
  startHere,
  concurrencyStack,
  pools,
  scheduledVsQueued,
  executorSlotSeconds,
  queueWait,
  whyWorkWaits,
  workerCapacity,
  scheduleCollisions,
  sensorSlotWaste,
  healthScore,
  advisorRules,
  alertPack,
  rb01,
  rb14,
  glossary,
];

const BY_SLUG: ReadonlyMap<string, WikiPage> = new Map(WIKI_PAGES.map((page) => [page.slug, page]));

export const findWikiPage = (slug: string): WikiPage | undefined => BY_SLUG.get(slug);

export {
  WIKI_SECTIONS,
  bodyText,
  internalLinks,
  pageText,
  richText,
  type Block,
  type ComposerGeneration,
  type GlossaryTerm,
  type Inline,
  type Rich,
  type Source,
  type WikiPage,
  type WikiSection,
} from './model';
export {
  RULE_WIKI_PAGES,
  RUNBOOK_WIKI_PAGES,
  SIGNAL_WIKI_PAGES,
  WIKI_SLUGS,
  wikiHref,
  type AdvisorRuleId,
  type WikiSlug,
} from './slugs';
export { ADVISOR_RULES, type AdvisorRule } from './rules';
export { GLOSSARY } from './pages/glossary';
export { ALERT_PACK_RULES, type AlertPackRule } from './pages/alerts';
