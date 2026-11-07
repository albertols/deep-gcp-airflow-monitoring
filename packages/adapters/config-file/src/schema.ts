/**
 * Zod schema of `dcam.config.yaml`: the M1 subset of spec §17.2. The schema is the single source of the
 * file's shape, its defaults and the published JSON Schema (`dcam.config.schema.json`, spec §17.1).
 *
 * Keys that §17.2 documents but this version does not use are accepted as {@link NOT_USED_YET} so the
 * loader can warn about them; every other unknown key is an error (strict objects). Retention classes whose
 * data DCAM does not store yet (rollups, log signatures, findings) are validated and warned about too
 * ({@link VALIDATED_NOT_USED_YET}).
 *
 * @implements FR-SETUP-02, FR-SETUP-05, FR-STORE-02, FR-STORE-07
 */
import { z } from 'zod';
import {
  DEFAULT_DISK_BUDGET_GB,
  DEFAULT_RETENTION_DAYS,
  DISK_BUDGET_GB_LIMITS,
  RETENTION_DAY_LIMITS,
  type RetentionClass,
} from '@dcam/domain';
import type { EnvironmentEntry, Profile, ProfileCadences } from '@dcam/ports';

/** Marks a key documented in §17.2 that this version accepts and ignores (the loader warns). */
export const NOT_USED_YET = z
  .unknown()
  .optional()
  .describe('Documented in spec §17.2 but not used in this version of DCAM; it is ignored.');

/**
 * Settings that are validated, because a later version will use them, but ignored by this one: the loader
 * warns about them like {@link NOT_USED_YET} keys.
 */
export const VALIDATED_NOT_USED_YET: ReadonlySet<z.ZodType> = new Set();
const notUsedYet = <T extends z.ZodType>(schema: T): T => {
  (VALIDATED_NOT_USED_YET as Set<z.ZodType>).add(schema);
  return schema;
};

export const TIERS = [
  'dev',
  'test',
  'uat',
  'prod',
  'other',
] as const satisfies readonly EnvironmentEntry['tier'][];
export const PROFILES = ['live', 'standard', 'eco', 'off'] as const satisfies readonly Profile[];

/** Collector cadences in seconds (§17.2 `profiles`). */
export const DEFAULT_PROFILES = {
  // `airflowInventory` (the DAG list) is not in §17.2. §7.7 (L716) runs `af.inventory` every `airflowFacts` × 10:
  // 5 / 10 / 50 min on live / standard / eco. It starts a full listing at most once an hour (§7.5 L647, "trickled
  // across the hour"): about 2,000 DAGs are 20 pages an hour, about 0.3 requests a minute, as the §7.11
  // arithmetic for that profile assumes (L882). Import errors are read by `af.facts` every fact cycle (§7.5 L653).
  live: { airflowLive: 10, airflowFacts: 30, airflowInventory: 300, monitoring: 60, composer: 300 },
  standard: { airflowLive: 30, airflowFacts: 60, airflowInventory: 600, monitoring: 60, composer: 600 },
  eco: { airflowLive: 120, airflowFacts: 300, airflowInventory: 3000, monitoring: 300, composer: 1800 },
} as const satisfies Record<Exclude<Profile, 'off'>, ProfileCadences>;

/** Default request budgets (§17.2 `budgets`), in requests per minute. */
export const DEFAULT_BUDGETS = {
  airflowApi: { live: 60, standard: 12, eco: 4, background: 2, maxConcurrent: 2 },
  monitoringPerProjectPerMinute: 30,
  composerApiPerMinute: 6,
} as const;

/** Hard maxima of §7.11: configuration cannot raise a budget above these. */
export const HARD_MAXIMA = {
  airflowApiPerMinute: 120,
  airflowApiConcurrent: 4,
  monitoringPerProjectPerMinute: 120,
  composerApiPerMinute: 30,
} as const;

/** Backfill on first add (FR-COLL-04, §17.2 `environments[].backfill`), in days. */
export const DEFAULT_BACKFILL = { taskInstancesDays: 7, metricsDays: 14 } as const;

