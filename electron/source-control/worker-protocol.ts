/** Structured-cloneable request/response messages between main and the source-control utility worker. */

export type WorkerCapabilityFailure =
  | {
      readonly _tag: 'MissingGit';
      readonly detail: string;
    }
  | {
      readonly _tag: 'MissingPath';
      readonly path: string;
      readonly detail: string;
    }
  | {
      readonly _tag: 'NonGit';
      readonly path: string;
      readonly detail: string;
    }
  | {
      readonly _tag: 'UnsupportedRepo';
      readonly path: string;
      readonly detail: string;
    }
  | {
      /** Git ran but failed for a passing reason: a timeout, a lock held by another process, ownership. */
      readonly _tag: 'GitFailed';
      readonly path: string;
      readonly detail: string;
    };

export type WorkerHeadState =
  | {
      readonly _tag: 'Branch';
      readonly branch: string;
      readonly ref: string;
      readonly commit?: string;
    }
  | {
      readonly _tag: 'Detached';
      readonly commit: string;
    }
  | {
      readonly _tag: 'Unborn';
      readonly branch: string;
      readonly ref: string;
    };

export type WorkerIntegrationState =
  'None' | 'Merge' | 'Rebase' | 'CherryPick' | 'Revert' | 'Bisect';

export type WorkerFileChangeStatus =
  | 'Added'
  | 'Modified'
  | 'Deleted'
  | 'Renamed'
  | 'Copied'
  | 'TypeChanged'
  | 'Untracked'
  | 'Conflicted';

export type WorkerFileSlotStatus =
  | 'Unmodified'
  | 'Added'
  | 'Modified'
  | 'Deleted'
  | 'Renamed'
  | 'Copied'
  | 'TypeChanged'
  | 'Untracked'
  | 'Conflicted';

export type WorkerFileKind =
  | 'Regular'
  | 'Binary'
  | 'Symlink'
  | 'Submodule'
  | 'TooLarge'
  | 'Special'
  | 'Unreadable'
  | 'Missing';

export type WorkerExcludedReason = 'NestedRepo' | 'SpecialFile' | 'Unreadable' | 'UnsafePath';

export interface WorkerExcludedEntry {
  readonly path: string;
  readonly reason: WorkerExcludedReason;
  readonly detail: string;
}

export interface WorkerChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: WorkerFileChangeStatus;
  readonly indexStatus: WorkerFileSlotStatus;
  readonly workTreeStatus: WorkerFileSlotStatus;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly hasStagedAndUnstaged: boolean;
  readonly stagedNetZeroWorking: boolean;
  readonly kind: WorkerFileKind;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly byteSize?: number;
  readonly unstable?: boolean;
}

export interface WorkerAheadBehind {
  readonly upstream: string;
  readonly ahead: number;
  readonly behind: number;
}

export type WorkerGitStatusResult =
  | WorkerCapabilityFailure
  | {
      readonly _tag: 'Available';
      readonly gitVersion: string;
      readonly executable: string;
      readonly folderRealPath: string;
      readonly toplevelRealPath: string;
      readonly gitDirRealPath: string;
      readonly head: WorkerHeadState;
      readonly aheadBehind?: WorkerAheadBehind;
      readonly integration: WorkerIntegrationState;
      readonly hasConflicts: boolean;
      readonly unstablePaths: ReadonlyArray<string>;
      readonly instabilityDetail?: string;
      readonly excludedEntries: ReadonlyArray<WorkerExcludedEntry>;
      readonly incompleteDiffCounts: boolean;
      readonly files: ReadonlyArray<WorkerChangedFile>;
    };

export type WorkerDiffScope = 'combined' | 'staged' | 'unstaged';

export type WorkerDiffLineKind = 'context' | 'add' | 'delete';

export interface WorkerDiffLine {
  readonly kind: WorkerDiffLineKind;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

export interface WorkerDiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<WorkerDiffLine>;
}

export type WorkerUnavailableDiffReason =
  | 'Binary'
  | 'TooLarge'
  | 'Symlink'
  | 'Submodule'
  | 'SpecialFile'
  | 'Unreadable'
  | 'MissingFile'
  | 'NoDifference';

export type WorkerDiffPreview =
  | {
      readonly _tag: 'Patch';
      readonly path: string;
      readonly previousPath?: string;
      readonly scope: WorkerDiffScope;
      readonly hunks: ReadonlyArray<WorkerDiffHunk>;
      readonly additions: number;
      readonly deletions: number;
      readonly truncated: boolean;
      readonly truncationDetail?: string;
      readonly unstable: boolean;
      readonly instabilityDetail?: string;
    }
  | {
      readonly _tag: 'Unavailable';
      readonly path: string;
      readonly scope: WorkerDiffScope;
      readonly reason: WorkerUnavailableDiffReason;
      readonly detail: string;
      readonly byteSize?: number;
      readonly limitBytes?: number;
      readonly symlinkTarget?: string;
      readonly hasStagedChanges?: boolean;
      readonly unstable: boolean;
      readonly instabilityDetail?: string;
    };

export type WorkerDiffResult =
  | WorkerCapabilityFailure
  | {
      readonly _tag: 'InvalidPath';
      readonly path: string;
      readonly detail: string;
    }
  | {
      readonly _tag: 'Available';
      readonly preview: WorkerDiffPreview;
    };

export interface WorkerCommitSummary {
  readonly sha: string;
  readonly shortSha: string;
  readonly parentShas: ReadonlyArray<string>;
  readonly isMerge: boolean;
  readonly subject: string;
  readonly body: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAtSeconds: number;
  readonly refs: ReadonlyArray<string>;
}

export type WorkerCommitsResult =
  | WorkerCapabilityFailure
  | {
      readonly _tag: 'Unborn';
      readonly branch: string;
      readonly ref: string;
    }
  | {
      readonly _tag: 'History';
      readonly head: WorkerHeadState;
      readonly commits: ReadonlyArray<WorkerCommitSummary>;
      readonly hasMore: boolean;
      readonly nextOffset?: number;
    };

export interface WorkerCommitFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: WorkerFileChangeStatus;
  readonly additions: number | null;
  readonly deletions: number | null;
}

export interface WorkerCommitDetail extends WorkerCommitSummary {
  /** Changed files against the first parent (or the empty tree for a root commit). */
  readonly files: ReadonlyArray<WorkerCommitFile>;
}

export type WorkerCommitDetailResult =
  | WorkerCapabilityFailure
  | {
      readonly _tag: 'UnknownCommit';
      readonly detail: string;
    }
  | {
      readonly _tag: 'Detail';
      readonly commit: WorkerCommitDetail;
    };
