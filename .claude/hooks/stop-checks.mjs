#!/usr/bin/env node
// Stop hook for DCAM (§21.5): Claude keeps working until typecheck and the affected tests pass.
// Exit code 2 blocks stopping and shows stderr to Claude; after three attempts it hands over to a human.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_ATTEMPTS = 3;
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const counterFile = join(root, '.claude', '.stop-attempts'); // git-ignored

const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const input = JSON.parse(read(0) || '{}');
const attempts = input.stop_hook_active ? Number(read(counterFile)) || 0 : 0;

const changed = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
if (!changed) {
  rmSync(counterFile, { force: true });
  process.exit(0);
}

for (const task of ['typecheck', 'test']) {
  const run = spawnSync('pnpm', ['turbo', 'run', task, '--filter=...[HEAD]', '--output-logs=errors-only'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status === 0) continue;
  const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
  if (attempts + 1 >= MAX_ATTEMPTS) {
    rmSync(counterFile, { force: true });
    process.stderr.write(`"${task}" is still failing after ${MAX_ATTEMPTS} attempts. Stopping so a human can take a look.\n${tail}\n`);
    process.exit(1); // non-blocking: shown to the user
  }
  writeFileSync(counterFile, String(attempts + 1));
  process.stderr.write(
    `"pnpm turbo run ${task}" fails for the changed packages (attempt ${attempts + 1} of ${MAX_ATTEMPTS}). Fix it before finishing:\n${tail}\n`,
  );
  process.exit(2);
}
// Public-repository hygiene (spec §18.12): never finish with real identifiers in the working tree.
const hygiene = spawnSync('node', ['tools/scripts/hygiene-scan.mjs'], { cwd: root, encoding: 'utf8' });
if (hygiene.status !== 0) {
  process.stderr.write(`The hygiene scan found real identifiers or secrets. Replace them before finishing:\n${hygiene.stderr}\n`);
  process.exit(2);
}
rmSync(counterFile, { force: true });