/**
 * Longest backfills: task instances up to the raw task instance retention (FR-STORE-02, 90 days; Composer 3
 * keeps 60 days of metadata by default, spec HM-019), metrics up to Cloud Monitoring's six weeks of Composer
 * metrics (spec §7.2 "Retention", Appendix A.1). The engine declares them too (`@dcam/application`); a
 * server test checks that both agree.
 */
export const BACKFILL_MAXIMA = { taskInstancesDays: 90, metricsDays: 42 } as const;

export const ENV_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Hosts on which basic authentication is acceptable (FR-EMU-02). `URL.hostname` keeps IPv6 brackets. */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

const COMPOSER_KEYS = ['projectId', 'location', 'environment'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Refinements below also run when sibling fields fail, so one pass reports every problem. */
const always = { when: () => true };

const seconds = (value: number, what: string) =>
  z.number().int().positive().default(value).describe(`${what}, in seconds.`);

function cadences(defaults: ProfileCadences, profile: string) {
  return z
    .strictObject({
      airflowLive: seconds(defaults.airflowLive, 'Live snapshot of pools and waiting task instances'),
      airflowFacts: seconds(
        defaults.airflowFacts,
        'Finished task instances (incremental facts) and import errors',
      ),
      airflowInventory: seconds(
        defaults.airflowInventory,
        'DAG list (a full listing starts at most once an hour)',
      ),
      monitoring: seconds(defaults.monitoring, 'Cloud Monitoring metrics'),
      composer: seconds(defaults.composer, 'Composer environment configuration'),
      bucket: NOT_USED_YET,
    })
    .prefault({})
    .describe(`Cadences of the ${profile} profile; keys you leave out keep their defaults.`);
}

const perMinute = (value: number, maximum: number, what: string) =>
  z
    .number()
    .positive()
    .max(maximum)
    .default(value)
    .describe(`${what}, in requests per minute (hard maximum ${maximum}).`);

const count = (what: string) => z.number().int().positive().describe(what);
const days = (value: number, maximum: number, what: string) =>
  z
    .number()
    .int()
    .min(0)
    .max(maximum)
    .default(value)
    .describe(`${what}, in days (0 turns it off, maximum ${maximum}).`);
const envVarName = (what: string) =>
  z
    .string()
    .regex(ENV_VAR_PATTERN)
    .describe(`Name of the environment variable that holds the ${what} (never the value itself).`);

const loopbackUrl = z
  .string()
  .describe('Airflow web server URL on this machine: http or https on 127.0.0.1, localhost or [::1].')
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'baseUrl is not a valid URL.', params: { hint: 'url' } });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        message: 'baseUrl must use http or https.',
        params: { hint: 'loopback' },
      });
    } else if (url.username !== '' || url.password !== '') {
      ctx.addIssue({
        code: 'custom',
        message: 'baseUrl must not contain a user name or password.',
        params: { hint: 'credentials' },
      });
    } else if (!LOOPBACK_HOSTS.includes(url.hostname)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'baseUrl must point at this machine (127.0.0.1, localhost or [::1]): basic authentication is allowed only on loopback.',
        params: { hint: 'loopback' },
      });
    }
  });

/** What each retention class holds (FR-STORE-02, §17.2 `retention`). */
const RETENTION_CLASSES: Readonly<
  Record<RetentionClass, { readonly what: string; readonly stored: boolean }>
> = {
  rawTaskInstancesDays: { what: 'Task instance tries', stored: true },
  rawMetricPointsDays: { what: 'Live snapshots, worker samples and first-seen ready times', stored: true },
  rollup5mDays: { what: '5-minute rollups (not stored by this version)', stored: false },
  rollup1hDays: { what: '1-hour rollups (not stored by this version)', stored: false },
  logSignaturesDays: { what: 'Log signatures (not stored by this version)', stored: false },
  findingsDays: { what: 'Findings and alert history (not stored by this version)', stored: false },
};

