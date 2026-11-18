import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  gitFailure,
  realPathOrNull,
  resolveWorktreeContext,
  runGit,
  type GitWorktreeContext,
} from '../source-control/git-exec';
import type { WorkerCapabilityFailure } from '../source-control/worker-protocol';

export interface WorktreeEntry {
  readonly path: string;
  readonly folderName: string;
  /** `null` while HEAD is detached or the Worktree is bare. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly isPrimary: boolean;
  /** The Worktree the asked-about folder belongs to. */
  readonly isCurrent: boolean;
  /** Git still lists it but its folder is gone. */
  readonly missing: boolean;
  readonly locked: boolean;
}

export type WorktreesListResult =
  | WorkerCapabilityFailure
  | { readonly _tag: 'Available'; readonly entries: ReadonlyArray<WorktreeEntry> };

export type CreateWorktreeRejection =
  'InvalidBranch' | 'BranchExists' | 'DestinationExists' | 'UnknownBase';

export type CreateWorktreeResult =
  | WorkerCapabilityFailure
  | { readonly _tag: 'Created'; readonly entry: WorktreeEntry }
  | {
      readonly _tag: 'Rejected';
      readonly reason: CreateWorktreeRejection;
      readonly detail: string;
    };

const sameFolder = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

interface RawWorktree {
  path: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Parses `git worktree list --porcelain`: blank-line separated blocks of `key value` lines. */
const parsePorcelain = (stdout: string): RawWorktree[] =>
  stdout
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => line.length > 0))
    .filter((lines) => lines.some((line) => line.startsWith('worktree ')))
    .map((lines) => {
      const raw: RawWorktree = {
        path: '',
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      for (const line of lines) {
        if (line.startsWith('worktree ')) raw.path = path.normalize(line.slice('worktree '.length));
        else if (line.startsWith('branch '))
          raw.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        else if (line === 'detached') raw.detached = true;
        else if (line === 'bare') raw.bare = true;
        else if (line === 'locked' || line.startsWith('locked ')) raw.locked = true;
        else if (line === 'prunable' || line.startsWith('prunable ')) raw.prunable = true;
      }
      return raw;
    });

const toEntries = async (
  ctx: GitWorktreeContext,
  stdout: string,
): Promise<ReadonlyArray<WorktreeEntry>> =>
  Promise.all(
    parsePorcelain(stdout).map(async (raw, index) => {
      const real = await realPathOrNull(raw.path);
      return {
        path: raw.path,
        folderName: path.basename(raw.path),
        branch: raw.branch,
        detached: raw.detached,
        isPrimary: index === 0,
        isCurrent: real !== null && sameFolder(real, ctx.toplevelRealPath),
        missing: raw.prunable || real === null,
        locked: raw.locked,
      };
    }),
  );

type Listed =
  | { readonly entries: ReadonlyArray<WorktreeEntry> }
  | { readonly failure: WorkerCapabilityFailure };

const list = async (ctx: GitWorktreeContext, folder: string, pathEnv: string): Promise<Listed> => {
  const result = await runGit(
    ctx.executable,
    ['worktree', 'list', '--porcelain'],
    ctx.toplevelRealPath,
    pathEnv,
  );
  return result.ok
    ? { entries: await toEntries(ctx, result.stdout) }
    : { failure: gitFailure(folder, result, 'Failed to list Git Worktrees.') };
};

/** Every Worktree of the repository the folder belongs to, primary first. */
export const listWorktrees = async (
  folder: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<WorktreesListResult> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  const listed = await list(ctx, folder, pathEnv);
  return 'failure' in listed ? listed.failure : { _tag: 'Available', entries: listed.entries };
};

/** `feature/login` -> `feature-login`: one safe folder name per branch. */
const slugOf = (branch: string): string =>
  branch
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);

const exists = (target: string): Promise<boolean> =>
  access(target).then(
    () => true,
    () => false,
  );

/**
 * Adds a Worktree on a new branch started from the folder's HEAD, in `<repository>.worktrees/<branch>` beside the
 * primary Worktree. Refuses before touching anything when the branch or folder is unusable.
 */
export const createWorktree = async (
  folder: string,
  branch: string,
  gitExecutable: string | null,
  pathEnv: string,
  /** The local branch the new one starts from; the folder's HEAD when left out. */
  base?: string,
): Promise<CreateWorktreeResult> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  const reject = (reason: CreateWorktreeRejection, detail: string) =>
    ({ _tag: 'Rejected', reason, detail }) as const;

  const slug = slugOf(branch);
  const formatCheck =
    branch.length === 0 || slug.length === 0 || branch.startsWith('-')
      ? undefined
      : await runGit(
          ctx.executable,
          ['check-ref-format', '--branch', branch],
          ctx.toplevelRealPath,
          pathEnv,
        );
  if (formatCheck === undefined || !formatCheck.ok) {
    return reject('InvalidBranch', `${branch || '(empty)'} is not a valid branch name.`);
  }
  if (base !== undefined) {
    const known = await runGit(
      ctx.executable,
      ['show-ref', '--verify', '--quiet', `refs/heads/${base}`],
      ctx.toplevelRealPath,
      pathEnv,
    );
    if (!known.ok) return reject('UnknownBase', `No local branch ${base} to start from.`);
  }
  const taken = await runGit(
    ctx.executable,
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (taken.ok) return reject('BranchExists', `The branch ${branch} already exists.`);

  const existing = await list(ctx, folder, pathEnv);
  if ('failure' in existing) return existing.failure;
  const primary = existing.entries[0];
  if (primary === undefined) return reject('InvalidBranch', 'No primary Worktree found.');
  const destination = path.join(
    path.dirname(primary.path),
    `${path.basename(primary.path)}.worktrees`,
    slug,
  );
  if (await exists(destination)) {
    return reject('DestinationExists', `The folder ${destination} already exists.`);
  }

  const added = await runGit(
    ctx.executable,
    ['worktree', 'add', '-b', branch, destination, ...(base === undefined ? [] : [base])],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (!added.ok) return gitFailure(folder, added, 'Failed to create the Worktree.');

  const after = await list(ctx, folder, pathEnv);
  if ('failure' in after) return after.failure;
  const real = await realPathOrNull(destination);
  const entry = after.entries.find(
    (candidate) =>
      sameFolder(path.normalize(candidate.path), path.normalize(destination)) ||
      (real !== null && sameFolder(path.normalize(candidate.path), real)),
  );
  return entry === undefined
    ? { _tag: 'GitFailed', path: folder, detail: 'The new Worktree was not listed by Git.' }
    : { _tag: 'Created', entry };
};
