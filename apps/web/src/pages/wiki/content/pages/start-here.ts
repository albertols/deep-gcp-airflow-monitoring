/**
 * Start here (spec §15.1): what DCAM is, what it never does, and how to read its numbers.
 * Facts: spec §1, §7 (naming note), §8.1, §8.9, §18.2, §20.6.
 */
import { callout, code, h2, link, p, ul, type WikiPage } from '../model';
import { WIKI_SLUGS } from '../slugs';
import { COMPOSER_2_AND_3, LAST_VERIFIED, SOURCES } from '../sources';

export const startHere: WikiPage = {
  slug: WIKI_SLUGS.startHere,
  title: 'Start here',
  section: 'Start here',
  summary: 'What DCAM shows, what it never does, and how to read its numbers.',
  appliesTo: { composer: COMPOSER_2_AND_3, airflow: '2 and 3' },
  lastVerified: LAST_VERIFIED,
  sources: [SOURCES.composerReleaseNotes, SOURCES.airflowRestApi],
  related: [WIKI_SLUGS.concurrencyStack, WIKI_SLUGS.whyWorkWaits, WIKI_SLUGS.glossary],
  body: [
    p(
      "DCAM is a local, read-only monitoring and advisory tool for Google Cloud's Managed Service for Apache Airflow, formerly Cloud Composer. ",
      'It shows which DAGs consume capacity and why work waits, with evidence, and suggests changes that you review and apply yourself.',
    ),
    callout(
      'info',
      'About the names',
      'Since 2026-04-15 Google calls Cloud Composer "Managed Service for Apache Airflow": Composer 3 is "Managed Airflow (Gen 3)" and Composer 2 is "Managed Airflow (Gen 2)". ',
      'The API name, the metric names and the ',
      code('gcloud composer'),
      ' commands are unchanged, so this wiki keeps the Composer names.',
    ),
    h2('What DCAM never does'),
    ul(
      "DCAM only reads. Every call to Google Cloud and Airflow goes through one guarded client that allows only declared read requests. DCAM can't pause a DAG, change a pool or update an environment, even when your identity is allowed to.",
      'DCAM installs nothing in your environments. It reads public Google Cloud APIs and the Airflow REST API.',
      'Advisor snippets and alert policy exports are copy-only. You review them, then apply them yourself.',
    ),
    h2('Demo mode'),
    p(
      'With ',
      code('pnpm dcam --demo'),
      ', DCAM runs on a simulated Airflow 2.11 environment for the fictitious "acme" organisation, with the environments ',
      code('acme-dev'),
      ', ',
      code('acme-test'),
      ' and ',
      code('acme-prod'),
      '. A banner shows on every page while you view demo data. Nothing in demo mode comes from Google Cloud.',
    ),
    p(
      'The demo tells a few stories you can explore: workers at their maximum at round hours, a small pool that starves, a fan-out DAG capped by its own ',
      code('max_active_tasks'),
      ', a sensor in poke mode, and schedules that collide at the top of the hour.',
    ),
    h2('How to read a number'),
    ul(
      ['Every number has a unit. Durations read like ', code('1h 12m'), '.'],
      'A value that starts with "≈" is an estimate. Its explanation names the method that produced it.',
      'Each panel shows where its data comes from and how fresh it is ("Data as of …").',
      'Select (i) next to a panel title for its definition, formula, source, freshness and links to the official documentation.',
      'Tail percentiles such as p95 need at least 20 samples. With fewer, DCAM shows the maximum instead and marks it as a low sample.',
      'Missing data shows as a gap, never as zero.',
    ),
    h2('Where to go next'),
    ul(
      [
        link(WIKI_SLUGS.concurrencyStack, 'The concurrency stack'),
        ': the limits between "ready" and "running".',
      ],
      [link(WIKI_SLUGS.whyWorkWaits, 'Why work waits'), ': how DCAM finds the limit that binds.'],
      [
        link(WIKI_SLUGS.executorSlotSeconds, 'Executor slot-seconds'),
        ': how the DAG league table measures capacity.',
      ],
      [
        link(WIKI_SLUGS.rb01, 'RB-01: Tasks stuck in queued or scheduled'),
        ': a runbook for the most common question.',
      ],
      [link(WIKI_SLUGS.glossary, 'Glossary'), ': the terms DCAM uses.'],
    ),
  ],
};
