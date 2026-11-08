/**
 * The app's pages in navigation order (spec §12.2): the left navigation and the command palette's page
 * targets (FR-UI-03) both read this list.
 *
 * @implements FR-UI-03
 */
import type { Page, Route } from './router';

export interface NavItem {
  readonly label: string;
  readonly route: Route;
  readonly hint: string;
  /** Pages that highlight this item. */
  readonly matches: readonly Page[];
}

export const NAV: readonly NavItem[] = [
  { label: 'Fleet', route: { page: 'fleet' }, hint: 'Every environment', matches: ['fleet'] },
  { label: 'Capacity overview', route: { page: 'overview' }, hint: 'One environment', matches: ['overview'] },
  {
    label: 'Capacity',
    route: { page: 'capacity' },
    hint: 'Worker slots and the forecast',
    matches: ['capacity'],
  },
  {
    label: 'DAG league table',
    route: { page: 'dags' },
    hint: 'Who uses capacity',
    matches: ['dags', 'dag', 'compare-dags'],
  },
  { label: 'Bottlenecks', route: { page: 'bottlenecks' }, hint: 'Why work waits', matches: ['bottlenecks'] },
  {
    label: 'Schedule intelligence',
    route: { page: 'schedule' },
    hint: 'Which schedules collide',
    matches: ['schedule'],
  },
  { label: 'Advisor', route: { page: 'advisor' }, hint: 'What to change', matches: ['advisor'] },
  { label: 'Alerts', route: { page: 'alerts' }, hint: 'Local alert rules', matches: ['alerts'] },
  { label: 'DCAM health', route: { page: 'health' }, hint: 'What DCAM collects', matches: ['health'] },
  { label: 'Wiki', route: { page: 'wiki' }, hint: 'How it works', matches: ['wiki'] },
];
