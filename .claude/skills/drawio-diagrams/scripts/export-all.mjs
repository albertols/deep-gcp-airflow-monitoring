#!/usr/bin/env node
// Exports docs/diagrams/*.drawio to <name>.drawio.svg and <name>.png (drawio-diagrams skill).
// Usage: node export-all.mjs [--check]   (--check: fail if an export is missing or older than its source)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const dir = join(root, 'docs', 'diagrams');
const check = process.argv.includes('--check');
const IMAGE = process.env.DRAWIO_DOCKER_IMAGE ?? 'rlespinasse/drawio-desktop-headless:v1.77.0';

/** Last commit time, or modification time for uncommitted files (git checkouts reset mtimes). */
function changedAt(file) {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', file], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!dirty) {
    const committed = execFileSync('git', ['log', '-1', '--format=%ct', '--', file], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    if (committed) return Number(committed) * 1000;
  }
  return statSync(file).mtimeMs;
}

function localBinary() {
  const candidates = [
    process.env.DRAWIO_BIN,
    'drawio',
    '/Applications/draw.io.app/Contents/MacOS/draw.io',
  ].filter(Boolean);
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
}

function exporter() {
  const bin = localBinary();
  if (bin) return (args) => spawnSync(bin, args, { cwd: root, stdio: 'inherit' });
  if (spawnSync('docker', ['--version']).status !== 0) {
    console.error('No draw.io binary and no Docker found. Install draw.io desktop (macOS 13+) or Docker.');
    process.exit(1);
  }
  console.log(`Using Docker image ${IMAGE} (draw.io desktop not found).`);
  // The image's default 10 s command timeout is too short for a cold container start.
  const timeout = process.env.DRAWIO_DESKTOP_COMMAND_TIMEOUT ?? '120s';
  return (args) =>
    spawnSync(
      'docker',
      // --shm-size: Chromium's renderer crashes on PNG export with Docker's default 64 MB /dev/shm.
      [
        'run',
        '--rm',
        '--shm-size=1g',
        '-e',
        `DRAWIO_DESKTOP_COMMAND_TIMEOUT=${timeout}`,
        '-v',
        `${root}:/data`,
        '-w',
        '/data',
        IMAGE,
        ...args,
      ],
      { cwd: root, stdio: 'inherit' },
    );
}

const sources = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.drawio')) : [];
const stale = [];
for (const name of sources) {
  const src = join(dir, name);
  const base = name.slice(0, -'.drawio'.length);
  for (const out of [join(dir, `${base}.drawio.svg`), join(dir, `${base}.png`)]) {
    if (!existsSync(out) || changedAt(out) < changedAt(src)) stale.push({ src, out });
  }
}

if (check) {
  for (const s of stale)
    console.error(`Stale or missing export: ${relative(root, s.out)} (source ${relative(root, s.src)})`);
  if (stale.length > 0) process.exit(1);
  console.log(`Diagram exports up to date (${sources.length} diagrams).`);
  process.exit(0);
}

if (stale.length === 0) {
  console.log(`Nothing to export (${sources.length} diagrams up to date).`);
  process.exit(0);
}
const run = exporter();
for (const { src, out } of stale) {
  const rel = (p) => relative(root, p);
  // --theme light keeps the authored (dark-token) colours. The default "auto" makes SVGs adaptive and
  // inverts them for viewers in dark mode, because draw.io treats authored colours as the light theme.
  const args = out.endsWith('.svg')
    ? [
        '-x',
        '-f',
        'svg',
        '-e',
        '--embed-svg-images',
        '-b',
        '10',
        '--theme',
        'light',
        '-o',
        rel(out),
        rel(src),
      ]
    : ['-x', '-f', 'png', '-e', '-s', '2', '-b', '10', '--theme', 'light', '-o', rel(out), rel(src)];
  const before = existsSync(out) ? statSync(out).mtimeMs : 0;
  const result = run(args);
  // draw.io can exit 0 without writing the file, so check the output as well as the exit code.
  if (result.status !== 0 || !existsSync(out) || statSync(out).mtimeMs <= before) {
    console.error(`Export failed for ${rel(out)}`);
    process.exit(1);
  }
  console.log(`Exported ${rel(out)}`);
}
