/**
 * (i) explanations for the setup page (FR-UI-05, spec §12.9).
 *
 * @implements FR-UI-05, FR-SETUP-02
 */
import type { Explanation } from '@dcam/ui-kit';
import { WIKI_SLUGS, wikiHref } from '../wiki/content/slugs';

export const SETUP_EXPLANATIONS = {
  'setup-issues': {
    id: 'setup-issues',
    title: 'Configuration issues',
    summary:
      'Each problem DCAM found when it checked the configuration file against its schema (FR-SETUP-02, spec §17).',
    howToRead:
      'The path names the setting, for example environments.0.projectId is projectId in the first environment. "Whole file" means the problem is not in one setting, for example invalid YAML.',
    sources: ['dcam.config.yaml'],
    caveats: ['DCAM reads the file when it starts, so restart it after you fix the file.'],
  },
  'setup-steps': {
    id: 'setup-steps',
    title: 'Next steps',
    summary: 'How to point DCAM at your own environments (spec §17.6).',
    whyItMatters:
      'DCAM only reads. It signs in with your Application Default Credentials and never changes your environments.',
    howToRead:
      'Run the commands in a terminal in the DCAM folder. DCAM never runs them for you: the Copy button only copies the text.',
    sources: ['DCAM documentation'],
    wiki: { href: wikiHref(WIKI_SLUGS.startHere), title: 'Start here' },
    // The same Google Cloud CLI reference that ADR-0016 cites.
    docs: [
      {
        title: 'gcloud auth application-default login',
        url: 'https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/login',
      },
      {
        title: 'Google Cloud CLI: proxy settings',
        url: 'https://docs.cloud.google.com/sdk/docs/proxy-settings',
      },
    ],
  },
} as const satisfies Record<string, Explanation>;

export type SetupExplanationId = keyof typeof SETUP_EXPLANATIONS;
export const SETUP_PANELS = Object.keys(SETUP_EXPLANATIONS) as SetupExplanationId[];
