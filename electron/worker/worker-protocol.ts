/** Structured-cloneable request/response messages between main and the source-control utility worker. */

export interface RawWorktreeChangeSummary {
  readonly changedFiles: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface RawWorktreeRecord {
  readonly rawPath: string;
  readonly realPath?: string;
  readonly folderIdentity?: string;
  readonly exists: boolean;
  readonly headCommit?: string;
  readonly branch?: string;
  readonly branchRef?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly prunableReason?: string;
  readonly lockedReason?: string;
  readonly changes?: RawWorktreeChangeSummary;
}

export type GitProbeResult =
  | {
      readonly _tag: 'Available';
      readonly gitVersion: string;
      readonly executable: string;
      readonly folderRealPath: string;
      readonly toplevelRealPath?: string;
      readonly toplevelFolderIdentity?: string;
      readonly commonDirRealPath: string;
      readonly commonDirIdentity?: string;
      readonly gitDirRealPath: string;
      readonly gitDirIdentity?: string;
      readonly worktrees: ReadonlyArray<RawWorktreeRecord>;
    }
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
    };

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

export interface WorkerCommitChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: Exclude<WorkerFileChangeStatus, 'Untracked' | 'Conflicted'>;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export type WorkerCommitDetailResult =
  | WorkerCapabilityFailure
  | {
      readonly _tag: 'InvalidCommit';
      readonly sha: string;
      readonly detail: string;
    }
  | {
      readonly _tag: 'Commit';
      readonly commit: WorkerCommitSummary;
      readonly files: ReadonlyArray<WorkerCommitChangedFile>;
      readonly truncatedFiles: boolean;
    };

export type WorkerCommitFileDiffResult =
  | WorkerCapabilityFailure
  | {
      readonly _tag: 'InvalidCommit';
      readonly sha: string;
      readonly detail: string;
    }
  | {
      readonly _tag: 'InvalidPath';
      readonly path: string;
      readonly detail: string;
    }
  | {
      readonly _tag: 'Available';
      readonly preview: WorkerDiffPreview;
    };
import type { FilesDirectoryPage, FilesPreview } from '../../src/shared/files/files.rpc';

/** Typed worker-side file failure reasons preserved across the worker IPC boundary. */
export type WorkerFilesErrorReason = 'NotFound' | 'OutsideRoot' | 'UnsupportedFile' | 'IoFailed';

export type WorkerRequest =
  | {
      readonly id: number;
      readonly method: 'ping';
    }
  | {
      readonly id: number;
      readonly method: 'shutdown';
    }
  | {
      readonly id: number;
      readonly method: 'git.probe';
      readonly folder: string;
      readonly gitExecutable: string | null;
      readonly pathEnv: string;
    }
  | {
      readonly id: number;
      readonly method: 'git.status';
      readonly folder: string;
      readonly gitExecutable: string | null;
      readonly pathEnv: string;
    }
  | {
      readonly id: number;
      readonly method: 'git.diff';
      readonly folder: string;
      readonly path: string;
      readonly scope: WorkerDiffScope;
      readonly gitExecutable: string | null;
      readonly pathEnv: string;
    }
  | {
      readonly id: number;
      readonly method: 'git.commits';
      readonly folder: string;
      readonly limit: number;
      readonly offset: number;
      readonly gitExecutable: string | null;
      readonly pathEnv: string;
    }
  | {
      readonly id: number;
      readonly method: 'files.listDir';
      readonly rootPath: string;
      readonly expectedRootIdentity: string | null;
      readonly dirPath: string;
      readonly cursor?: string;
      readonly limit: number;
      readonly showIgnoredFiles: boolean;
      readonly gitExecutable: string | null;
      readonly pathEnv: string;
    }
  | {
      readonly id: number;
      readonly method: 'git.commitDetail';
      readonly folder: string;
      readonly sha: string;
      readonly gitExecutable: string | null;
      readonly pathEnv: string;
    }
  | {
      readonly id: number;
      readonly method: 'git.commitFileDiff';
      readonly folder: string;
      readonly sha: string;
      readonly path: string;
      readonly gitExecutable: string | null;
      readonly pathEnv: string;
    }
  | {
      readonly id: number;
      readonly method: 'files.readPreview';
      readonly rootPath: string;
      readonly expectedRootIdentity: string | null;
      readonly relativePath: string;
      readonly maxBytes: number;
    }
  | {
      readonly id: number;
      readonly method: 'files.validateOpenTarget';
      readonly rootPath: string;
      readonly expectedRootIdentity: string | null;
      readonly relativePath: string;
    };

export type WorkerResponseResult =
  | { readonly pid: number }
  | { readonly stopped: true }
  | GitProbeResult
  | WorkerGitStatusResult
  | WorkerDiffResult
  | WorkerCommitsResult
  | WorkerCommitDetailResult
  | WorkerCommitFileDiffResult
  | FilesDirectoryPage
  | FilesPreview
  | { readonly targetPath: string };

export type WorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: WorkerResponseResult;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly reason: 'UnsupportedRequest' | 'ExecutionFailed' | WorkerFilesErrorReason;
      readonly detail: string;
    };
