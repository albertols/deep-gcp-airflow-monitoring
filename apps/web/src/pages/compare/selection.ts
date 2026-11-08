/**
 * The DAGs a comparison shows (FR-DAGD-08): 2 to 4 items `env_id:dag_id`, in the URL as the `dags` page
 * parameter (FR-UI-02) and in the API's `dags` query. An item splits at its first colon: environment IDs
 * have none (`^[a-z0-9][a-z0-9-]{0,62}$`, the contract's pattern), and Airflow DAG IDs match `^[\w.-]+$`
 * (`KEY_REGEX` in `airflow/utils/helpers.py`), so they have neither a colon nor a comma.
 *
 * @implements FR-DAGD-08, FR-UI-02
 */

export interface CompareItem {
  readonly envId: string;
  readonly dagId: string;
}

export const MIN_COMPARE = 2;
export const MAX_COMPARE = 4;

const ENV_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DAG_ID = /^[\w.-]{1,250}$/;

export const sameItem = (a: CompareItem, b: CompareItem) => a.envId === b.envId && a.dagId === b.dagId;

export const itemKey = (item: CompareItem) => `${item.envId}:${item.dagId}`;

export const canCompare = (items: readonly CompareItem[]) =>
  items.length >= MIN_COMPARE && items.length <= MAX_COMPARE;

/** Adds an item at the end; a DAG already compared, or a fifth one, leaves the selection as it is. */
export function addToSelection(items: readonly CompareItem[], item: CompareItem): readonly CompareItem[] {
  if (items.length >= MAX_COMPARE || items.some((x) => sameItem(x, item))) return items;
  return [...items, item];
}

export const removeFromSelection = (items: readonly CompareItem[], item: CompareItem) =>
  items.filter((x) => !sameItem(x, item));

/** The `dags` parameter of a link: valid items only, without duplicates, at most four. */
export function parseSelection(param: string): readonly CompareItem[] {
  let items: readonly CompareItem[] = [];
  for (const raw of param.split(',')) {
    const at = raw.indexOf(':');
    if (at <= 0) continue;
    const item = { envId: raw.slice(0, at).trim(), dagId: raw.slice(at + 1).trim() };
    if (ENV_ID.test(item.envId) && DAG_ID.test(item.dagId)) items = addToSelection(items, item);
  }
  return items;
}

export const formatSelection = (items: readonly CompareItem[]) => items.map(itemKey).join(',');
