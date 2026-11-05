/**
 * Official documentation the wiki cites. Every URL is one the DCAM specification cites (spec
 * Appendix H, §12.9, §13.1, §14.2); "C3" pages are under the Composer 3 documentation root.
 * The CI link checker of spec §15.6 will verify them.
 */
import type { ComposerGeneration, Source } from './model';

/** The date the seed content was checked against the specification and the sources below. */
export const LAST_VERIFIED = '2026-11-05';
export const COMPOSER_2_AND_3: readonly ComposerGeneration[] = ['2', '3'];

const C3 = 'https://docs.cloud.google.com/composer/docs/composer-3';
const AIRFLOW = 'https://airflow.apache.org/docs/apache-airflow/stable';

export const SOURCES = {
  composerReleaseNotes: {
    title: 'Managed Airflow release notes',
    url: 'https://docs.cloud.google.com/composer/docs/release-notes',
  },
  composerArchitecture: {
    title: 'Managed Airflow (Gen 3): environment architecture',
    url: `${C3}/environment-architecture`,
  },
  composerScaling: {
    title: 'Managed Airflow (Gen 3): environment scaling',
    url: `${C3}/environment-scaling`,
  },
  composerScaleEnvironments: {
    title: 'Managed Airflow (Gen 3): scale environments',
    url: `${C3}/scale-environments`,
  },
  composerOptimize: {
    title: 'Managed Airflow (Gen 3): optimize environment performance',
    url: `${C3}/optimize-environments`,
  },
  composerTroubleshootScheduling: {
    title: 'Managed Airflow (Gen 3): troubleshooting scheduling',
    url: `${C3}/troubleshooting-scheduling`,
  },
  composerMonitor: {
    title: 'Managed Airflow (Gen 3): monitor environments',
    url: `${C3}/monitor-environments`,
  },
  composerKeyMetrics: {
    title: 'Managed Airflow (Gen 3): monitor key metrics',
    url: `${C3}/monitor-key-metrics`,
  },
  composerAirflowConfigurations: {
    title: 'Managed Airflow: Airflow configuration overrides',
    url: 'https://docs.cloud.google.com/composer/docs/airflow-configurations',
  },
  composerMetrics: {
    title: 'Cloud Monitoring: Composer metrics',
    url: 'https://cloud.google.com/monitoring/api/metrics_gcp_c#gcp-composer',
  },
  airflowPools: {
    title: 'Airflow documentation: pools',
    url: `${AIRFLOW}/administration-and-deployment/pools.html`,
  },
  airflowConfig: {
    title: 'Airflow configuration reference',
    url: `${AIRFLOW}/configurations-ref.html`,
  },
  celeryConfig: {
    title: 'Celery provider configuration reference',
    url: 'https://airflow.apache.org/docs/apache-airflow-providers-celery/stable/configurations-ref.html',
  },
  airflowRestApi: {
    title: 'Airflow REST API reference',
    url: `${AIRFLOW}/stable-rest-api-ref.html`,
  },
  airflowMetrics: {
    title: 'Airflow metrics',
    url: `${AIRFLOW}/administration-and-deployment/logging-monitoring/metrics.html`,
  },
  airflowBestPractices: {
    title: 'Airflow best practices',
    url: `${AIRFLOW}/best-practices.html`,
  },
  airflowScheduler211: {
    title: 'Airflow 2.11 source: airflow/jobs/scheduler_job_runner.py (v2-11-stable)',
    url: 'https://github.com/apache/airflow/tree/v2-11-stable',
  },
} as const satisfies Record<string, Source>;