/** Days of one retention class, within DCAM's limits; classes DCAM does not store yet are warned about. */
function retentionDays<T extends z.ZodType>(
  key: RetentionClass,
  wrap: (days: z.ZodNumber, range: string, what: string) => T,
): T {
  const { min, max } = RETENTION_DAY_LIMITS[key];
  const { what, stored } = RETENTION_CLASSES[key];
  const schema = wrap(z.number().int().min(min).max(max), `${min} to ${max}`, what);
  return stored ? schema : notUsedYet(schema);
}

/** The workspace's days of each class, with the §17.2 default. */
const workspaceDays = (key: RetentionClass) =>
  retentionDays(key, (days, range, what) =>
    days.default(DEFAULT_RETENTION_DAYS[key]).describe(`${what}: days kept (${range}).`),
  );
/** An environment's days of each class; absent keeps the workspace value. */
const environmentDays = (key: RetentionClass) =>
  retentionDays(key, (days, range, what) =>
    days.optional().describe(`${what}: days kept for this environment (${range}).`),
  );

const retentionShape = <T extends z.ZodType>(build: (key: RetentionClass) => T) => ({
  rawTaskInstancesDays: build('rawTaskInstancesDays'),
  rawMetricPointsDays: build('rawMetricPointsDays'),
  rollup5mDays: build('rollup5mDays'),
  rollup1hDays: build('rollup1hDays'),
  logSignaturesDays: build('logSignaturesDays'),
  findingsDays: build('findingsDays'),
});

export const environmentRetentionSchema = z
  .strictObject(retentionShape(environmentDays))
  .describe("Retention of this environment's data; a class you leave out keeps the workspace value.");

export const airflowSourceSchema = z
  .strictObject({
    baseUrl: loopbackUrl,
    usernameEnv: envVarName('Airflow user name'),
    passwordEnv: envVarName('Airflow password'),
    limits: z
      .strictObject({
        parallelism: count('`[core] parallelism`.'),
        schedulers: count('Number of schedulers.'),
        maxActiveTasksPerDag: count('`[core] max_active_tasks_per_dag`.'),
        maxActiveRunsPerDag: count('`[core] max_active_runs_per_dag`.'),
        workerConcurrency: count('`[celery] worker_concurrency`.'),
        workers: count('Number of Celery workers.'),
      })
      .describe('Airflow limits, which a self-managed Airflow has no Composer API to read from.'),
  })
  .describe('A self-managed Airflow on this machine, such as the emulator (FR-EMU-02).');

