import type { CommitReviewEntry, CommitSelection } from './commit-schema';
import type { ChangedFileEntry, FileSlotStatus } from './source-control.rpc';

type Blocker = { readonly code: string; readonly detail: string };

/** Map status snapshots into review candidates without performing any Git operations. */
export function mapCommitReviewEntries(
  files: readonly ChangedFileEntry[],
  selection: CommitSelection,
): { entries: readonly CommitReviewEntry[]; blockers: readonly Blocker[] } {
  const entries: CommitReviewEntry[] = [];
  const blockers: Blocker[] = [];
  const supported = (slot: FileSlotStatus) =>
    slot === 'Unmodified' ||
    slot === 'Added' ||
    slot === 'Modified' ||
    slot === 'Deleted' ||
    slot === 'Untracked';

  for (const file of files) {
    if (
      file.previousPath !== undefined ||
      !supported(file.indexStatus) ||
      !supported(file.workTreeStatus) ||
      !supported(file.status) ||
      (file.indexStatus === 'Unmodified' && file.workTreeStatus === 'Unmodified')
    ) {
      blockers.push({ code: 'UnsupportedStatus', detail: `Unsupported status for ${file.path}` });
      continue;
    }
    const selected = selection._tag === 'All' || selection.paths.includes(file.path);
    const untracked = file.status === 'Untracked';
    const staged = !untracked && file.indexStatus !== 'Unmodified';
    const workingTreeChanged = file.workTreeStatus !== 'Unmodified';
    const change = untracked
      ? 'Untracked'
      : file.workTreeStatus === 'Deleted'
        ? 'Deleted'
        : file.indexStatus === 'Added'
          ? 'Added'
          : file.indexStatus === 'Deleted'
            ? 'Deleted'
            : file.workTreeStatus === 'Added'
              ? 'Added'
              : 'Modified';
    entries.push({
      path: file.path,
      selected,
      change,
      eligible: true,
      staged,
      workingTreeChanged,
      hasNewerWorkingContent: staged && workingTreeChanged,
      preservesUnselectedStaging: !selected && staged,
    });
  }
  return { entries, blockers };
}
