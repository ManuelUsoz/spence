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

/** Summary of a local Git branch for Create Worktree eligibility checks. */
export interface GitEligibleBranch {
  readonly name: string;
  readonly commit: string;
  readonly checkedOut: boolean;
}

/** Preflight checks for a proposed Worktree destination folder. */
export interface GitDestinationCheck {
  readonly destinationPath: string;
  readonly normalizedPath: string;
  readonly resolvedRealPath: string | null;
  readonly parentExists: boolean;
  readonly destinationExists: boolean;
  readonly destinationIsDirectory: boolean;
  readonly destinationIsEmpty: boolean | null;
  readonly insideSourceOrRepo: boolean;
  readonly containsExistingWorktree: boolean;
  readonly touchesGitAdmin: boolean;
}

/** Preflight checks for a proposed branch name at Worktree creation time. */
export interface GitBranchCheck {
  readonly branch: string;
  readonly validName: boolean;
  readonly exists: boolean;
  readonly existingCommit: string | null;
  readonly checkedOutElsewhere: boolean;
}

export type GitCreateContextHead =
  | { readonly _tag: 'Branch'; readonly branch: string; readonly commit: string }
  | { readonly _tag: 'Detached'; readonly commit: string }
  | { readonly _tag: 'Unborn'; readonly branch: string | null };

/** Rich repository inspection result used when reviewing or validating Worktree creation. */
export type GitCreateContextResult =
  | {
      readonly _tag: 'Available';
      readonly folder: string;
      readonly folderRealPath: string;
      readonly commonDirRealPath: string;
      readonly commonDirIdentity: string | null;
      readonly worktreePath: string;
      readonly worktreeRealPath: string;
      readonly head: GitCreateContextHead;
      readonly dirtyCount: number;
      readonly integrationActive: string | null;
      readonly branches: ReadonlyArray<GitEligibleBranch>;
      readonly branchesDigest: string;
      readonly worktreePaths: ReadonlyArray<string>;
      readonly destinationCheck?: GitDestinationCheck;
      readonly branchCheck?: GitBranchCheck;
    }
  | {
      readonly _tag: 'MissingGit' | 'NonGit' | 'MissingPath' | 'UnsupportedRepo';
      readonly folder: string;
      readonly detail: string;
    };

export interface GitCreateWorktreeInput {
  readonly folder: string;
  readonly destinationPath: string;
  readonly expectedCommonDirRealPath: string;
  readonly expectedCommonDirIdentity: string | null;
  readonly mode: 'NewBranch' | 'ExistingBranch';
  readonly branch: string;
  readonly startPoint: string;
}

export interface GitCreateWorktreeResult {
  readonly destinationRealPath: string;
  readonly destinationIdentity: string | null;
  readonly branch: string;
  readonly commit: string;
}

export interface GitPostWorktreeCreateInspection {
  readonly folderExists: boolean;
  readonly folderEmpty: boolean;
  readonly registeredInGit: boolean;
  readonly registeredBranch: string | null;
  readonly branchExists: boolean;
  readonly branchCommit: string | null;
  readonly clean: boolean | null;
  readonly headCommit: string | null;
  readonly destinationRealPath: string | null;
  readonly gitAvailable: boolean;
  readonly repoAvailable: boolean;
  readonly detail: string;
}
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
      readonly method: 'git.inspectCreateContext';
      readonly folder: string;
      readonly destinationPath?: string;
      readonly branch?: string;
      readonly gitExecutable: string | null;
      readonly pathEnv: string;
    }
  | ({
      readonly id: number;
      readonly method: 'git.createWorktree';
      readonly gitExecutable: string | null;
      readonly pathEnv: string;
    } & GitCreateWorktreeInput)
  | {
      readonly id: number;
      readonly method: 'git.inspectPostWorktreeCreate';
      readonly folder: string;
      readonly destinationPath: string;
      readonly branch: string;
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

export type WorkerResponseErrorReason =
  | 'UnsupportedRequest'
  | 'ExecutionFailed'
  | 'InvalidInput'
  | 'UntrustedPath'
  | 'Conflict'
  | 'MissingGit';

export type WorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result:
        | { readonly pid: number }
        | GitProbeResult
        | GitCreateContextResult
        | GitCreateWorktreeResult
        | GitPostWorktreeCreateInspection
        | { readonly stopped: true }
        | FilesDirectoryPage
        | FilesPreview
        | { readonly targetPath: string };
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly reason: WorkerResponseErrorReason | WorkerFilesErrorReason;
      readonly detail: string;
    };
