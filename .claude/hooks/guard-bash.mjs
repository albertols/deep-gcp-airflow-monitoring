#!/usr/bin/env node
// PreToolUse(Bash) guard for DCAM (§21.5). Blocks commands that could change cloud
// resources, expose credentials or data, or rewrite shared Git history.
// Exit code 2 blocks the call; stderr is shown to Claude. One layer of defence, not a sandbox.
import { readFileSync } from 'node:fs';

const CLOUD_READ = process.env.DCAM_HARNESS_CLOUD_READ === '1';
const MAINTENANCE = process.env.DCAM_HARNESS_MAINTENANCE === '1';
const MAX_DEPTH = 3;
const SUBST = '__DCAM_SUBST__';

const CREDENTIALS =
  /\.config\/gcloud|application_default_credentials|\.ssh\/|\.netrc|\.git-credentials|\.docker\/config\.json|\.kube\/config|\.(pem|key|p12)\b|(^|[\s/'"=])\.env(?!\.example\b)\b/i;
const HARNESS = /\.claude\/(settings[^/\s]*\.json|hooks\/)|\.mcp\.json|DCAM_HARNESS_/;
const CLOUD_HOSTS = /googleapis\.com|googleusercontent\.com|metadata\.google\.internal|169\.254\.169\.254/i;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PREFIXES = new Set(['env', 'exec', 'time', 'nice', 'nohup', 'command', 'builtin', 'timeout', 'stdbuf']);
const NEEDS_HUMAN = new Set(['sudo', 'doas', 'su']);
const UNVERIFIABLE = new Set(['eval', 'source', '.']);
const GCLOUD_READ_VERBS = new Set(['list', 'describe', 'ls']);
const GCLOUD_READ_COMMANDS = ['config list', 'auth list', 'version', 'info', 'help'];
const NOT_ALLOWED_DEFAULT =
  'cloud CLIs are blocked in Claude Code sessions. A maintainer can enable read-only verification with DCAM_HARNESS_CLOUD_READ=1 (§21.4)';

const positional = (args) => args.filter((a) => !a.startsWith('-'));

const RULES = {
  gcloud(args) {
    const words = positional(args).join(' ');
    if (/\bprint-(access|identity)-token\b/.test(words)) return 'it prints a credential; tokens must never enter a transcript';
    if (!CLOUD_READ) return NOT_ALLOWED_DEFAULT;
    if (GCLOUD_READ_COMMANDS.some((c) => words === c || words.startsWith(`${c} `))) return null;
    const pos = positional(args);
    const format = args.map((a, i) => (a === '--format' ? `--format=${args[i + 1]}` : a)).find((a) => a.startsWith('--format='));
    if (pos.includes('environments') && (pos.includes('describe') || format) && !format?.includes('('))
      return 'add a --format projection such as --format="value(config.softwareConfig.imageVersion)": full environment descriptions can contain environment variable values';
    return pos.some((w) => GCLOUD_READ_VERBS.has(w)) && !pos.includes('run')
      ? null
      : `only list, describe and ls are allowed, not "gcloud ${words}"`;
  },
  gsutil(args) {
    if (!CLOUD_READ) return NOT_ALLOWED_DEFAULT;
    return positional(args)[0] === 'ls' ? null : 'only "gsutil ls" is allowed';
  },
  bq(args) {
    if (!CLOUD_READ) return NOT_ALLOWED_DEFAULT;
    return ['ls', 'show'].includes(positional(args)[0]) ? null : 'only "bq ls" and "bq show" are allowed';
  },
  terraform: (args) =>
    ['fmt', 'validate', 'version'].includes(positional(args)[0]) ? null : 'only fmt, validate and version are allowed',
  kubectl: () => 'DCAM development never needs kubectl',
  helm: () => 'DCAM development never needs helm',
  http: () => 'use curl for GET requests instead',
  curl(args) {
    if (args.some((a) => CLOUD_HOSTS.test(a))) return 'requests to Google APIs go through DCAM itself, run by a human';
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const method =
        a === '-X' || a === '--request' ? args[i + 1] : a.startsWith('--request=') ? a.slice(10) : /^-X./.test(a) ? a.slice(2) : null;
      if (method && !/^(GET|HEAD)$/i.test(method)) return `HTTP method ${method} is not allowed`;
      if (/^--(data|form|upload-file|json)/.test(a) || /^-[a-zA-Z]*[dFT]/.test(a)) return 'request bodies and uploads are not allowed';
    }
    return null;
  },
  wget(args) {
    if (args.some((a) => CLOUD_HOSTS.test(a))) return 'requests to Google APIs go through DCAM itself, run by a human';
    const bad = args.find((a) => /^--(post-data|post-file|body-data|body-file)/.test(a) || /^--method=(?!GET\b|HEAD\b)/i.test(a));
    return bad ? `"${bad}" is not allowed` : null;
  },
  git(args) {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c'].includes(args[i]) ? 2 : 1;
    const [sub, ...rest] = args.slice(i);
    if (sub === 'push' && rest.some((a) => /^(-f|-d|--force.*|--mirror|--delete)$/.test(a) || /^[+:]/.test(a)))
      return 'force pushes, remote deletes and mirrors need a human';
    if (sub === 'reset' && rest.includes('--hard')) return '"reset --hard" needs a human';
    if (sub === 'filter-branch' || sub === 'filter-repo') return 'history rewriting needs a human';
    if (sub === 'config' && rest.some((a) => a === '--global' || a === '--system')) return 'global Git configuration needs a human';
    return null;
  },
};
RULES.tofu = RULES.terraform;
RULES.https = RULES.http;
RULES.xh = RULES.http;

/** Replaces $(…), <(…), >(…) and `…` with a placeholder and returns their contents. */
function extractSubstitutions(line) {
  const inner = [];
  let outer = '';
  for (let i = 0; i < line.length; i++) {
    if ('$<>'.includes(line[i]) && line[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < line.length && depth > 0; j++) depth += line[j] === '(' ? 1 : line[j] === ')' ? -1 : 0;
      inner.push(line.slice(i + 2, j - 1));
      outer += SUBST;
      i = j - 1;
    } else if (line[i] === '`') {
      const end = line.indexOf('`', i + 1);
      inner.push(line.slice(i + 1, end === -1 ? line.length : end));
      outer += SUBST;
      i = end === -1 ? line.length : end;
    } else {
      outer += line[i];
    }
  }
  return { outer, inner };
}

/** Splits on ; && || | & and newlines outside quotes, keeping redirections such as 2>&1. */
function splitCommands(line) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') cur += line[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '\\') {
      cur += c + (line[++i] ?? '');
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (';\n|&'.includes(c) && !(c === '&' && (line[i - 1] === '>' || line[i - 1] === '<' || line[i + 1] === '>'))) {
      parts.push(cur);
      cur = '';
      if (line[i + 1] === c) i++;
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Splits a simple command into words, removing quotes. */
function words(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\') {
      cur += cmd[++i] ?? '';
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

const base = (w) => w.split('/').pop();

function stripPrefixes(w) {
  let i = 0;
  while (i < w.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++;
    else if (PREFIXES.has(base(w[i]))) {
      i++;
      while (i < w.length && (w[i].startsWith('-') || /^\d+[smhd]?$/.test(w[i]))) i++;
    } else break;
  }
  return w.slice(i);
}

function checkWords(w, depth) {
  w = stripPrefixes(w);
  if (w.length === 0) return null;
  if (w[0].includes(SUBST) || w[0].includes('$')) return 'the command name is computed at runtime and cannot be verified';
  const cmd = base(w[0]);
  const args = w.slice(1);
  if (NEEDS_HUMAN.has(cmd)) return `"${cmd}" needs a human`;
  if (UNVERIFIABLE.has(cmd)) return `"${cmd}" runs code that cannot be verified`;
  if (SHELLS.has(cmd)) {
    const flag = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    return flag === -1 ? null : check(args[flag + 1] ?? '', depth + 1);
  }
  if (cmd === 'xargs') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += /^-[IinPLdEs]$/.test(args[i]) ? 2 : 1;
    return checkWords(args.slice(i), depth + 1);
  }
  if (cmd === 'find') {
    const at = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
    return at === -1 ? null : checkWords(args.slice(at + 1).filter((a) => a !== ';' && a !== '+' && a !== '{}'), depth + 1);
  }
  return RULES[cmd]?.(args) ?? null;
}

function check(line, depth = 0) {
  if (depth > MAX_DEPTH) return 'the command is nested too deeply to verify';
  if (CREDENTIALS.test(line)) return 'it touches a credential store';
  if (HARNESS.test(line) && !MAINTENANCE) return 'harness guardrails and modes are changed only by a human (§21.4)';
  const { outer, inner } = extractSubstitutions(line);
  for (const sub of inner) {
    const reason = check(sub, depth + 1);
    if (reason) return reason;
  }
  for (const part of splitCommands(outer)) {
    const reason = checkWords(words(part), depth);
    if (reason) return reason;
  }
  return null;
}

let command = '';
try {
  command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '';
} catch {
  process.stderr.write('DCAM guard: could not read the hook input, so the command is blocked.\n');
  process.exit(2);
}
const reason = check(command);
if (reason) {
  process.stderr.write(`Blocked by the DCAM guard: ${reason}. See CLAUDE.md (non-negotiables) and spec §21.5.\n`);
  process.exit(2);
}