export const environmentEntrySchema = z
  .strictObject({
    id: z
      .string()
      .regex(ENV_ID_PATTERN)
      .describe('DCAM slug used in URLs and the API, for example acme-prod.'),
    displayName: z.string().min(1).optional().describe('Name shown in the UI; defaults to the id.'),
    tier: z.enum(TIERS).default('other'),
    profile: z
      .enum(PROFILES)
      .optional()
      .describe('Collection profile; defaults to standard for the prod tier and eco for every other tier.'),
    projectId: z.string().min(1).optional().describe('Google Cloud project of the Composer environment.'),
    location: z
      .string()
      .min(1)
      .optional()
      .describe('Region of the Composer environment, for example europe-west1.'),
    environment: z.string().min(1).optional().describe('Composer environment name.'),
    airflow: airflowSourceSchema.optional(),
    color: NOT_USED_YET,
    team: NOT_USED_YET,
    impersonateServiceAccount: NOT_USED_YET,
    collectors: NOT_USED_YET,
    backfill: z
      .strictObject({
        taskInstancesDays: days(
          DEFAULT_BACKFILL.taskInstancesDays,
          BACKFILL_MAXIMA.taskInstancesDays,
          'Days of finished task instances (and so DAG runs) read when DCAM first collects this environment',
        ),
        metricsDays: days(
          DEFAULT_BACKFILL.metricsDays,
          BACKFILL_MAXIMA.metricsDays,
          'Days of Cloud Monitoring worker metrics read when DCAM first collects this environment',
        ),
      })
      .prefault({})
      .describe(
        'Backfill on first add (FR-COLL-04): history DCAM reads in the background, within the request budget.',
      ),
    retention: environmentRetentionSchema.optional(),
  })
  .describe(
    'One monitored environment: either a Composer environment (projectId, location, environment) or an airflow block.',
  )
  .superRefine((entry, ctx) => {
    if (!isRecord(entry)) return;
    const present = COMPOSER_KEYS.filter((k) => entry[k] !== undefined);
    if (entry['airflow'] !== undefined) {
      if (present.length > 0)
        ctx.addIssue({
          code: 'custom',
          path: ['airflow'],
          message: `This environment has an airflow block and ${present.join(', ')}; an environment has exactly one source.`,
          params: { hint: 'one-source' },
        });
      return;
    }
    for (const key of COMPOSER_KEYS)
      if (entry[key] === undefined)
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is missing: a Composer environment needs projectId, location and environment.`,
          params: { hint: 'composer' },
        });
  }, always);

/**
 * An optional mapping whose fields all have defaults or are optional, so a missing section parses as `{}` and
 * gets every default. TypeScript cannot see that for a generic shape, hence the cast; the FR-SETUP-05 defaults
 * test proves it for every section.
 */
const section = <T extends z.ZodRawShape>(shape: T, description: string) =>
  z
    .strictObject(shape)
    .prefault({} as z.input<z.ZodObject<T, z.core.$strict>>)
    .describe(description);

export const configFileSchema = z
  .strictObject({
    version: z.literal(1).describe('Version of this file format.'),
    workspace: section(
      {
        name: NOT_USED_YET,
        dataDir: z
          .string()
          .min(1)
          .default('~/.dcam/data')
          .describe(
            'Folder for the DuckDB store and backups (owner-only). `~` is your home folder; a relative path is relative to this file. DCAM_DATA_DIR overrides it.',
          ),
        displayTimezone: NOT_USED_YET,
        stateColours: NOT_USED_YET,
      },
      'Workspace settings.',
    ),
    auth: section(
      {
        quotaProjectId: z
          .string()
          .min(1)
          .nullable()
          .default(null)
          .describe(
            'Project billed for Google API quota; null uses each environment’s own project (FR-AUTH-04).',
          ),
      },
      'Authentication. DCAM uses your Application Default Credentials.',
    ),
    network: section(
      {
        proxy: z
          .literal('from-env')
          .default('from-env')
          .describe('from-env honours HTTPS_PROXY, HTTP_PROXY and NO_PROXY.'),
        caBundlePath: z
          .string()
          .min(1)
          .nullable()
          .default(null)
          .describe(
            'PEM bundle for TLS-inspecting proxies; NODE_EXTRA_CA_CERTS is honoured as well (FR-AUTH-07).',
          ),
      },
      'Network settings for Google API and Airflow calls.',
    ),
    profiles: section(
      {
        live: cadences(DEFAULT_PROFILES.live, 'live'),
        standard: cadences(DEFAULT_PROFILES.standard, 'standard'),
        eco: cadences(DEFAULT_PROFILES.eco, 'eco'),
        background: NOT_USED_YET,
      },
      'Collector cadences per profile, in seconds (FR-SETUP-05).',
    ),
    budgets: section(
      {
        airflowApi: section(
          {
            live: perMinute(
              DEFAULT_BUDGETS.airflowApi.live,
              HARD_MAXIMA.airflowApiPerMinute,
              'Airflow API, live profile',
            ),
            standard: perMinute(
              DEFAULT_BUDGETS.airflowApi.standard,
              HARD_MAXIMA.airflowApiPerMinute,
              'Airflow API, standard profile',
            ),
            eco: perMinute(
              DEFAULT_BUDGETS.airflowApi.eco,
              HARD_MAXIMA.airflowApiPerMinute,
              'Airflow API, eco profile',
            ),
            background: perMinute(
              DEFAULT_BUDGETS.airflowApi.background,
              HARD_MAXIMA.airflowApiPerMinute,
              'Airflow API, the share guaranteed to background work (inventory refreshes, backfill) within the profile budget and at most half of it; background work also uses spare capacity',
            ),
            maxConcurrent: z
              .number()
              .int()
              .positive()
              .max(HARD_MAXIMA.airflowApiConcurrent)
              .default(DEFAULT_BUDGETS.airflowApi.maxConcurrent)
              .describe(
                `Airflow API requests in flight at once (hard maximum ${HARD_MAXIMA.airflowApiConcurrent}).`,
              ),
          },
          'Airflow API budget per environment.',
        ),
        monitoring: section(
          {
            perProjectPerMinute: perMinute(
              DEFAULT_BUDGETS.monitoringPerProjectPerMinute,
              HARD_MAXIMA.monitoringPerProjectPerMinute,
              'Cloud Monitoring, per project, on the live and standard profiles',
            ),
          },
          'Cloud Monitoring budget. The eco profile gets a third of it, background work a sixth (spec §7.11).',
        ),
        composerApi: section(
          {
            perMinute: perMinute(
              DEFAULT_BUDGETS.composerApiPerMinute,
              HARD_MAXIMA.composerApiPerMinute,
              'Composer API, per environment, on the live and standard profiles',
            ),
          },
          'Composer API budget. The eco profile gets a third of it (spec §7.11).',
        ),
        logging: NOT_USED_YET,
        gcs: NOT_USED_YET,
        patientMode: NOT_USED_YET,
      },
      'Request budgets (spec §7.11). Values above the hard maxima are rejected.',
    ),
    environments: z
      .array(environmentEntrySchema)
      .min(1)
      .describe('The environments DCAM monitors.')
      .superRefine((entries, ctx) => {
        const seen = new Map<string, number>();
        entries.forEach((entry, i) => {
          const id: unknown = isRecord(entry) ? entry['id'] : undefined;
          if (typeof id !== 'string') return;
          const first = seen.get(id);
          if (first === undefined) seen.set(id, i);
          else
            ctx.addIssue({
              code: 'custom',
              path: [i, 'id'],
              message: `id ${id} is already used by environments.${first}.`,
              params: { hint: 'unique-id' },
            });
        });
      }, always),
    server: NOT_USED_YET,
    tiers: NOT_USED_YET,
    discovery: NOT_USED_YET,
    retention: section(
      {
        ...retentionShape(workspaceDays),
        diskBudgetGb: z
          .number()
          .min(DISK_BUDGET_GB_LIMITS.min)
          .max(DISK_BUDGET_GB_LIMITS.max)
          .default(DEFAULT_DISK_BUDGET_GB)
          .describe(
            `Disk budget of the local store, in GB (${DISK_BUDGET_GB_LIMITS.min} to ${DISK_BUDGET_GB_LIMITS.max}; 1 GB is 10^9 bytes). From 90 % of it DCAM warns, thins live snapshots older than 24 h, then deletes the oldest data (FR-STORE-07).`,
          ),
      },
      'How long DCAM keeps collected data, and the disk budget of its store (FR-STORE-02, FR-STORE-07).',
    ),
    teams: NOT_USED_YET,
    cost: NOT_USED_YET,
    advisor: NOT_USED_YET,
    alerting: NOT_USED_YET,
    ai: NOT_USED_YET,
    redaction: NOT_USED_YET,
    features: NOT_USED_YET,
  })
  .meta({
    title: 'DCAM workspace configuration',
    description:
      'dcam.config.yaml (spec §17). Generated from the Zod schema in @dcam/config-file; do not edit.',
  });

export type ConfigFile = z.output<typeof configFileSchema>;

/** The published JSON Schema (spec §17.1), generated from {@link configFileSchema}. */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(configFileSchema, {
    io: 'input',
    target: 'draft-2020-12',
    override: (ctx) => {
      // Refinements are not representable; spell out "exactly one source" for editors.
      if (ctx.zodSchema === environmentEntrySchema)
        ctx.jsonSchema.oneOf = [{ required: [...COMPOSER_KEYS] }, { required: ['airflow'] }];
    },
  });
}

/** The committed `dcam.config.schema.json` text: {@link configJsonSchema} as JSON, two-space indent, final newline. */
export function renderConfigJsonSchema(): string {
  return `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
}
