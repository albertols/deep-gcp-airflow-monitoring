/**
 * Writes `dcam.config.schema.json` from the Zod schema (spec §17.1). Run with `pnpm gen`; a test fails while the
 * committed file is stale.
 *
 * @implements FR-SETUP-02
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderConfigJsonSchema } from '../src/schema';

const target = fileURLToPath(new URL('../dcam.config.schema.json', import.meta.url));
writeFileSync(target, renderConfigJsonSchema());
console.log(`wrote ${target}`);
