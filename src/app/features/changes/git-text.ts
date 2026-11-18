import type { GitUnavailableReason } from '../../../shared/source-control/source-control.rpc';

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
