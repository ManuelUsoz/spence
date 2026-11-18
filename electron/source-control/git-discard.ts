import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  detectActiveIntegration,
  resolveWorktreeContext,
  runGit,
  type ExecResult,
  type GitWorktreeContext,
} from './git-exec';
import { inspectGitStatus } from './git-status-diff';
import type { WorkerCapabilityFailure } from './worker-protocol';

/** How long a discarded change stays recoverable. */
export const RECOVERY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECOVERY_PREFIX = 'discard-';
/** A commit can run hooks: give a revert as long as a push. */
const LONG_TIMEOUT_MS = 120_000;

export interface DiscardTarget {
  readonly path: string;
  readonly previousPath?: string;
}

export type DiscardEffect =
  /** The tracked file goes back to its last commit. */
  | 'Restore'
  /** The file is new, so it is deleted. */
  | 'Remove'
  /** A staged rename is undone: the new name is deleted and the old one comes back. */
  | 'UndoRename';

export interface PlannedDiscard {
  readonly path: string;
  readonly previousPath?: string;
  readonly effect: DiscardEffect;
}

export type PrepareRejection = 'NothingSelected' | 'Conflicted' | 'IntegrationInProgress';

export type PrepareOutcome =
  | WorkerCapabilityFailure
  | {
      readonly _tag: 'Ready';
      /** Changes whenever any selected file changes: confirming with an old token is refused. */
      readonly token: string;
      readonly files: ReadonlyArray<PlannedDiscard>;
    }
  | { readonly _tag: 'Rejected'; readonly reason: PrepareRejection; readonly detail: string };

export type DiscardOutcome =
  | WorkerCapabilityFailure
  | {
      readonly _tag: 'Discarded';
      readonly count: number;
      readonly recovery: { readonly id: string; readonly folder: string };
    }
  | {
      readonly _tag: 'Rejected';
      readonly reason: PrepareRejection | 'Stale';
      readonly detail: string;
    }
  | { readonly _tag: 'Failed'; readonly detail: string };

const text = (result: ExecResult): string => `${result.stderr}\n${result.stdout}`.trim();

const sha1 = (value: string | Buffer): string => createHash('sha1').update(value).digest('hex');

/** What is on disk at a path, as a short string that changes when the content does. */
const fingerprintOf = async (full: string): Promise<string> => {
  try {
    const info = await lstat(full);
    if (info.isSymbolicLink()) return `link:${await readlink(full)}`;
    if (info.isFile()) return `file:${sha1(await readFile(full))}`;
    return 'other';
  } catch {
    return 'missing';
  }
};

interface Plan {
  readonly ctx: GitWorktreeContext;
  readonly files: ReadonlyArray<PlannedDiscard>;
  readonly token: string;
  /** Paths git still has a status for, with the status Git gave them. */
  readonly statuses: ReadonlyMap<string, string>;
}

const buildPlan = async (
  folder: string,
  targets: ReadonlyArray<DiscardTarget>,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<
  | Plan
  | WorkerCapabilityFailure
  | { readonly _tag: 'Rejected'; readonly reason: PrepareRejection; readonly detail: string }
> => {
  const status = await inspectGitStatus(folder, gitExecutable, pathEnv);
  if (status._tag !== 'Available') return status;
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  if ((await detectActiveIntegration(ctx.gitDirRealPath)) !== 'None') {
    return {
      _tag: 'Rejected',
      reason: 'IntegrationInProgress',
      detail: 'A merge, rebase or similar is in progress.',
    };
  }
  const wanted = new Set(targets.map((target) => target.path));
  const selected = status.files.filter((file) => wanted.has(file.path));
  if (selected.length === 0) {
    return { _tag: 'Rejected', reason: 'NothingSelected', detail: 'Nothing selected is changed.' };
  }
  if (selected.some((file) => file.status === 'Conflicted')) {
    return { _tag: 'Rejected', reason: 'Conflicted', detail: 'A selected file is in conflict.' };
  }
  const files = [...selected]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file): PlannedDiscard => {
      const effect: DiscardEffect =
        file.status === 'Renamed' && file.previousPath !== undefined
          ? 'UndoRename'
          : file.status === 'Untracked' || file.status === 'Added' || file.status === 'Copied'
            ? 'Remove'
            : 'Restore';
      return {
        path: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        effect,
      };
    });

  const root = ctx.toplevelRealPath;
  const paths = files.flatMap((file) =>
    file.previousPath === undefined ? [file.path] : [file.path, file.previousPath],
  );
  const index = await runGit(
    ctx.executable,
    ['--literal-pathspecs', 'ls-files', '-s', '--', ...paths],
    root,
    pathEnv,
  );
  const parts: string[] = [index.stdout];
  for (const file of selected) {
    parts.push(
      [
        file.path,
        file.previousPath ?? '',
        file.status,
        String(file.staged),
        String(file.unstaged),
        await fingerprintOf(path.join(root, file.path)),
        file.previousPath === undefined
          ? ''
          : await fingerprintOf(path.join(root, file.previousPath)),
      ].join('\u0000'),
    );
  }
  return {
    ctx,
    files,
    token: sha1(parts.join('\u0001')),
    statuses: new Map(selected.map((file) => [file.path, file.status])),
  };
};

