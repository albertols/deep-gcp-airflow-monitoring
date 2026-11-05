/**
 * The store in the data directory (spec §17.5): `<dataDir>/dcam.duckdb`, with `backups/` beside it. The directory
 * is created owner-only (`0700`; best effort on Windows, where POSIX modes do not apply). Before a file with an
 * older schema is migrated, it is copied to `backups/` and the last {@link BACKUPS_KEPT} copies are kept.
 *
 * @implements FR-STORE-01
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, constants } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { MIGRATIONS, type Migration } from './migrations';
import { STORE_MAJOR, openStore, type DuckDbStore } from './store';

export const DB_FILE_NAME = 'dcam.duckdb';
export const BACKUP_DIR_NAME = 'backups';
export const BACKUPS_KEPT = 3;

export interface OpenFileStoreOptions {
  /** Absolute data directory (the config adapter has expanded `~` and applied `DCAM_DATA_DIR`). */
  readonly dataDir: string;
  /** Injected clock, also used to name backups. */
  readonly now?: () => number;
  /** Defaults to every migration; tests pass a prefix to build an older file. */
  readonly migrations?: readonly Migration[];
}

/** `dcam-<UTC time>-from-<last applied migration>.duckdb`; the fixed-width time makes name order time order. */
const BACKUP_NAME = /^dcam-\d{8}T\d{9}Z-from-[\w-]+\.duckdb$/;

/** Creates `dir` (and missing parents) owner-only. An existing directory is left as it is: the doctor checks it. */
function ensurePrivateDir(dir: string): void {
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The mode passed to mkdir is reduced by the umask; set it outright. Windows has no POSIX modes.
  if (created !== undefined && process.platform !== 'win32') chmodSync(dir, 0o700);
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:.]/g, '');

interface FileState {
  readonly applied: readonly string[];
  readonly major: number | null;
}

/** Reads the schema state of an existing file without changing its schema (a pending WAL is replayed). */
async function inspect(path: string): Promise<FileState> {
  const instance = await DuckDBInstance.create(path);
  try {
    const con = await instance.connect();
    try {
      /** The VARCHAR column `v` of every row. */
      const column = async (sql: string): Promise<string[]> =>
        (await con.runAndReadAll(sql)).getRowObjectsJS().map(({ v }) => {
          if (typeof v !== 'string') throw new TypeError(`expected a string from DuckDB, got ${typeof v}`);
          return v;
        });
      const tables = new Set(
        await column(
          `SELECT table_name AS v FROM information_schema.tables
           WHERE table_schema = 'meta' AND table_name IN ('schema_migrations', 'store_info')`,
        ),
      );
      const applied = tables.has('schema_migrations')
        ? await column(`SELECT id AS v FROM meta.schema_migrations ORDER BY id`)
        : [];
      const [major] = tables.has('store_info')
        ? await column(`SELECT value AS v FROM meta.store_info WHERE key = 'store_major'`)
        : [];
      return { applied, major: major === undefined ? null : Number(major) };
    } finally {
      con.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

/** Copies the closed database file (and a WAL, if one was left) into `backups/`, then keeps the newest copies. */
function backUp(dataDir: string, path: string, fromVersion: string, now: number): void {
  const dir = join(dataDir, BACKUP_DIR_NAME);
  ensurePrivateDir(dir);
  let name = `dcam-${stamp(now)}-from-${fromVersion}.duckdb`;
  for (let n = 1; existsSync(join(dir, name)); n++)
    name = `dcam-${stamp(now)}-from-${fromVersion}-${n}.duckdb`;
  copyFileSync(path, join(dir, name), constants.COPYFILE_EXCL);
  if (existsSync(`${path}.wal`))
    copyFileSync(`${path}.wal`, join(dir, `${name}.wal`), constants.COPYFILE_EXCL);

  const backups = readdirSync(dir)
    .filter((f) => BACKUP_NAME.test(f))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) {
    rmSync(join(dir, old), { force: true });
    rmSync(join(dir, `${old}.wal`), { force: true });
  }
}

/**
 * Opens `<dataDir>/dcam.duckdb`, creating the directory owner-only. When the file exists with pending migrations
 * (and was not written by a newer DCAM, which {@link openStore} refuses), it is backed up first.
 */
export async function openFileStore(options: OpenFileStoreOptions): Promise<DuckDbStore> {
  const { dataDir } = options;
  const now = options.now ?? Date.now;
  const migrations = options.migrations ?? MIGRATIONS;
  ensurePrivateDir(dataDir);
  const path = join(dataDir, DB_FILE_NAME);

  if (existsSync(path)) {
    const state = await inspect(path);
    const pending = migrations.filter((m) => !state.applied.includes(m.id));
    const newer = state.major !== null && state.major > STORE_MAJOR;
    if (pending.length > 0 && !newer) backUp(dataDir, path, state.applied.at(-1) ?? 'none', now());
  }
  return openStore({ path, now, migrations });
}
