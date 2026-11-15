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
    };

export type WorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: { readonly pid: number } | GitProbeResult | { readonly stopped: true };
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly reason: 'UnsupportedRequest' | 'ExecutionFailed';
      readonly detail: string;
    };
