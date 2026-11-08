/**
 * Reads the YAML text of `dcam.config.yaml` into plain values. Syntax problems become {@link ConfigIssue}s with
 * line and column. The `yaml` library's own messages quote the offending line (a code frame) and sometimes
 * the token, which could be a secret pasted by mistake, so issues are built from the error code and position
 * only and never repeat text from the file.
 *
 * @implements FR-SETUP-02
 */
import type { ConfigIssue } from '@dcam/ports';
import { parseDocument, type ErrorCode, type YAMLError } from 'yaml';

export type YamlRead =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly issues: ConfigIssue[] };

/** Aliases expand on read; a small cap stops a "billion laughs" file from exhausting memory. */
const MAX_ALIAS_COUNT = 50;

const PLAIN_VALUE_HINT =
  'Write a plain value without a tag. Secrets never go in this file: name an environment variable instead (for example passwordEnv).';
const GENERIC_HINT =
  'Check the indentation (spaces, not tabs), the colon and space after each key, and put quotes around values that contain ": " or " #".';

const BY_CODE: Readonly<Partial<Record<ErrorCode, { readonly message: string; readonly fixHint: string }>>> =
  {
    DUPLICATE_KEY: {
      message: 'this key appears twice in the same mapping; YAML keys must be unique.',
      fixHint: 'Keep one of the two entries and delete the other.',
    },
    BAD_INDENT: {
      message: 'the indentation does not line up with the lines around it, or a [ or { is not closed.',
      fixHint:
        'Indent with spaces, start every key of one mapping (and every - of one list) in the same column, and close every [ and {.',
    },
    TAB_AS_INDENT: { message: 'a tab is used for indentation.', fixHint: 'Indent with spaces only.' },
    MISSING_CHAR: {
      message: 'a character YAML expects is missing, such as a closing quote or the - of a list item.',
      fixHint:
        'Check this line and the one above: close every quote, start each list item with "- ", and line keys up with their neighbours.',
    },
    TAG_RESOLVE_FAILED: {
      message: 'YAML tags (such as !name) are not supported.',
      fixHint: PLAIN_VALUE_HINT,
    },
    MULTIPLE_DOCS: {
      message: 'the file contains more than one YAML document.',
      fixHint: 'Remove the --- separator so the file holds one document.',
    },
    BAD_ALIAS: {
      message: 'an alias (*name) refers to an anchor that does not exist.',
      fixHint: GENERIC_HINT,
    },
    MULTILINE_IMPLICIT_KEY: { message: 'a key spans more than one line.', fixHint: GENERIC_HINT },
  };

function yamlIssue(error: YAMLError): ConfigIssue {
  const known = BY_CODE[error.code];
  const at = error.linePos?.[0];
  const where = at ? ` at line ${at.line}, column ${at.col}` : '';
  return {
    path: '',
    message: `YAML syntax error${where}: ${known?.message ?? 'this is not valid YAML.'}`,
    fixHint: known?.fixHint ?? GENERIC_HINT,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses `text`; warnings (such as unknown tags) are errors too, because they change what a value means. */
export function readYaml(text: string): YamlRead {
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length > 0) return { ok: false, issues: problems.map(yamlIssue) };

  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch {
    // toJS throws for an alias without an anchor and for more than MAX_ALIAS_COUNT aliases.
    return {
      ok: false,
      issues: [
        {
          path: '',
          message: `The file uses a YAML alias (*name) that has no anchor, or more than ${MAX_ALIAS_COUNT} aliases.`,
          fixHint:
            'Write the values out instead of repeating them through anchors (&name) and aliases (*name).',
        },
      ],
    };
  }
  if (value === null || value === undefined)
    return {
      ok: false,
      issues: [
        {
          path: '',
          message: 'The configuration file is empty.',
          fixHint: 'Start from dcam.config.example.yaml: it has version: 1 and one environment to fill in.',
        },
      ],
    };
  if (!isRecord(value))
    return {
      ok: false,
      issues: [
        {
          path: '',
          message:
            'The configuration file must be a YAML mapping (key: value lines), not a list or a single value.',
          fixHint:
            'Start the file with `version: 1` and an `environments:` list, as in dcam.config.example.yaml.',
        },
      ],
    };
  return { ok: true, value };
}
