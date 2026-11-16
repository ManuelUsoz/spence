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

  const groups = new Map<string, ChangedFileEntry[]>();
  for (const file of files) {
    const group = groups.get(file.path) ?? [];
    group.push(file);
    groups.set(file.path, group);
  }
  for (const [path, group] of groups) {
    const selected = selection._tag === 'All' || selection.paths.includes(path);
    const conflict = group.some(
      (item) =>
        item.status === 'Conflicted' ||
        item.indexStatus === 'Conflicted' ||
        item.workTreeStatus === 'Conflicted',
    );
    const file = group.find((item) => item.status === 'Untracked') ?? group[0];
    if (file === undefined) continue;
    if (
      group.some(
        (item) =>
          item.previousPath !== undefined ||
          !supported(item.indexStatus) ||
          !supported(item.workTreeStatus) ||
          !supported(item.status) ||
          (item.indexStatus === 'Unmodified' && item.workTreeStatus === 'Unmodified'),
      )
    ) {
      if (selected || conflict)
        blockers.push({ code: 'UnsupportedStatus', detail: `Unsupported status for ${file.path}` });
      continue;
    }
    const untracked = file.status === 'Untracked';
    const staged = group.some(
      (item) => item.status !== 'Untracked' && item.indexStatus !== 'Unmodified',
    );
    const workingTreeChanged = group.some((item) => item.workTreeStatus !== 'Unmodified');
    const change = untracked
      ? staged
        ? 'Modified'
        : 'Untracked'
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
  if (selection._tag === 'Selected') {
    for (const path of new Set(selection.paths)) {
      if (!groups.has(path))
        blockers.push({
          code: 'MissingPath',
          detail: `Selected path is no longer changed: ${path}`,
        });
    }
  }
  return { entries, blockers };
}
