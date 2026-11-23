import { Context, Effect, Layer } from 'effect';
import { shell } from 'electron';
import { pathToFileURL } from 'node:url';
import {
  SourceControlError,
  type BranchesResult,
  type ChangedFile,
  type ChangesResult,
  type CommitDetailResult,
  type CommitFile,
  type CommitResult,
  type CommitsResult,
  type DiffResult,
  type DiffScope,
  type DiscardResult,
  type HeadState,
  type PrepareDiscardResult,
  type RemoteResult,
  type RevertResult,
} from '../../src/shared/source-control/source-control.rpc';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { Sessions } from '../sessions/sessions';
import { toWireDefect } from '../../src/shared/rpc/wire-error';
import {
  commitChanges,
  fetchRemote,
  listRemotes,
  pullFastForward,
  pushBranch,
  type CommitOutcome,
  type RemoteOutcome,
} from './git-actions';
import { listBranches, type BranchesOutcome } from './git-branches';
import { getCommitDetail, getCommitFileDiff, listGitCommits } from './git-commits';
import {
  discardChanges,
  prepareDiscard,
  RECOVERY_DAYS,
  revertCommit,
  type DiscardOutcome,
  type PrepareOutcome,
  type RevertOutcome,
} from './git-discard';
import { inspectGitDiff, inspectGitStatus } from './git-status-diff';
import type {
  WorkerCapabilityFailure,
  WorkerChangedFile,
  WorkerCommitDetailResult,
  WorkerCommitsResult,
  WorkerDiffResult,
  WorkerGitStatusResult,
  WorkerHeadState,
} from './worker-protocol';

/** Where a Session works; the seam that lets tests point Source control at a disposable repository. */
export class SessionFolders extends Context.Service<
  SessionFolders,
  { readonly folderOf: (id: SessionId) => Effect.Effect<string, SourceControlError> }
>()('source-control/SessionFolders') {}

export const layerSessionFoldersLive = Layer.effect(
  SessionFolders,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    return {
      folderOf: (id: SessionId) =>
        sessions
          .folderOf(id)
          .pipe(
            Effect.mapError(
              () =>
                new SourceControlError({ reason: 'SessionNotFound', detail: `No Session ${id}.` }),
            ),
          ),
    };
  }),
);

/** Where copies of discarded changes are kept; the seam that lets tests use a temporary folder. */
export class RecoveryRoot extends Context.Service<RecoveryRoot, { readonly folder: string }>()(
  'source-control/RecoveryRoot',
) {}

export interface SourceControlShape {
  readonly changes: (id: SessionId) => Effect.Effect<ChangesResult, SourceControlError>;
  readonly diff: (
    id: SessionId,
    path: string,
    scope: DiffScope,
    previousPath?: string,
  ) => Effect.Effect<DiffResult, SourceControlError>;
  readonly commits: (
    id: SessionId,
    limit: number,
    offset: number,
  ) => Effect.Effect<CommitsResult, SourceControlError>;
  readonly commitDetail: (
    id: SessionId,
    sha: string,
  ) => Effect.Effect<CommitDetailResult, SourceControlError>;
  readonly commitDiff: (
    id: SessionId,
    sha: string,
    path: string,
    previousPath?: string,
  ) => Effect.Effect<DiffResult, SourceControlError>;
  readonly commit: (
    id: SessionId,
    message: string,
    files: ReadonlyArray<CommitFile>,
    push: boolean,
    remote?: string,
  ) => Effect.Effect<CommitResult, SourceControlError>;
  readonly prepareDiscard: (
    id: SessionId,
    files: ReadonlyArray<CommitFile>,
  ) => Effect.Effect<PrepareDiscardResult, SourceControlError>;
  readonly discard: (
    id: SessionId,
    files: ReadonlyArray<CommitFile>,
    token: string,
  ) => Effect.Effect<DiscardResult, SourceControlError>;
  readonly revert: (id: SessionId, sha: string) => Effect.Effect<RevertResult, SourceControlError>;
  readonly branches: (id: SessionId) => Effect.Effect<BranchesResult, SourceControlError>;
  readonly fetch: (id: SessionId) => Effect.Effect<RemoteResult, SourceControlError>;
  readonly pull: (id: SessionId) => Effect.Effect<RemoteResult, SourceControlError>;
  readonly openEditor: (id: SessionId) => Effect.Effect<boolean, SourceControlError>;
  readonly push: (
    id: SessionId,
    remote?: string,
  ) => Effect.Effect<RemoteResult, SourceControlError>;
}

