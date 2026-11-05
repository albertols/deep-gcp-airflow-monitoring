/**
 * Text, documentation links and remediation snippets shared by the advisor rules (spec §13.5).
 *
 * Snippets are copy-only text (FR-ADV-03): DCAM never runs them. They use the environment's actual
 * values and placeholders (`LOCATION`) for what DCAM does not know, state what the update does, and
 * recommend a maintenance window in production. Option names follow Composer's `section-key` form.
 *
 * @implements FR-ADV-03, FR-CFG-08
 */
import type { DocLink, Snippet } from './advisor-model';
import type { EnvironmentConfig } from './model';

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });

export const fmtInt = (n: number) => intFmt.format(n);
/** Hours with at most one decimal: `20`, `15.8`. */
export const fmtHours = (h: number) => oneDecimal.format(h);
/** Hours with their unit, singular for exactly one: `1 task-hour`, `15.8 slot-hours`. */
export const fmtHoursOf = (h: number, unit: 'task-hour' | 'slot-hour') =>
  `${fmtHours(h)} ${fmtHours(h) === '1' ? unit : `${unit}s`}`;
/** A share 0–1 as a whole percentage: `72%`. */
export const fmtPct = (x: number | null) => (x === null ? 'unknown' : pctFmt.format(x));
export const fmtMinutes = (m: number) => `${fmtInt(Math.round(m))} min`;

/** Durations like `42s`, `14m`, `1h 12m`. */
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const rest = s % 60;
    return rest ? `${Math.floor(s / 60)}m ${rest}s` : `${s / 60}m`;
  }
  const m = Math.round((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)}h ${m}m` : `${Math.floor(s / 3600)}h`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** Official documentation cited by the rules (spec Appendix H). */
export const DOCS = {
  optimize: {
    title: 'Managed Airflow (Gen 3): optimize environment performance and costs',
    url: 'https://docs.cloud.google.com/composer/docs/composer-3/optimize-environments',
  },
  scale: {
    title: 'Managed Airflow (Gen 3): scale environments',
    url: 'https://docs.cloud.google.com/composer/docs/composer-3/scale-environments',
  },
  overrides: {
    title: 'Managed Airflow: Airflow configuration overrides',
    url: 'https://docs.cloud.google.com/composer/docs/airflow-configurations',
  },
  troubleshootingScheduling: {
    title: 'Managed Airflow (Gen 3): troubleshoot scheduling',
    url: 'https://docs.cloud.google.com/composer/docs/composer-3/troubleshooting-scheduling',
  },
  airflowCli: {
    title: 'Managed Airflow (Gen 3): access the Airflow CLI',
    url: 'https://docs.cloud.google.com/composer/docs/composer-3/access-airflow-cli',
  },
  gcloudUpdate: {
    title: 'gcloud composer environments update',
    url: 'https://cloud.google.com/sdk/gcloud/reference/composer/environments/update',
  },
  gcloudRun: {
    title: 'gcloud composer environments run',
    url: 'https://cloud.google.com/sdk/gcloud/reference/composer/environments/run',
  },
  terraform: {
    title: 'Terraform: google_composer_environment',
    url: 'https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/composer_environment',
  },
  airflowConfig: {
    title: 'Airflow configuration reference',
    url: 'https://airflow.apache.org/docs/apache-airflow/stable/configurations-ref.html',
  },
  pools: {
    title: 'Airflow documentation: pools',
    url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html',
  },
  dags: {
    title: 'Airflow documentation: DAGs',
    url: 'https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html',
  },
  dagRuns: {
    title: 'Airflow documentation: DAG runs',
    url: 'https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html',
  },
  sensors: {
    title: 'Airflow documentation: sensors',
    url: 'https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/sensors.html',
  },
  deferring: {
    title: 'Airflow documentation: deferrable operators and triggers',
    url: 'https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/deferring.html',
  },
} as const satisfies Record<string, DocLink>;

const UPDATE_NOTE = [
  '# An environment update usually takes several minutes and can restart Airflow components',
  '# (⚠️ VERIFY which components restart on Composer 3). Use a maintenance window in production.',
];

/** Terraform resource label from an environment ID: `acme-prod` → `acme_prod`. */
const label = (envId: string) => envId.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * One shell word from a value read from the monitored system (a pool name): left as is when it is
 * plainly safe, otherwise single-quoted with `'` written as `'\''`, so pasting the snippet runs
 * nothing else (spec §13.5).
 */
export const shellWord = (value: string): string =>
  /^[A-Za-z0-9_.:/=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** A `#` comment line whose text cannot end the comment: line breaks and control characters become spaces. */
