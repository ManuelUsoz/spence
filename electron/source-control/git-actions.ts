import { copyFile, rm } from 'node:fs/promises';
import {
  detectActiveIntegration,
  resolveWorktreeContext,
  runGit,
  type ExecResult,
  type GitWorktreeContext,
} from './git-exec';
import type { WorkerCapabilityFailure } from './worker-protocol';

/** Fetch, push and pull talk to a server, and commit runs the repository's hooks: far longer than a local command. */
const NETWORK_TIMEOUT_MS = 120_000;

export interface CommitFile {
  readonly path: string;
  /** The path a renamed file had, so the commit records a rename. */
  readonly previousPath?: string;
}

export type RemoteRejection =
  | 'NoRemote'
  | 'NeedsRemote'
  | 'UnknownRemote'
  | 'NoUpstream'
  | 'DetachedHead'
  | 'Behind'
  | 'Diverged';

export type RemoteOutcome =
  | WorkerCapabilityFailure
  | { readonly _tag: 'Done'; readonly detail: string }
  | { readonly _tag: 'Rejected'; readonly reason: RemoteRejection; readonly detail: string }
  | { readonly _tag: 'Failed'; readonly detail: string };

export type CommitOutcome =
  | WorkerCapabilityFailure
  | {
      readonly _tag: 'Committed';
      readonly sha: string;
      readonly shortSha: string;
      readonly pushed: 'NotRequested' | 'Pushed' | 'Failed';
      readonly pushDetail?: string;
    }
  | {
      readonly _tag: 'Rejected';
      readonly reason:
        | 'EmptyMessage'
        | 'NothingSelected'
        | 'IntegrationInProgress'
        | Extract<RemoteRejection, 'NoRemote' | 'NeedsRemote' | 'UnknownRemote' | 'DetachedHead'>;
      readonly detail: string;
    }
  | { readonly _tag: 'Failed'; readonly detail: string };

const text = (result: ExecResult): string => `${result.stderr}\n${result.stdout}`.trim();

const remotesOf = async (ctx: GitWorktreeContext, pathEnv: string): Promise<string[]> => {
  const result = await runGit(ctx.executable, ['remote'], ctx.toplevelRealPath, pathEnv);
  return result.ok
    ? result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];
};

const hasUpstream = async (ctx: GitWorktreeContext, pathEnv: string): Promise<boolean> =>
  (
    await runGit(
      ctx.executable,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      ctx.toplevelRealPath,
      pathEnv,
    )
  ).ok;

const onBranch = async (ctx: GitWorktreeContext, pathEnv: string): Promise<boolean> =>
  (
    await runGit(
      ctx.executable,
      ['symbolic-ref', '--short', '-q', 'HEAD'],
      ctx.toplevelRealPath,
      pathEnv,
    )
  ).ok;

/** The names of the repository's remotes; empty when there are none. */
export const listRemotes = async (
  folder: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<ReadonlyArray<string>> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  return ctx._tag === 'Available' ? remotesOf(ctx, pathEnv) : [];
};

/** Why the branch cannot be pushed right now, or the remote to use (`undefined`: the upstream). */
const pushTarget = async (
  ctx: GitWorktreeContext,
  remote: string | undefined,
  pathEnv: string,
): Promise<
  | { readonly ok: true; readonly remote: string | undefined }
  | {
      readonly ok: false;
      readonly reason: Extract<
        RemoteRejection,
        'NoRemote' | 'NeedsRemote' | 'UnknownRemote' | 'DetachedHead'
      >;
      readonly detail: string;
    }
> => {
  if (!(await onBranch(ctx, pathEnv))) {
    return { ok: false, reason: 'DetachedHead', detail: 'HEAD is not on a branch.' };
  }
  if (await hasUpstream(ctx, pathEnv)) return { ok: true, remote: undefined };
  const remotes = await remotesOf(ctx, pathEnv);
  if (remotes.length === 0) {
    return { ok: false, reason: 'NoRemote', detail: 'This repository has no remote.' };
  }
  if (remote === undefined) {
    return { ok: false, reason: 'NeedsRemote', detail: 'Choose a remote to push to.' };
  }
  if (!remotes.includes(remote)) {
    return { ok: false, reason: 'UnknownRemote', detail: `${remote} is not a remote here.` };
  }
  return { ok: true, remote };
};