export class SourceControl extends Context.Service<SourceControl, SourceControlShape>()(
  'source-control/SourceControl',
) {}

const GIT = 'git';
const pathEnv = (): string => process.env['PATH'] ?? process.env['Path'] ?? '';

const toHead = (head: WorkerHeadState): HeadState =>
  head._tag === 'Detached'
    ? { _tag: 'Detached', commit: head.commit }
    : { _tag: head._tag, branch: head.branch };

const toFile = (file: WorkerChangedFile): ChangedFile => ({
  path: file.path,
  ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
  status: file.status,
  staged: file.staged,
  unstaged: file.unstaged,
  kind: file.kind,
  additions: file.additions,
  deletions: file.deletions,
  ...(file.unstable === true ? { unstable: true } : {}),
});

const unavailable = (result: WorkerCapabilityFailure) => ({
  _tag: 'Unavailable' as const,
  reason: result._tag,
  detail: result.detail,
});

export const toChangesResult = (
  result: WorkerGitStatusResult,
  remotes: ReadonlyArray<string> = [],
): ChangesResult =>
  result._tag !== 'Available'
    ? unavailable(result)
    : {
        _tag: 'Available',
        head: toHead(result.head),
        ...(result.aheadBehind === undefined
          ? {}
          : {
              upstream: {
                name: result.aheadBehind.upstream,
                ahead: result.aheadBehind.ahead,
                behind: result.aheadBehind.behind,
              },
            }),
        integration: result.integration,
        files: result.files.map(toFile),
        excludedCount: result.excludedEntries.length,
        remotes,
      };

export const toDiffResult = (result: WorkerDiffResult): DiffResult => {
  if (result._tag === 'InvalidPath') return { _tag: 'InvalidPath', detail: result.detail };
  if (result._tag !== 'Available') return unavailable(result);
  const preview = result.preview;
  return preview._tag === 'Patch'
    ? {
        _tag: 'Patch',
        hunks: preview.hunks.map((hunk) => ({ header: hunk.header, lines: hunk.lines })),
        additions: preview.additions,
        deletions: preview.deletions,
        truncated: preview.truncated,
      }
    : { _tag: 'NoPreview', reason: preview.reason, detail: preview.detail };
};

export const toCommitsResult = (result: WorkerCommitsResult): CommitsResult => {
  if (result._tag === 'Unborn') return { _tag: 'Unborn', branch: result.branch };
  if (result._tag !== 'History') return unavailable(result);
  return {
    _tag: 'History',
    hasMore: result.hasMore,
    commits: result.commits.map((commit) => ({
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      authorName: commit.authorName,
      authoredAtSeconds: commit.authoredAtSeconds,
      isMerge: commit.isMerge,
      refs: commit.refs,
    })),
  };
};

export const toCommitDetailResult = (result: WorkerCommitDetailResult): CommitDetailResult => {
  if (result._tag === 'UnknownCommit') return { _tag: 'UnknownCommit', detail: result.detail };
  if (result._tag !== 'Detail') return unavailable(result);
  const commit = result.commit;
  return {
    _tag: 'Detail',
    commit: {
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      body: commit.body,
      authorName: commit.authorName,
      authoredAtSeconds: commit.authoredAtSeconds,
      isMerge: commit.isMerge,
      refs: commit.refs,
      files: commit.files.map((file) => ({
        path: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      })),
    },
  };
};

export const toRemoteResult = (outcome: RemoteOutcome): RemoteResult =>
  outcome._tag === 'Done' || outcome._tag === 'Rejected' || outcome._tag === 'Failed'
    ? outcome
    : unavailable(outcome);

export const toCommitResult = (outcome: CommitOutcome): CommitResult =>
  outcome._tag === 'Committed' || outcome._tag === 'Rejected' || outcome._tag === 'Failed'
    ? outcome
    : unavailable(outcome);

export const toPrepareDiscardResult = (outcome: PrepareOutcome): PrepareDiscardResult =>
  outcome._tag === 'Ready' || outcome._tag === 'Rejected' ? outcome : unavailable(outcome);

