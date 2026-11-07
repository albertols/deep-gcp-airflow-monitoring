/**
 * Documentation the doctor links to, one per kind of fix (FR-AUTH-05). Each URL was opened on
 * 2026-11-05 and is the official page for the fix it is attached to.
 *
 * @implements FR-AUTH-05
 */
export const DOCTOR_DOCS = {
  nodeDownload: 'https://nodejs.org/en/download',
  duckdbNode: 'https://duckdb.org/docs/2.0/clients/node_neo/overview.html',
  gcloudInstall: 'https://docs.cloud.google.com/sdk/docs/install',
  adcLogin: 'https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/login',
  setQuotaProject:
    'https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/set-quota-project',
  gcloudProxy: 'https://docs.cloud.google.com/sdk/docs/proxy-settings',
  nodeExtraCaCerts: 'https://nodejs.org/api/cli.html#node_extra_ca_certsfile',
  composerIam: 'https://docs.cloud.google.com/composer/docs/composer-3/access-control',
  composerVersions: 'https://docs.cloud.google.com/composer/docs/composer-versions',
  airflowApi: 'https://docs.cloud.google.com/composer/docs/composer-3/access-airflow-api',
  airflowRbac: 'https://docs.cloud.google.com/composer/docs/composer-3/airflow-rbac',
  monitoringIam: 'https://docs.cloud.google.com/monitoring/access-control',
  enableApi: 'https://docs.cloud.google.com/service-usage/docs/enable-disable',
  vpcSc: 'https://docs.cloud.google.com/vpc-service-controls/docs/retrieve-troubleshoot-errors',
} as const;