const pushWith = async (
  ctx: GitWorktreeContext,
  remote: string | undefined,
  pathEnv: string,
): Promise<RemoteOutcome> => {
  const result = await runGit(
    ctx.executable,
    remote === undefined ? ['push'] : ['push', '-u', remote, 'HEAD'],
    ctx.toplevelRealPath,
    pathEnv,
    undefined,
    NETWORK_TIMEOUT_MS,
  );
  if (result.ok) return { _tag: 'Done', detail: text(result) };
  const output = text(result);
  return /non-fast-forward|fetch first/i.test(output)
    ? { _tag: 'Rejected', reason: 'Behind', detail: output }
    : { _tag: 'Failed', detail: output };
};

/** Pushes the current branch to its upstream, or to `remote` when it has none (and starts tracking it). */
export const pushBranch = async (
  folder: string,
  remote: string | undefined,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<RemoteOutcome> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  const target = await pushTarget(ctx, remote, pathEnv);
  if (!target.ok) return { _tag: 'Rejected', reason: target.reason, detail: target.detail };
  return pushWith(ctx, target.remote, pathEnv);
};

/** Downloads what the remote has, without touching the working folder. */
export const fetchRemote = async (
  folder: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<RemoteOutcome> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  if ((await remotesOf(ctx, pathEnv)).length === 0) {
    return { _tag: 'Rejected', reason: 'NoRemote', detail: 'This repository has no remote.' };
  }
  const result = await runGit(
    ctx.executable,
    ['fetch', '--prune'],
    ctx.toplevelRealPath,
    pathEnv,
    undefined,
    NETWORK_TIMEOUT_MS,
  );
  return result.ok
    ? { _tag: 'Done', detail: text(result) }
    : { _tag: 'Failed', detail: text(result) };
};

/** Brings the branch up to its upstream, only when that needs no merge. */
export const pullFastForward = async (
  folder: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<RemoteOutcome> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  if (!(await hasUpstream(ctx, pathEnv))) {
    return { _tag: 'Rejected', reason: 'NoUpstream', detail: 'This branch has no upstream.' };
  }
  const result = await runGit(
    ctx.executable,
    ['pull', '--ff-only'],
    ctx.toplevelRealPath,
    pathEnv,
    undefined,
    NETWORK_TIMEOUT_MS,
  );
  if (result.ok) return { _tag: 'Done', detail: text(result) };
  const output = text(result);
  return /not possible to fast-forward|diverging branches|can't be fast-forwarded/i.test(output)
    ? { _tag: 'Rejected', reason: 'Diverged', detail: output }
    : { _tag: 'Failed', detail: output };
};

/** Fast-forwards an unchecked-out local branch ref from `remote` without touching any working tree. */
export const fetchBranchFastForward = async (
  folder: string,
  remote: string,
  branch: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<RemoteOutcome> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  const remotes = await remotesOf(ctx, pathEnv);
  if (remotes.length === 0) {
    return { _tag: 'Rejected', reason: 'NoRemote', detail: 'This repository has no remote.' };
  }
  if (!remotes.includes(remote)) {
    return {
      _tag: 'Rejected',
      reason: 'UnknownRemote',
      detail: `Remote '${remote}' does not exist.`,
    };
  }
  const result = await runGit(
    ctx.executable,
    ['fetch', remote, `${branch}:${branch}`],
    ctx.toplevelRealPath,
    pathEnv,
    undefined,
    NETWORK_TIMEOUT_MS,
  );
  if (result.ok) return { _tag: 'Done', detail: text(result) };
  const output = text(result);
  return /non-fast-forward|rejected|fetch first/i.test(output)
    ? { _tag: 'Rejected', reason: 'Diverged', detail: output }
    : { _tag: 'Failed', detail: output };
};

/** Returns `true` when the Worktree has no staged, unstaged, or untracked changes. */
export const isWorktreeClean = async (
  folder: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<boolean> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return false;
  const result = await runGit(
    ctx.executable,
    ['status', '--porcelain'],
    ctx.toplevelRealPath,
    pathEnv,
  );
  return result.ok && result.stdout.trim().length === 0;
};

/** Switches the Worktree's checked-out branch to `branch`. */
export const checkoutBranch = async (
  folder: string,
  branch: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<RemoteOutcome> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  const result = await runGit(ctx.executable, ['checkout', branch], ctx.toplevelRealPath, pathEnv);
  return result.ok
    ? { _tag: 'Done', detail: text(result) }
    : { _tag: 'Failed', detail: text(result) };
};

/**
 * Stages the new content of the paths (new, changed and deleted files). A path git no longer knows anywhere, such as
 * the old name of a rename that is already staged, is skipped. Returns the failure text, or null.
 */
