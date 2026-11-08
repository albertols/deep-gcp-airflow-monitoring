/**
 * What the command palette can jump to (FR-UI-03), from the registries the web already has: the pages
 * (navigation), environments (`/api/v1/meta`), the selected environment's DAGs (`GET …/dag-index`), wiki
 * pages, advisor rules (they open their wiki page) and the default alert pack (it opens the alerts page).
 * Tasks and configuration options are not targets yet: task IDs are only in task history, and there is no
 * configuration registry (specs/010 "Out of scope").
 *
 * @implements FR-UI-03
 */
import type { DagIndex, Meta } from '@dcam/contracts';
import { NAV } from '../../nav';
import { ADVISOR_RULES, ALERT_PACK_RULES, RULE_WIKI_PAGES, WIKI_PAGES } from '../../pages/wiki/content';
import type { PaletteTarget } from './search';

/** Pages, wiki pages, advisor rules and alert rules: the same for every environment. */
export function staticTargets(): PaletteTarget[] {
  return [
    ...NAV.map((item): PaletteTarget => ({
      key: `page:${item.route.page}`,
      kind: 'page',
      label: item.label,
      detail: item.hint,
      action: { kind: 'route', route: item.route },
    })),
    ...WIKI_PAGES.map((page): PaletteTarget => ({
      key: `wiki:${page.slug}`,
      kind: 'wiki',
      label: page.title,
      detail: page.summary,
      action: { kind: 'route', route: { page: 'wiki', slug: page.slug } },
    })),
    ...ADVISOR_RULES.map((rule): PaletteTarget => ({
      key: `advisor-rule:${rule.id}`,
      kind: 'advisor-rule',
      label: `${rule.id} ${rule.title}`,
      detail: rule.category,
      action: { kind: 'route', route: { page: 'wiki', slug: RULE_WIKI_PAGES[rule.id] } },
    })),
    ...ALERT_PACK_RULES.map((rule): PaletteTarget => ({
      key: `alert-rule:${rule.id}`,
      kind: 'alert-rule',
      label: `${rule.id} ${rule.name}`,
      detail: 'Its state in every environment',
      action: { kind: 'route', route: { page: 'alerts' } },
    })),
  ];
}

export function environmentTargets(environments: Meta['environments']): PaletteTarget[] {
  return environments.map((env) => ({
    key: `environment:${env.env_id}`,
    kind: 'environment',
    label: env.display_name,
    detail: `${env.env_id} · ${env.tier}`,
    action: { kind: 'environment', envId: env.env_id },
  }));
}

export function dagTargets(dags: DagIndex['dags']): PaletteTarget[] {
  return dags.map((d) => ({
    key: `dag:${d.dag_id}`,
    kind: 'dag',
    label: d.dag_id,
    detail: `Team ${d.team}${d.paused ? ' · paused' : ''}`,
    action: { kind: 'route', route: { page: 'dag', dagId: d.dag_id } },
  }));
}
