import { Effect } from 'effect';
import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  FoldersError,
  type FolderEntry,
  type FolderListing,
} from '../../src/shared/folders/folders.rpc';

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

/** A folder that is not there (or is a file) is `Missing`; one that is there but cannot be read, `Unreadable`. */
const failureOf = (folder: string, error: unknown): FoldersError => {
  const code = codeOf(error);
  return new FoldersError({
    reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'Missing' : 'Unreadable',
    detail: folder,
  });
};

/** Where the disk starts: every drive that answers on Windows, `/` elsewhere. */
const roots = (platform: NodeJS.Platform): Effect.Effect<ReadonlyArray<string>> =>
  platform !== 'win32'
    ? Effect.succeed(['/'])
    : Effect.promise(() =>
        Promise.all(
          [...DRIVE_LETTERS].map((letter) =>
            stat(`${letter}:\\`).then(
              () => [`${letter}:\\`],
              () => [],
            ),
          ),
        ).then((drives) => drives.flat()),
      );

/** The real path of an existing folder; a file or nothing there is `Missing`. */
const realFolder = Effect.fnUntraced(function* (folder: string) {
  const real = yield* Effect.tryPromise({
    try: () => realpath(folder),
    catch: (error) => failureOf(folder, error),
  });
  const isFolder = yield* Effect.tryPromise({
    try: async () => (await stat(real)).isDirectory(),
    catch: (error) => failureOf(folder, error),
  });
  if (!isFolder) return yield* new FoldersError({ reason: 'Missing', detail: folder });
  return real;
});

/**
 * One listed child as a folder entry: a folder as it is, a link only when it leads to a folder (resolved). Anything
 * else (a file, a broken link, a link it may not follow) is left out.
 */
const toEntry = async (parent: string, child: Dirent): Promise<ReadonlyArray<FolderEntry>> => {
  const at = path.join(parent, child.name);
  const hidden = child.name.startsWith('.');
  if (child.isDirectory()) return [{ name: child.name, path: at, hidden, link: false }];
  if (!child.isSymbolicLink()) return [];
  try {
    const target = await realpath(at);
    return (await stat(target)).isDirectory()
      ? [{ name: child.name, path: target, hidden, link: true }]
      : [];
  } catch {
    return [];
  }
};

/**
 * The home folder browsing starts at. The e2e harness points it at its own folder (`SPENCE_E2E_HOME`), so a run
 * never lists the machine's real home.
 */
const homeFolder = (): string => {
  const e2eHome = process.env['SPENCE_E2E'] === '1' ? process.env['SPENCE_E2E_HOME'] : undefined;
  return e2eHome !== undefined && e2eHome !== '' ? e2eHome : homedir();
};

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * Lists the sub-folders of `folder` (`null`: the home folder) for the in-app folder browser. Reads directory entries
 * and their kinds only, never a file's contents; hidden (dot) folders only when asked for.
 */
export const browseFolders = Effect.fn('Folders.browse')(function* (
  folder: string | null,
  hidden: boolean,
) {
  const home = yield* Effect.orElseSucceed(realFolder(homeFolder()), homeFolder);
  const listed = folder === null ? home : yield* realFolder(folder);
  const children = yield* Effect.tryPromise({
    try: () => readdir(listed, { withFileTypes: true }),
    catch: (error) => failureOf(listed, error),
  });
  const entries = yield* Effect.promise(() =>
    Promise.all(children.map((child) => toEntry(listed, child))),
  );
  const parent = path.dirname(listed);
  const listing: FolderListing = {
    path: listed,
    parent: parent === listed ? null : parent,
    home,
    roots: yield* roots(process.platform),
    entries: entries
      .flat()
      .filter((entry) => hidden || !entry.hidden)
      .sort((a, b) => byName.compare(a.name, b.name)),
  };
  return listing;
});