const stagePaths = async (
  ctx: GitWorktreeContext,
  paths: ReadonlyArray<string>,
  pathEnv: string,
): Promise<string | null> => {
  const all = await runGit(
    ctx.executable,
    ['--literal-pathspecs', 'add', '-A', '--', ...paths],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (all.ok) return null;
  if (!/did not match any files/i.test(text(all))) return text(all);
  for (const path of paths) {
    const one = await runGit(
      ctx.executable,
      ['--literal-pathspecs', 'add', '-A', '--', path],
      ctx.toplevelRealPath,
      pathEnv,
    );
    if (!one.ok && !/did not match any files/i.test(text(one))) return text(one);
  }
  return null;
};

interface IndexBackup {
  readonly index: string;
  readonly copy: string;
}

/** A copy of the index, so a commit that fails leaves the staging area exactly as it was. */
const backupIndex = async (
  ctx: GitWorktreeContext,
  pathEnv: string,
): Promise<IndexBackup | null> => {
  const where = await runGit(
    ctx.executable,
    ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
    ctx.toplevelRealPath,
    pathEnv,
  );
  const index = where.stdout.trim();
  if (!where.ok || index.length === 0) return null;
  const copy = `${index}.spence-backup`;
  try {
    await copyFile(index, copy);
    return { index, copy };
  } catch {
    return null;
  }
};

const restoreIndex = async (backup: IndexBackup | null): Promise<void> => {
  if (backup === null) return;
  try {
    await copyFile(backup.copy, backup.index);
  } finally {
    await rm(backup.copy, { force: true });
  }
};

const discardBackup = async (backup: IndexBackup | null): Promise<void> => {
  if (backup !== null) await rm(backup.copy, { force: true });
};

const unique = (paths: ReadonlyArray<string>): string[] => [...new Set(paths)];

/**
 * Commits exactly the given files (their whole current content), leaving every other change, staged or not, as it
 * was. With `push`, pushes right after; a rejected push keeps the commit and says so. Hooks run and their output is
 * returned when they refuse.
 */
export const commitChanges = async (
  folder: string,
  message: string,
  files: ReadonlyArray<CommitFile>,
  push: boolean,
  gitExecutable: string | null,
  pathEnv: string,
  remote?: string,
): Promise<CommitOutcome> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return { _tag: 'Rejected', reason: 'EmptyMessage', detail: 'Write a commit message.' };
  }
  if (files.length === 0) {
    return { _tag: 'Rejected', reason: 'NothingSelected', detail: 'Select at least one file.' };
  }
  const integration = await detectActiveIntegration(ctx.gitDirRealPath);
  if (integration !== 'None') {
    return {
      _tag: 'Rejected',
      reason: 'IntegrationInProgress',
      detail: `A ${integration.toLowerCase()} is in progress; finish it first.`,
    };
  }
  let pushRemote: string | undefined;
  if (push) {
    const target = await pushTarget(ctx, remote, pathEnv);
    if (!target.ok) return { _tag: 'Rejected', reason: target.reason, detail: target.detail };
    pushRemote = target.remote;
  }

  const paths = unique(files.flatMap((file) => [file.path, file.previousPath ?? file.path]));
  const backup = await backupIndex(ctx, pathEnv);
  const added = await stagePaths(ctx, paths, pathEnv);
  if (added !== null) {
    await restoreIndex(backup);
    return { _tag: 'Failed', detail: added };
  }
  const committed = await runGit(
    ctx.executable,
    ['--literal-pathspecs', 'commit', '-F', '-', '--only', '--', ...paths],
    ctx.toplevelRealPath,
    pathEnv,
    `${trimmed}\n`,
    NETWORK_TIMEOUT_MS,
  );
  if (!committed.ok) {
    await restoreIndex(backup);
    return { _tag: 'Failed', detail: text(committed) };
  }
  await discardBackup(backup);

  const head = await runGit(ctx.executable, ['rev-parse', 'HEAD'], ctx.toplevelRealPath, pathEnv);
  const sha = head.stdout.trim();
  if (!head.ok || sha.length < 7) {
    return { _tag: 'Failed', detail: 'The commit was made but Git did not report it.' };
  }
  const shortSha = sha.slice(0, 7);
  if (!push) return { _tag: 'Committed', sha, shortSha, pushed: 'NotRequested' };
  const pushed = await pushWith(ctx, pushRemote, pathEnv);
  return pushed._tag === 'Done'
    ? { _tag: 'Committed', sha, shortSha, pushed: 'Pushed' }
    : {
        _tag: 'Committed',
        sha,
        shortSha,
        pushed: 'Failed',
        pushDetail: 'detail' in pushed ? pushed.detail : 'The push did not finish.',
      };
};