export const toDiscardResult = (outcome: DiscardOutcome): DiscardResult =>
  outcome._tag === 'Discarded'
    ? {
        _tag: 'Discarded',
        count: outcome.count,
        recoveryFolder: outcome.recovery.folder,
        recoveryDays: RECOVERY_DAYS,
      }
    : outcome._tag === 'Rejected' || outcome._tag === 'Failed'
      ? outcome
      : unavailable(outcome);

export const toRevertResult = (outcome: RevertOutcome): RevertResult =>
  outcome._tag === 'Reverted' || outcome._tag === 'Rejected' || outcome._tag === 'Failed'
    ? outcome
    : unavailable(outcome);

export const toBranchesResult = (outcome: BranchesOutcome): BranchesResult =>
  outcome._tag === 'Available' ? outcome : unavailable(outcome);

export const layerSourceControl = Layer.effect(
  SourceControl,
  Effect.gen(function* () {
    const folders = yield* SessionFolders;
    const recovery = yield* RecoveryRoot;
    const run = <A>(work: () => Promise<A>) => toWireDefect(Effect.tryPromise(work));
    return {
      changes: (id) =>
        folders.folderOf(id).pipe(
          Effect.flatMap((folder) =>
            run(async () => {
              const status = await inspectGitStatus(folder, GIT, pathEnv());
              // The remote to push to is a choice only while the branch has no upstream.
              const needsRemotes = status._tag === 'Available' && status.aheadBehind === undefined;
              return toChangesResult(
                status,
                needsRemotes ? await listRemotes(folder, GIT, pathEnv()) : [],
              );
            }),
          ),
        ),
      diff: (id, path, scope, previousPath) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() =>
                inspectGitDiff(folder, path, scope, GIT, pathEnv(), undefined, previousPath),
              ).pipe(Effect.map(toDiffResult)),
            ),
          ),
      commitDetail: (id, sha) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => getCommitDetail(folder, sha, GIT, pathEnv())).pipe(
                Effect.map(toCommitDetailResult),
              ),
            ),
          ),
      commitDiff: (id, sha, path, previousPath) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => getCommitFileDiff(folder, sha, path, GIT, pathEnv(), previousPath)).pipe(
                Effect.map(toDiffResult),
              ),
            ),
          ),
      commit: (id, message, files, push, remote) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => commitChanges(folder, message, files, push, GIT, pathEnv(), remote)).pipe(
                Effect.map(toCommitResult),
              ),
            ),
          ),
      prepareDiscard: (id, files) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => prepareDiscard(folder, files, GIT, pathEnv())).pipe(
                Effect.map(toPrepareDiscardResult),
              ),
            ),
          ),
      discard: (id, files, token) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() =>
                discardChanges(folder, files, token, recovery.folder, Date.now(), GIT, pathEnv()),
              ).pipe(Effect.map(toDiscardResult)),
            ),
          ),
      revert: (id, sha) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => revertCommit(folder, sha, GIT, pathEnv())).pipe(Effect.map(toRevertResult)),
            ),
          ),
      branches: (id) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => listBranches(folder, GIT, pathEnv())).pipe(Effect.map(toBranchesResult)),
            ),
          ),
      fetch: (id) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => fetchRemote(folder, GIT, pathEnv())).pipe(Effect.map(toRemoteResult)),
            ),
          ),
      pull: (id) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => pullFastForward(folder, GIT, pathEnv())).pipe(Effect.map(toRemoteResult)),
            ),
          ),
      openEditor: (id) =>
        folders.folderOf(id).pipe(
          Effect.flatMap((folder) =>
            Effect.tryPromise(() =>
              shell.openExternal(`vscode://file${pathToFileURL(folder).pathname}`),
            ).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            ),
          ),
        ),
      push: (id, remote) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => pushBranch(folder, remote, GIT, pathEnv())).pipe(
                Effect.map(toRemoteResult),
              ),
            ),
          ),
      commits: (id, limit, offset) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => listGitCommits(folder, limit, offset, GIT, pathEnv())).pipe(
                Effect.map(toCommitsResult),
              ),
            ),
          ),
    };
  }),
);
