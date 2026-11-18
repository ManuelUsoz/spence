import type {
  CommitResult,
  GitUnavailableReason,
  RemoteRejection,
} from '../../../shared/source-control/source-control.rpc';

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
