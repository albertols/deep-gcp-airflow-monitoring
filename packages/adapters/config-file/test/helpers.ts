import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach } from 'vitest';

/** A fictitious home directory: `~` expansion is pure string work, nothing is read from it. */
export const HOME = resolve('/home/acme');

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh temporary folder, removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dcam-config-'));
  dirs.push(dir);
  return dir;
}

/** Writes `text` to `<dir>/<name>` (creating folders) and returns the absolute path. */
export function writeFile(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** The smallest valid configuration: one Composer environment. */
export const MINIMAL = `version: 1
environments:
  - id: acme-prod
    projectId: acme-data-prod
    location: europe-west1
    environment: acme-prod
    tier: prod
`;
