#!/usr/bin/env node
// PreToolUse(Edit|MultiEdit|Write) guard for DCAM (§21.5). Exit code 2 blocks the edit.
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const maintenance = process.env.DCAM_HARNESS_MAINTENANCE === '1';

const RULES = [
  [/(^|\/)\.env(?!\.example$)[^/]*$|\.(pem|key|p12)$|(^|\/)\.ssh\//, 'credential-like files are never edited in a Claude Code session'],
  [/^pnpm-lock\.yaml$/, 'change dependencies with pnpm commands instead of editing the lockfile'],
  [/^packages\/contracts\/generated\//, 'this is generated code: edit packages/contracts/openapi.yaml and regenerate'],
  [/(^|\/)(\.dcam-denylist|dcam\.config\.yaml)$/, 'these files hold real environment identifiers and stay out of Claude Code sessions (spec §18.12)'],
  [/^\.claude\/(hooks\/|settings(\.local)?\.json$)|^\.mcp\.json$/, 'guardrails change only in harness maintenance mode (DCAM_HARNESS_MAINTENANCE=1, set by a human)', () => !maintenance],
];

function block(reason) {
  process.stderr.write(`Blocked by the DCAM path guard: ${reason}. See spec §21.5.\n`);
  process.exit(2);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  block('could not read the hook input');
}
const { tool_name: tool, tool_input: ti = {} } = input;
const abs = resolve(root, ti.file_path ?? '');
const rel = relative(root, abs);

if (rel.startsWith('..') || isAbsolute(rel)) {
  const scratch = [resolve(tmpdir()), '/tmp', '/private/tmp'].some((d) => abs.startsWith(`${d}/`));
  if (!scratch) block(`edits outside the repository are not allowed (${abs})`);
  process.exit(0);
}
for (const [pattern, reason, applies = () => true] of RULES) if (pattern.test(rel) && applies()) block(reason);

// Accepted ADRs are immutable; only the status line may change (for "superseded by ADR-NNNN").
if (/^docs\/adr\/\d{4}-.*\.md$/.test(rel) && existsSync(abs) && /^status:\s*"?accepted/m.test(readFileSync(abs, 'utf8'))) {
  const edits = tool === 'MultiEdit' ? ti.edits ?? [] : tool === 'Edit' ? [ti] : null;
  const statusOnly = edits?.every((e) => /^status:[^\n]*$/.test(e.old_string ?? '') && /^status:[^\n]*$/.test(e.new_string ?? ''));
  if (!statusOnly) block('accepted ADRs are immutable: write a new ADR that supersedes this one, then change only its status line');
}
