/** Ajv validation against openapi.yaml (ADR-0003), shared by the tests of the feature-002 endpoints. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const spec = parse(
  readFileSync(fileURLToPath(import.meta.resolve('@dcam/contracts/openapi.yaml')), 'utf8'),
) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
ajv.addSchema({ ...spec, $id: 'dcam' });

/** `true` when `body` conforms to the named component schema, otherwise Ajv's errors. */
export function conforms(schema: string, body: unknown) {
  const validate = ajv.getSchema(`dcam#/components/schemas/${schema}`);
  if (!validate) throw new Error(`no schema ${schema}`);
  return validate(body) ? true : validate.errors;
}
