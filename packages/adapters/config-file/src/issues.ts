/**
 * Turns schema problems into {@link ConfigIssue}s that name the dotted path and say what to do (spec §12.12),
 * and finds keys that §17.2 documents but this version ignores (warnings).
 *
 * Messages are built from the issue code, the path and the schema, never from the value in the file: a value
 * in the wrong place may be a secret pasted by mistake (FR-SETUP-07). Key names are repeated, values are not.
 *
 * @implements FR-SETUP-02, FR-SETUP-05
 */
import type { ConfigIssue } from '@dcam/ports';
import { z } from 'zod';
import { ENV_ID_PATTERN, ENV_VAR_PATTERN, NOT_USED_YET, configFileSchema } from './schema';

type Path = readonly PropertyKey[];
type Schema = z.core.$ZodType;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const dotted = (path: Path): string => path.map(String).join('.');
const keyName = (path: Path): string => {
  const last = [...path].reverse().find((k) => typeof k === 'string');
  return last === undefined ? 'this value' : String(last);
};

function unwrap(schema: Schema): Schema {
  let s = schema;
  while (
    s instanceof z.ZodOptional ||
    s instanceof z.ZodNullable ||
    s instanceof z.ZodDefault ||
    s instanceof z.ZodPrefault
  )
    s = s.unwrap();
  return s;
}

/** The fields of an object schema (through optional, default and prefault wrappers). */
function shapeOf(schema: Schema): Readonly<Record<string, Schema>> | undefined {
  const s = unwrap(schema);
  return s instanceof z.ZodObject ? (s as z.ZodObject<Record<string, Schema>>).shape : undefined;
}

/** The item schema of an array schema (through the same wrappers). */
function elementOf(schema: Schema): Schema | undefined {
  const s = unwrap(schema);
  return s instanceof z.ZodArray ? (s as z.ZodArray<Schema>).element : undefined;
}

const fieldOf = (shape: Readonly<Record<string, Schema>>, key: string): Schema | undefined =>
  Object.hasOwn(shape, key) ? shape[key] : undefined;

function child(schema: Schema, key: PropertyKey): Schema | undefined {
  if (typeof key === 'number') return elementOf(schema);
  const shape = shapeOf(schema);
  return shape !== undefined && typeof key === 'string' ? fieldOf(shape, key) : undefined;
}

function schemaAt(path: Path): Schema | undefined {
  let s: Schema | undefined = configFileSchema;
  for (const key of path) s = s === undefined ? undefined : child(s, key);
  return s;
}

function valueAt(root: unknown, path: Path): unknown {
  let v = root;
  for (const key of path) {
    if (Array.isArray(v) && typeof key === 'number') v = v[key];
    else if (isRecord(v) && typeof key === 'string') v = Object.hasOwn(v, key) ? v[key] : undefined;
    else return undefined;
  }
  return v;
}

const description = (schema: Schema | undefined): string | undefined =>
  schema instanceof z.ZodType ? (schema.description ?? (unwrap(schema) as z.ZodType).description) : undefined;

/** Levenshtein distance (insertions, deletions and substitutions) between two lower-cased keys. */
function distance(x: string, y: string): number {
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++)
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[y.length] ?? 0;
}

/** How far `key` is from `candidate`: a key inside the other (`timezone`, `displayTimezone`) counts as one edit. */
const remoteness = (key: string, candidate: string): number => {
  const [a, b] = [key.toLowerCase(), candidate.toLowerCase()];
  return a !== b && (a.includes(b) || b.includes(a)) ? 1 : distance(a, b);
};

function unknownKeyHint(parent: Path, key: string): string {
  const s = schemaAt(parent);
  const shape = (s === undefined ? undefined : shapeOf(s)) ?? {};
  const known = Object.keys(shape);
  const read = known.filter((k) => fieldOf(shape, k) !== NOT_USED_YET);
  const closest = known.toSorted((a, b) => remoteness(key, a) - remoteness(key, b))[0];
  if (closest === undefined) return 'Remove it.';
  const near = remoteness(key, closest) <= Math.max(2, Math.ceil(key.length / 3));
  const suggestion = near
    ? `Did you mean \`${closest}\`?`
    : `Remove it; the closest known key is \`${closest}\`.`;
  return `${suggestion} Keys this version reads here: ${read.join(', ')}.`;
}

const TYPE_WORDS: Readonly<Record<string, string>> = {
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  object: 'a mapping (indented key: value lines)',
  array: 'a list (lines starting with -)',
};

/** Fix hints for the refinements in schema.ts, keyed by their `params.hint`. */
const CUSTOM_HINTS: Readonly<Record<string, string>> = {
  url: 'Write a full URL such as http://127.0.0.1:8080.',
  loopback:
    'Use http://127.0.0.1:<port>, http://localhost:<port> or http://[::1]:<port>. For a Composer environment, use projectId, location and environment instead of an airflow block.',
  credentials:
    'Remove the user name and password from the URL; put them in environment variables and name those in usernameEnv and passwordEnv.',
  'one-source':
    'Keep projectId, location and environment for a Composer environment, or the airflow block for a self-managed Airflow, not both.',
  composer:
    'Add the projectId, location and environment of the Composer environment, as shown in the Google Cloud console, or an airflow block for a self-managed Airflow.',
  'unique-id': 'Give each environment a different id.',
};

const SEE_EXAMPLE = 'See dcam.config.example.yaml and spec §17.2 for the accepted values.';