const isPlan = (value: Awaited<ReturnType<typeof buildPlan>>): value is Plan => 'token' in value;

/** What discarding the selected files would do. Nothing is changed. */
export const prepareDiscard = async (
  folder: string,
  targets: ReadonlyArray<DiscardTarget>,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<PrepareOutcome> => {
  const plan = await buildPlan(folder, targets, gitExecutable, pathEnv);
  return isPlan(plan) ? { _tag: 'Ready', token: plan.token, files: plan.files } : plan;
};

/** Deletes recovery copies older than the retention period. Other folders are never touched. */
export const pruneRecoveries = async (recoveryRoot: string, now: number): Promise<void> => {
  let names: string[];
  try {
    names = await readdir(recoveryRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(RECOVERY_PREFIX)) continue;
    try {
      const manifest = JSON.parse(
        await readFile(path.join(recoveryRoot, name, 'manifest.json'), 'utf8'),
      ) as { createdAt?: unknown };
      if (
        typeof manifest.createdAt === 'number' &&
        now - manifest.createdAt > RECOVERY_DAYS * DAY_MS
      ) {
        await rm(path.join(recoveryRoot, name), { recursive: true, force: true });
      }
    } catch {
      // Not ours, or unreadable: leave it.
    }
  }
};

const saveRecovery = async (
  plan: Plan,
  recoveryRoot: string,
  now: number,
  pathEnv: string,
): Promise<{ id: string; folder: string }> => {
  await pruneRecoveries(recoveryRoot, now);
  const id = `${RECOVERY_PREFIX}${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const folder = path.join(recoveryRoot, id);
  const root = plan.ctx.toplevelRealPath;
  await mkdir(path.join(folder, 'files'), { recursive: true });
  const paths = plan.files.flatMap((file) =>
    file.previousPath === undefined ? [file.path] : [file.path, file.previousPath],
  );
  const links: Array<{ path: string; target: string }> = [];
  for (const rel of paths) {
    let info;
    try {
      info = await lstat(path.join(root, rel));
    } catch {
      continue; // Already gone: nothing to keep.
    }
    if (info.isSymbolicLink()) {
      links.push({ path: rel, target: await readlink(path.join(root, rel)) });
      continue;
    }
    if (!info.isFile()) continue;
    // A copy that cannot be made throws: nothing is discarded without one.
    const target = path.join(folder, 'files', rel);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, rel), target);
  }
  const patch = await runGit(
    plan.ctx.executable,
    ['--literal-pathspecs', 'diff', 'HEAD', '--binary', '--', ...paths],
    root,
    pathEnv,
  );
  await writeFile(path.join(folder, 'changes.patch'), patch.ok ? patch.stdout : '');
  await writeFile(
    path.join(folder, 'manifest.json'),
    JSON.stringify({ version: 1, cwd: root, createdAt: now, files: plan.files, links }, null, 2),
  );
  return { id, folder };
};

/**
 * Discards the selected files: tracked ones go back to the last commit, new ones are deleted. First checks that
 * nothing changed since `token` was issued, and keeps a copy of everything it is about to lose.
 */
export const discardChanges = async (
  folder: string,
  targets: ReadonlyArray<DiscardTarget>,
  token: string,
  recoveryRoot: string,
  now: number,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<DiscardOutcome> => {
  const plan = await buildPlan(folder, targets, gitExecutable, pathEnv);
  if (!isPlan(plan)) return plan;
  if (plan.token !== token) {
    return {
      _tag: 'Rejected',
      reason: 'Stale',
      detail: 'The files changed after you looked. Review them again.',
    };
  }
  let recovery: { id: string; folder: string };
  try {
    recovery = await saveRecovery(plan, recoveryRoot, now, pathEnv);
  } catch (error) {
    return {
      _tag: 'Failed',
      detail: `Could not keep a copy, so nothing was discarded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // Taking the copy takes time: make sure nothing changed while it was made.
  const again = await buildPlan(folder, targets, gitExecutable, pathEnv);
  if (!isPlan(again) || again.token !== token) {
    await rm(recovery.folder, { recursive: true, force: true });
    return {
      _tag: 'Rejected',
      reason: 'Stale',
      detail: 'The files changed after you looked. Review them again.',
    };
  }
  const root = plan.ctx.toplevelRealPath;
  const run = (args: ReadonlyArray<string>) =>
    runGit(plan.ctx.executable, ['--literal-pathspecs', ...args], root, pathEnv);

  const removeFromIndex = plan.files
    .filter((file) => plan.statuses.get(file.path) !== 'Untracked' && file.effect !== 'Restore')
    .map((file) => file.path);
  const removeUntracked = plan.files
    .filter((file) => plan.statuses.get(file.path) === 'Untracked')
    .map((file) => file.path);
  const restore = plan.files.flatMap((file) =>
    file.effect === 'Restore'
      ? [file.path]
      : file.effect === 'UndoRename' && file.previousPath !== undefined
        ? [file.previousPath]
        : [],
  );

  const steps: Array<ReadonlyArray<string>> = [
    ...(removeFromIndex.length > 0 ? [['rm', '-f', '-q', '--', ...removeFromIndex]] : []),
    ...(removeUntracked.length > 0 ? [['clean', '-f', '-q', '--', ...removeUntracked]] : []),
    ...(restore.length > 0
      ? [['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore]]
      : []),
  ];
  for (const args of steps) {
    const result = await run(args);
    if (!result.ok) {
      return {
        _tag: 'Failed',
        detail: `${text(result)}\n(A copy of the files is kept in ${recovery.folder}.)`,
      };
    }
  }
  return { _tag: 'Discarded', count: plan.files.length, recovery };
};

export type RevertRejection =
  | 'UnknownCommit'
  | 'NotInBranch'
  | 'MergeCommit'
  | 'DirtyTree'
  | 'IntegrationInProgress'
  | 'Conflict';

export type RevertOutcome =
  | WorkerCapabilityFailure
  | { readonly _tag: 'Reverted'; readonly sha: string; readonly shortSha: string }
  | { readonly _tag: 'Rejected'; readonly reason: RevertRejection; readonly detail: string }
  | { readonly _tag: 'Failed'; readonly detail: string };

/**
 * Reverts one ordinary commit of the current branch with a new commit. Refuses while tracked files have changes
 * and backs out cleanly when the revert would conflict, so the folder is never left half-reverted.
 */
export const revertCommit = async (
  folder: string,
  sha: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<RevertOutcome> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  const root = ctx.toplevelRealPath;
  const git = (args: ReadonlyArray<string>, stdin?: string, timeout?: number) =>
    runGit(ctx.executable, args, root, pathEnv, stdin, timeout);
  const reject = (reason: RevertRejection, detail: string) =>
    ({ _tag: 'Rejected', reason, detail }) as const;

  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return reject('UnknownCommit', 'That is not a commit id.');
  const resolved = await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  const full = resolved.stdout.trim();
  if (!resolved.ok || full.length === 0) return reject('UnknownCommit', 'No such commit.');
  if ((await detectActiveIntegration(ctx.gitDirRealPath)) !== 'None') {
    return reject('IntegrationInProgress', 'A merge, rebase or similar is in progress.');
  }
  if (!(await git(['merge-base', '--is-ancestor', full, 'HEAD'])).ok) {
    return reject('NotInBranch', 'That commit is not part of the current branch.');
  }
  const parents = (await git(['rev-list', '--parents', '-n', '1', full])).stdout
    .trim()
    .split(/\s+/);
  if (parents.length > 2) return reject('MergeCommit', 'A merge commit cannot be reverted here.');
  const dirty = await git(['status', '--porcelain=v1', '--untracked-files=no']);
  if (dirty.stdout.trim().length > 0) {
    return reject('DirtyTree', 'Commit or discard your changes before reverting.');
  }

  const reverted = await git(['revert', '--no-edit', full], undefined, LONG_TIMEOUT_MS);
  if (!reverted.ok) {
    const output = text(reverted);
    // Whatever went wrong, never leave a half-done revert behind.
    if ((await detectActiveIntegration(ctx.gitDirRealPath)) === 'Revert') {
      await git(['revert', '--abort']);
    }
    return /conflict/i.test(output)
      ? reject('Conflict', output)
      : { _tag: 'Failed', detail: output };
  }
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  return { _tag: 'Reverted', sha: head, shortSha: head.slice(0, 7) };
};
