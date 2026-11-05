import type { DcamApi } from '../api';
import type { Route } from '../router';

/** What every page receives from the shell. */
export interface PageProps {
  readonly api: DcamApi;
  /** Selected environment; pages that span environments ignore it. */
  readonly envId: string;
  readonly route: Route;
  /** Hash link to a route, keeping the selected environment. */
  readonly linkTo: (route: Route) => string;
  readonly navigate: (route: Route) => void;
}