function missing(path: Path, schema: Schema | undefined): ConfigIssue {
  const key = keyName(path);
  if (path.length === 1 && key === 'version')
    return {
      path: 'version',
      message: 'version is missing.',
      fixHint: 'Add `version: 1` at the top of the file.',
    };
  const parent = dotted(path.slice(0, -1));
  const what = description(schema);
  return {
    path: dotted(path),
    message: `${key} is missing.`,
    fixHint: `Add ${key} ${parent === '' ? 'at the top level' : `under ${parent}`}.${what === undefined ? '' : ` ${what}`}`,
  };
}

function convert(issue: z.core.$ZodIssue, input: unknown): ConfigIssue[] {
  const path = issue.path;
  const key = keyName(path);
  const at = dotted(path);
  const schema = schemaAt(path);
  const absent = valueAt(input, path) === undefined;

  switch (issue.code) {
    case 'unrecognized_keys':
      return issue.keys.map((k) => ({
        path: dotted([...path, k]),
        message: `${k} is not a setting DCAM knows.`,
        fixHint: unknownKeyHint(path, k),
      }));
    case 'invalid_type': {
      if (absent) return [missing(path, schema)];
      const expected = TYPE_WORDS[issue.expected] ?? issue.expected;
      return [
        {
          path: at,
          message: `${key} must be ${expected}.`,
          fixHint: `Change ${key} to ${expected}. ${SEE_EXAMPLE}`,
        },
      ];
    }
    case 'invalid_value': {
      if (absent) return [missing(path, schema)];
      if (at === 'version')
        return [
          {
            path: at,
            message: 'version must be 1, the only version of this file format.',
            fixHint: 'Set `version: 1`.',
          },
        ];
      const allowed = issue.values.map(String).join(', ');
      return [{ path: at, message: `${key} must be one of ${allowed}.`, fixHint: `Use one of: ${allowed}.` }];
    }
    case 'too_big': {
      const max = String(issue.maximum);
      if (path[0] === 'budgets') {
        const unit = key === 'maxConcurrent' ? 'requests in flight' : 'requests per minute';
        return [
          {
            path: at,
            message: `${key} is above the hard maximum of ${max} ${unit} (spec §7.11).`,
            fixHint: `Use ${max} or less. Hard maxima protect the monitored environment and cannot be raised.`,
          },
        ];
      }
      return [{ path: at, message: `${key} must be at most ${max}.`, fixHint: `Use ${max} or less.` }];
    }
    case 'too_small': {
      if (issue.origin === 'array')
        return [
          {
            path: at,
            message: `${key} is empty.`,
            fixHint:
              'List at least one environment with id, projectId, location and environment (see dcam.config.example.yaml).',
          },
        ];
      if (issue.origin === 'string')
        return [
          { path: at, message: `${key} is empty.`, fixHint: `Write a value for ${key}, or remove the line.` },
        ];
      const bound = `${issue.inclusive ? 'at least' : 'greater than'} ${String(issue.minimum)}`;
      return [{ path: at, message: `${key} must be ${bound}.`, fixHint: `Use a number ${bound}.` }];
    }
    case 'invalid_format': {
      if (issue.pattern === String(ENV_ID_PATTERN))
        return [
          {
            path: at,
            message: `${key} has characters that are not allowed.`,
            fixHint:
              'Use 1 to 63 characters: lowercase letters, digits and hyphens, starting with a letter or digit, for example acme-prod.',
          },
        ];
      if (issue.pattern === String(ENV_VAR_PATTERN))
        return [
          {
            path: at,
            message: `${key} must be the name of an environment variable.`,
            fixHint:
              'Write the name of an environment variable (letters, digits and _, not starting with a digit), such as DCAM_AIRFLOW_PASSWORD, and put the value in that environment variable.',
          },
        ];
      return [{ path: at, message: `${key} is not in the expected format.`, fixHint: SEE_EXAMPLE }];
    }
    case 'custom': {
      const params: unknown = issue.params;
      const hint =
        isRecord(params) && typeof params['hint'] === 'string' ? CUSTOM_HINTS[params['hint']] : undefined;
      return [{ path: at, message: issue.message, fixHint: hint ?? SEE_EXAMPLE }];
    }
    default:
      return [{ path: at, message: `${key} is not valid.`, fixHint: SEE_EXAMPLE }];
  }
}

/** One or more issues per Zod issue (an unknown-keys issue lists several keys), in file order of the paths. */
export function schemaIssues(error: z.ZodError, input: unknown): ConfigIssue[] {
  return error.issues.flatMap((issue) => convert(issue, input));
}

/** Warnings for keys that §17.2 documents but this version does not use. Empty values count as absent. */
export function unusedKeyWarnings(input: unknown): ConfigIssue[] {
  const warnings: ConfigIssue[] = [];
  const visit = (schema: Schema, value: unknown, path: Path) => {
    const shape = shapeOf(schema);
    const element = elementOf(schema);
    if (shape !== undefined && isRecord(value)) {
      for (const [k, v] of Object.entries(value)) {
        const field = fieldOf(shape, k);
        if (field === undefined || v === null || v === undefined) continue;
        if (field === NOT_USED_YET)
          warnings.push({
            path: dotted([...path, k]),
            message: `${k} is not used by this version of DCAM and is ignored (spec §17.2 documents it for a later version).`,
            fixHint: `Remove ${k} to silence this warning, or keep it for a later version.`,
          });
        else visit(field, v, [...path, k]);
      }
    } else if (element !== undefined && Array.isArray(value))
      value.forEach((v, i) => visit(element, v, [...path, i]));
  };
  visit(configFileSchema, input, []);
  return warnings;
}
