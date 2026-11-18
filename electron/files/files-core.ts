import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../source-control/git-exec';

export type FolderEntryKind = 'Dir' | 'File' | 'Symlink' | 'Other';

export interface FolderEntry {
  readonly name: string;
  readonly kind: FolderEntryKind;
  /** Matched by .gitignore (always false outside a repository). */
  readonly ignored: boolean;
}

export type FolderListing =
  | {
      readonly _tag: 'Listing';
      readonly entries: ReadonlyArray<FolderEntry>;
      readonly truncated: boolean;
    }
  | { readonly _tag: 'Invalid'; readonly detail: string }
  | { readonly _tag: 'Missing'; readonly detail: string };

export type TextFile =
  | { readonly _tag: 'Text'; readonly content: string; readonly size: number }
  | {
      readonly _tag: 'NoPreview';
      readonly reason: 'Binary' | 'TooLarge' | 'NotFile' | 'Unreadable' | 'Missing';
    }
  | { readonly _tag: 'Invalid'; readonly detail: string };

export const MAX_LISTED_ENTRIES = 2_000;
export const MAX_TEXT_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8_000;

const sameOrInside = (root: string, target: string): boolean => {
  const a = process.platform === 'win32' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' ? target.toLowerCase() : target;
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
};

type Resolved =
  | { readonly ok: true; readonly full: string; readonly root: string }
  | {
      readonly ok: false;
      readonly result: { readonly _tag: 'Invalid' | 'Missing'; readonly detail: string };
    };

/**
 * Turns a path relative to the Session's folder into a real path inside it. Refuses an absolute path, `..`, `.git`
 * and anything a symbolic link leads out of the folder.
 */
const resolveInside = async (folder: string, relative: string): Promise<Resolved> => {
  const invalid = (detail: string): Resolved => ({
    ok: false,
    result: { _tag: 'Invalid', detail },
  });
  if (relative.includes('\0') || relative.includes('\\') || /^([A-Za-z]:|\/)/.test(relative)) {
    return invalid('The path must be relative to the Session folder.');
  }
  const segments = relative.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..')) return invalid('The path leaves the folder.');
  if (segments[0] === '.git') return invalid('The .git folder is not shown.');
  let root: string;
  try {
    root = await realpath(folder);
  } catch {
    return { ok: false, result: { _tag: 'Missing', detail: 'The Session folder does not exist.' } };
  }
  const joined = path.join(root, ...segments);
  let full: string;
  try {
    full = await realpath(joined);
  } catch {
    return { ok: false, result: { _tag: 'Missing', detail: `${relative || '.'} does not exist.` } };
  }
  return sameOrInside(root, full)
    ? { ok: true, full, root }
    : invalid('The path leaves the folder.');
};

const ignoredNames = async (
  root: string,
  relativeDir: string,
  entries: ReadonlyArray<{ name: string; kind: FolderEntryKind }>,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<Set<string>> => {
  if (gitExecutable === null || entries.length === 0) return new Set();
  const asked = entries.map((entry) => {
    const base = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
    return entry.kind === 'Dir' ? `${base}/` : base;
  });
  const result = await runGit(
    gitExecutable,
    ['check-ignore', '-z', '--stdin'],
    root,
    pathEnv,
    asked.join('\0'),
  );
  // Exit 1 means nothing matched and 128 means not a repository: both leave stdout empty.
  const ignored = new Set(result.stdout.split('\0').filter((item) => item.length > 0));
  const out = new Set<string>();
  entries.forEach((entry, index) => {
    const question = asked[index] ?? '';
    if (ignored.has(question) || ignored.has(question.replace(/\/$/, ''))) out.add(entry.name);
  });
  return out;
};

const kindOf = (entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): FolderEntryKind =>
  entry.isDirectory()
    ? 'Dir'
    : entry.isFile()
      ? 'File'
      : entry.isSymbolicLink()
        ? 'Symlink'
        : 'Other';

/** The entries of one folder of the Session, folders first, each group by name. `.git` is left out. */
export const listFolder = async (
  folder: string,
  relativeDir: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<FolderListing> => {
  const resolved = await resolveInside(folder, relativeDir);
  if (!resolved.ok) return resolved.result;
  let dirents;
  try {
    dirents = await readdir(resolved.full, { withFileTypes: true });
  } catch {
    return { _tag: 'Missing', detail: `${relativeDir || '.'} cannot be read.` };
  }
  const named = dirents
    .filter((entry) => !(relativeDir === '' && entry.name === '.git'))
    .map((entry) => ({ name: entry.name, kind: kindOf(entry) }))
    .sort((a, b) => {
      const aDir = a.kind === 'Dir' ? 0 : 1;
      const bDir = b.kind === 'Dir' ? 0 : 1;
      return aDir - bDir || a.name.localeCompare(b.name);
    });
  const truncated = named.length > MAX_LISTED_ENTRIES;
  const shown = named.slice(0, MAX_LISTED_ENTRIES);
  const ignored = await ignoredNames(resolved.full, '', shown, gitExecutable, pathEnv);
  return {
    _tag: 'Listing',
    entries: shown.map((entry) => ({ ...entry, ignored: ignored.has(entry.name) })),
    truncated,
  };
};

/** The text of one file of the Session, unless it is binary, too large or not a regular file. */
export const readTextFile = async (folder: string, relativePath: string): Promise<TextFile> => {
  const resolved = await resolveInside(folder, relativePath);
  if (!resolved.ok) {
    return resolved.result._tag === 'Invalid'
      ? { _tag: 'Invalid', detail: resolved.result.detail }
      : { _tag: 'NoPreview', reason: 'Missing' };
  }
  let info;
  try {
    info = await stat(resolved.full);
  } catch {
    return { _tag: 'NoPreview', reason: 'Missing' };
  }
  if (!info.isFile()) return { _tag: 'NoPreview', reason: 'NotFile' };
  if (info.size > MAX_TEXT_BYTES) return { _tag: 'NoPreview', reason: 'TooLarge' };
  try {
    const handle = await open(resolved.full, 'r');
    try {
      const buffer = Buffer.alloc(info.size);
      await handle.read(buffer, 0, info.size, 0);
      if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
        return { _tag: 'NoPreview', reason: 'Binary' };
      }
      return { _tag: 'Text', content: buffer.toString('utf8'), size: info.size };
    } finally {
      await handle.close();
    }
  } catch {
    return { _tag: 'NoPreview', reason: 'Unreadable' };
  }
};