const commentLine = (text: string): string => `# ${text.replace(/\p{Cc}+/gu, ' ')}`;

/** `gcloud composer environments update` with Airflow configuration overrides (merged with existing ones). */
export function gcloudConfigOverride(
  config: EnvironmentConfig,
  comment: string,
  overrides: Readonly<Record<string, string | number>>,
): Snippet {
  const pairs = Object.entries(overrides)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return {
    kind: 'gcloud',
    title: 'gcloud',
    language: 'bash',
    code: [
      commentLine(comment),
      ...UPDATE_NOTE,
      `gcloud composer environments update ${config.envId} \\`,
      '  --location LOCATION \\',
      `  --update-airflow-configs=${pairs}`,
    ].join('\n'),
  };
}

/** Terraform `airflow_config_overrides`; the map replaces all overrides, so existing ones must stay in it. */
export function terraformConfigOverride(
  config: EnvironmentConfig,
  comment: string,
  overrides: Readonly<Record<string, string | number>>,
): Snippet {
  const width = Math.max(...Object.keys(overrides).map((k) => k.length + 2));
  return {
    kind: 'terraform',
    title: 'Terraform',
    language: 'hcl',
    code: [
      commentLine(comment),
      '# airflow_config_overrides replaces the whole map: keep your existing overrides in it.',
      `resource "google_composer_environment" "${label(config.envId)}" {`,
      `  name   = "${config.envId}"`,
      '  region = "LOCATION"',
      '  config {',
      '    software_config {',
      '      airflow_config_overrides = {',
      ...Object.entries(overrides).map(([k, v]) => `        ${`"${k}"`.padEnd(width)} = "${v}"`),
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  };
}

/** `gcloud composer environments update` with workload sizing flags such as `--max-workers`. */
export function gcloudWorkers(
  config: EnvironmentConfig,
  comment: string,
  flag: string,
  value: number,
): Snippet {
  return {
    kind: 'gcloud',
    title: 'gcloud',
    language: 'bash',
    code: [
      commentLine(comment),
      ...UPDATE_NOTE,
      `gcloud composer environments update ${config.envId} \\`,
      '  --location LOCATION \\',
      `  ${flag} ${value}`,
    ].join('\n'),
  };
}

/** Sets a pool's slots with the Airflow CLI through `gcloud composer environments run`. */
export function gcloudPoolSet(
  config: EnvironmentConfig,
  comment: string,
  pool: string,
  slots: number | 'SLOTS',
): Snippet {
  return {
    kind: 'gcloud',
    title: 'gcloud (Airflow CLI)',
    language: 'bash',
    code: [
      commentLine(comment),
      '# Runs the Airflow CLI in the environment; the new slot count applies at once, without a restart.',
      "# Replace DESCRIPTION with the pool's current description, and add --include-deferred if the pool",
      '# counts deferred tasks. ⚠️ VERIFY that "pools set" is in the supported Airflow CLI commands of Composer 3.',
      `gcloud composer environments run ${config.envId} \\`,
      '  --location LOCATION \\',
      `  pools set -- ${shellWord(pool)} ${slots} "DESCRIPTION"`,
    ].join('\n'),
  };
}

/** Terraform worker sizing (Composer 3 `workloads_config`). */
export function terraformWorkers(
  config: EnvironmentConfig,
  comment: string,
  field: string,
  value: number,
): Snippet {
  return {
    kind: 'terraform',
    title: 'Terraform',
    language: 'hcl',
    code: [
      commentLine(comment),
      `resource "google_composer_environment" "${label(config.envId)}" {`,
      `  name   = "${config.envId}"`,
      '  region = "LOCATION"',
      '  config {',
      '    workloads_config {',
      '      worker {',
      '        # Keep cpu, memory_gb, storage_gb and the other counts at their current values.',
      `        ${field} = ${value}`,
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  };
}
