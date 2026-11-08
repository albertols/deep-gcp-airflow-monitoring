/**
 * What the context bar shares with every page (FR-UI-01): the time range, the time zone and its
 * formatters, and live or paused updates; and each page's own state in the URL (FR-UI-02). Pages
 * rendered without the shell (page tests) get the defaults and keep their state locally.
 *
 * @implements FR-UI-01, FR-UI-02
 */
import { createContext, useCallback, useContext, useState } from 'react';
import type { Range } from '@dcam/contracts';
import type { PageParams } from '../router';
import { UTC_TIME, type TimeFormat, type TimeZoneChoice } from './time';

export interface View {
  readonly range: Range;
  readonly tz: TimeZoneChoice;
  readonly paused: boolean;
  /** Formatters for the selected time zone. */
  readonly time: TimeFormat;
}

export const DEFAULT_PAGE_VIEW: View = { range: '24h', tz: 'utc', paused: false, time: UTC_TIME };

export const ViewContext = createContext<View>(DEFAULT_PAGE_VIEW);

export const useView = (): View => useContext(ViewContext);
export const useTimeFormat = (): TimeFormat => useContext(ViewContext).time;

/** Query options while paused: no polling, no refetch on focus or reconnect. */
const PAUSED = { refetchInterval: false, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const UPDATING = {} as const;

/**
 * Spread into `useQuery` options: while paused the query keeps what it has (FR-UI-01); while updating,
 * the query client's 30 s polling applies. A new range or environment still loads at once.
 */
export const refreshOptions = (paused: boolean): typeof PAUSED | typeof UPDATING =>
  paused ? PAUSED : UPDATING;

/** {@link refreshOptions} for the context bar's live or paused state. */
export const useRefresh = () => refreshOptions(useView().paused);

export interface PageParamsValue {
  readonly params: PageParams;
  /** Sets page parameters; `null` or the default removes one from the URL. */
  readonly set: (patch: Readonly<Record<string, string | null>>) => void;
}

export const PageParamsContext = createContext<PageParamsValue | null>(null);

/**
 * Several page parameters at once (FR-UI-02), for example "Clear filters". Without the shell they live
 * in local state.
 */
export function usePageParams(): PageParamsValue {
  const shell = useContext(PageParamsContext);
  const [local, setLocal] = useState<PageParams>({});
  const setLocalPatch = useCallback((patch: Readonly<Record<string, string | null>>) => {
    setLocal((current) => {
      const next: Record<string, string> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') delete next[key];
        else next[key] = value;
      }
      return next;
    });
  }, []);
  return shell ?? { params: local, set: setLocalPatch };
}

/** One page parameter in the URL (FR-UI-02): a filter, sort, selection or tab, with its default. */
export function usePageParam(name: string, fallback = ''): [string, (value: string) => void] {
  const { params, set } = usePageParams();
  const setValue = useCallback(
    (value: string) => set({ [name]: value === fallback ? null : value }),
    [set, name, fallback],
  );
  return [params[name] ?? fallback, setValue];
}
