import path from 'node:path';
import { gitFailure, realPathOrNull, resolveWorktreeContext, runGit } from './git-exec';
import type { WorkerCapabilityFailure } from './worker-protocol';

export interface BranchEntry {
  readonly name: string;
  /** The branch this folder has checked out. */
  readonly current: boolean;
  /** Where another Worktree has it checked out; a branch cannot be checked out twice. */
  readonly checkedOutAt?: string;
}

export type BranchesOutcome =
  | WorkerCapabilityFailure
  | { readonly _tag: 'Available'; readonly branches: ReadonlyArray<BranchEntry> };

const sameFolder = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The local branches of the repository, by name. */
export const listBranches = async (
  folder: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<BranchesOutcome> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  const result = await runGit(
    ctx.executable,
    ['for-each-ref', '--sort=refname', '--format=%(refname:short)%09%(worktreepath)', 'refs/heads'],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (!result.ok) return gitFailure(folder, result, 'Failed to list Git branches.');
  const branches: BranchEntry[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const [name = '', where = ''] = line.split('\t');
    const checkedOut = where.trim();
    const real = checkedOut === '' ? null : await realPathOrNull(path.normalize(checkedOut));
    const here = real !== null && sameFolder(real, ctx.toplevelRealPath);
    branches.push({
      name,
      current: here,
      ...(checkedOut === '' || here ? {} : { checkedOutAt: path.normalize(checkedOut) }),
    });
  }
  return { _tag: 'Available', branches };
};
