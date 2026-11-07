/**
 * Path rules of the configuration (spec §17.1, §17.3): `~` is the user's home folder, and a relative path is
 * relative to a base folder (the configuration file's folder for values in the file, the working directory
 * for flags and environment variables). Pure string work: nothing is read from disk.
 *
 * @implements FR-SETUP-02
 */
import { isAbsolute, join, resolve } from 'node:path';

/** Expands a leading `~` (alone, or followed by `/` or `\`). `~user` is not expanded. */
export function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2));
  return path;
}

/** Absolute form of `path`: `~` expanded, then resolved against `baseDir` when still relative. */
export function resolvePath(path: string, baseDir: string, homeDir: string): string {
  const expanded = expandHome(path, homeDir);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}
