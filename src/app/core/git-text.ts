import type {
  CommitResult,
  DiscardResult,
  GitUnavailableReason,
  PlannedDiscard,
  RemoteRejection,
  RevertResult,
} from '../../shared/source-control/source-control.rpc';
import type { PrepareDraftResult } from '../../shared/worktrees/worktrees.rpc';

/** Why a Session's folder has no Git view, in the user's language. Main sends only the reason. */
export const unavailableText = (reason: GitUnavailableReason): string => {
  switch (reason) {
    case 'MissingGit':
      return $localize`Git is not installed, so changes cannot be shown.`;
    case 'MissingPath':
      return $localize`This Session's folder was not found.`;
    case 'NonGit':
      return $localize`This folder is not a Git repository, so there are no changes to show.`;
    case 'UnsupportedRepo':
      return $localize`This repository uses a Git feature Spence cannot read yet.`;
    case 'GitFailed':
      return $localize`Git did not answer. Try Refresh.`;
  }
};

/** Why Spence did not commit anything. */
export const commitRejectionText = (
  reason: Extract<CommitResult, { _tag: 'Rejected' }>['reason'],
): string => {
  switch (reason) {
    case 'EmptyMessage':
      return $localize`Write a commit message first.`;
    case 'NothingSelected':
      return $localize`Tick at least one file to commit.`;
    case 'IntegrationInProgress':
      return $localize`A merge, rebase or similar is in progress. Finish it in a terminal first.`;
    case 'NoRemote':
      return $localize`This repository has no remote to push to. Nothing was committed.`;
    case 'NeedsRemote':
      return $localize`Choose a remote to push to. Nothing was committed.`;
    case 'UnknownRemote':
      return $localize`That remote does not exist. Nothing was committed.`;
    case 'DetachedHead':
      return $localize`HEAD is not on a branch, so it cannot be pushed. Nothing was committed.`;
  }
};

/** Why a push, pull or fetch was refused. */
export const remoteRejectionText = (reason: RemoteRejection): string => {
  switch (reason) {
    case 'NoRemote':
      return $localize`This repository has no remote.`;
    case 'NeedsRemote':
      return $localize`Choose a remote to push to.`;
    case 'UnknownRemote':
      return $localize`That remote does not exist.`;
    case 'NoUpstream':
      return $localize`This branch does not track a remote branch yet. Push it first.`;
    case 'DetachedHead':
      return $localize`HEAD is not on a branch, so it cannot be pushed.`;
    case 'Behind':
      return $localize`The remote has commits you do not have. Pull first.`;
    case 'Diverged':
      return $localize`Your branch and the remote both have new commits, so Spence cannot pull without a merge. Do that in a terminal.`;
  }
};

/** What discarding does to one file. */
export const discardEffectText = (effect: PlannedDiscard['effect']): string => {
  switch (effect) {
    case 'Restore':
      return $localize`goes back to the last commit`;
    case 'Remove':
      return $localize`is deleted`;
    case 'UndoRename':
      return $localize`rename is undone`;
  }
};

/** Why nothing was discarded. */
export const discardRejectionText = (
  reason: Extract<DiscardResult, { _tag: 'Rejected' }>['reason'],
): string => {
  switch (reason) {
    case 'NothingSelected':
      return $localize`None of the selected files are changed any more.`;
    case 'Conflicted':
      return $localize`A selected file is in conflict. Resolve it in a terminal first.`;
    case 'IntegrationInProgress':
      return $localize`A merge, rebase or similar is in progress. Finish it in a terminal first.`;
    case 'Stale':
      return $localize`The files changed after you looked, so nothing was discarded. Review them again.`;
  }
};

/** Why a commit was not reverted. */
export const revertRejectionText = (
  reason: Extract<RevertResult, { _tag: 'Rejected' }>['reason'],
): string => {
  switch (reason) {
    case 'UnknownCommit':
      return $localize`That commit no longer exists.`;
    case 'NotInBranch':
      return $localize`That commit is not part of this branch.`;
    case 'MergeCommit':
      return $localize`A merge commit cannot be reverted here.`;
    case 'DirtyTree':
      return $localize`Commit or discard your changes before reverting.`;
    case 'IntegrationInProgress':
      return $localize`A merge, rebase or similar is in progress. Finish it in a terminal first.`;
    case 'Conflict':
      return $localize`Reverting would conflict with later changes, so nothing was changed.`;
  }
};

/** Why the worktree for a new Session was not made, so the first message was not sent. */
export const prepareRejectionText = (
  reason: Extract<PrepareDraftResult, { _tag: 'Rejected' }>['reason'],
): string => {
  switch (reason) {
    case 'InvalidBranch':
      return $localize`That is not a valid branch name.`;
    case 'BranchExists':
      return $localize`A branch with that name already exists.`;
    case 'DestinationExists':
      return $localize`The folder for that worktree already exists.`;
    case 'UnknownBase':
      return $localize`The branch to start from no longer exists.`;
    case 'PullRequestRefUnavailable':
      return $localize`This Pull request's head ref is no longer fetchable.`;
    case 'Busy':
      return $localize`This Session already has messages, so it stays in its worktree.`;
    case 'StartFailed':
      return $localize`The worktree was created, but the Session could not move into it.`;
  }
};
