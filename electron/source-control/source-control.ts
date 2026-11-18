import { Context, Effect, Layer } from 'effect';
import {
  SourceControlError,
  type ChangedFile,
  type ChangesResult,
  type CommitsResult,
  type DiffResult,
  type DiffScope,
  type HeadState,
} from '../../src/shared/source-control/source-control.rpc';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { Sessions } from '../sessions/sessions';
import { toWireDefect } from '../../src/shared/rpc/wire-error';
import { listGitCommits } from './git-commits';
import { inspectGitDiff, inspectGitStatus } from './git-status-diff';
import type {
  WorkerCapabilityFailure,
  WorkerChangedFile,
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

export const toChangesResult = (result: WorkerGitStatusResult): ChangesResult =>
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

export const layerSourceControl = Layer.effect(
  SourceControl,
  Effect.gen(function* () {
    const folders = yield* SessionFolders;
    const run = <A>(work: () => Promise<A>) => toWireDefect(Effect.tryPromise(work));
    return {
      changes: (id) =>
        folders
          .folderOf(id)
          .pipe(
            Effect.flatMap((folder) =>
              run(() => inspectGitStatus(folder, GIT, pathEnv())).pipe(Effect.map(toChangesResult)),
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
