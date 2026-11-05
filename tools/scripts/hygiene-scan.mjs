#!/usr/bin/env node
// Public-repository hygiene scan (spec §18.12, NFR-OSS-02). Fails when a tracked or staged file
// contains an identifier from the maintainer's git-ignored .dcam-denylist, or a generic pattern that
// looks like a real Google Cloud identifier or secret. Matches are reported redacted.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Values that are clearly placeholders are allowed in docs, tests and examples. */
const PLACEHOLDER = /acme|PROJECT_ID|abc123|(^|[/@.-])abc\.|example|<[^>]+>|\$\{/i;

export const GENERIC_PATTERNS = [
  { id: 'service-account', re: /[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/gi, placeholderOk: true },
  {
    id: 'composer-airflow-host',
    re: /[a-z0-9-]+-dot-[a-z0-9-]+\.composer\.googleusercontent\.com/gi,
    placeholderOk: true,
  },
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g, placeholderOk: false },
  { id: 'oauth-access-token', re: /ya29\.[0-9A-Za-z_-]{20,}/g, placeholderOk: false },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, placeholderOk: false },
];

/** Parses .dcam-denylist: one literal or /regex/flags per line; # starts a comment. */
export function parseDenylist(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = /^\/(.+)\/([a-z]*)$/.exec(l);
      const re = m
        ? new RegExp(m[1], m[2].includes('g') ? m[2] : `${m[2]}g`)
        : new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return { id: 'denylist', re, placeholderOk: false };
    });
}

export const ALLOW_MARKER = 'hygiene-scan: allow';

const redact = (s) => (s.length <= 6 ? '***' : `${s.slice(0, 3)}…${s.slice(-2)}`);

/** Returns findings `{ line, id, sample }` for one file's text. */
export function scanText(text, patterns) {
  const findings = [];
  text.split('\n').forEach((line, i) => {
    // Deliberate fixtures (for example in this scan's own tests) carry an explicit, reviewable marker.
    if (line.includes(ALLOW_MARKER)) return;
    for (const p of patterns) {
      p.re.lastIndex = 0;
      for (const m of line.matchAll(p.re)) {
        if (p.placeholderOk && PLACEHOLDER.test(m[0])) continue;
        findings.push({ line: i + 1, id: p.id, sample: redact(m[0]) });
      }
    }
  });
  return findings;
}

const SKIP = /(^|\/)(pnpm-lock\.yaml|\.dcam-denylist)$|\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf)$/i;

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const denylistPath = join(root, '.dcam-denylist');
  const patterns = [
    ...GENERIC_PATTERNS,
    ...(existsSync(denylistPath) ? parseDenylist(readFileSync(denylistPath, 'utf8')) : []),
  ];
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    // Nested repositories (such as agent worktrees) are listed as directories: skip them.
    .filter((f) => f && !SKIP.test(f) && existsSync(join(root, f)) && statSync(join(root, f)).isFile());
  let count = 0;
  for (const file of files) {
    for (const f of scanText(readFileSync(join(root, file), 'utf8'), patterns)) {
      count++;
      console.error(`${file}:${f.line}  ${f.id}  ${f.sample}`);
    }
  }
  if (count > 0) {
    console.error(
      `\nHygiene scan failed: ${count} finding(s). Replace real identifiers with fictitious "acme-*" values (spec §18.12).`,
    );
    process.exit(1);
  }
  console.log(`Hygiene scan passed (${files.length} files, ${patterns.length} patterns).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
