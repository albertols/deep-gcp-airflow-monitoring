import type { DcamApi } from '../api';
import type { PageParams, Route } from '../router';

/** What every page receives from the shell. */
export interface PageProps {
  readonly api: DcamApi;
  /** Selected environment; pages that span environments ignore it. */
  readonly envId: string;
  readonly route: Route;
  /**
   * Hash link to a route, keeping the selected environment and the context bar; `params` are the target
   * page's own state (FR-UI-02), for example the DAGs to compare or the finding to open.
   */
  readonly linkTo: (route: Route, params?: PageParams) => string;
  readonly navigate: (route: Route) => void;
}
