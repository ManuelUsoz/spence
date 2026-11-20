import type { FileChangeStatus } from '../../../shared/source-control/source-control.rpc';

const STATUS_MARK: Record<FileChangeStatus, string> = {
  Added: 'A',
  Modified: 'M',
  Deleted: 'D',
  Renamed: 'R',
  Copied: 'C',
  TypeChanged: 'T',
  Untracked: 'U',
  Conflicted: '!',
};

/** The one-letter mark of a file's status, as Git shows it. */
export const statusMark = (status: FileChangeStatus): string => STATUS_MARK[status];

/** Green for new files, red for removed or conflicted ones, quiet for the rest. */
export const statusClass = (status: FileChangeStatus): string => {
  if (status === 'Added' || status === 'Untracked') return 'text-diff-add';
  if (status === 'Deleted' || status === 'Conflicted') return 'text-diff-del';
  return 'text-muted-foreground';
};

export const statusLabel = (status: FileChangeStatus): string => {
  switch (status) {
    case 'Added':
      return $localize`Added`;
    case 'Modified':
      return $localize`Modified`;
    case 'Deleted':
      return $localize`Deleted`;
    case 'Renamed':
      return $localize`Renamed`;
    case 'Copied':
      return $localize`Copied`;
    case 'TypeChanged':
      return $localize`Type changed`;
    case 'Untracked':
      return $localize`New, not tracked yet`;
    case 'Conflicted':
      return $localize`Conflicted`;
  }
};

/** Splits `a/b/c.ts` into its folder (`a/b`) and its name (`c.ts`). */
export const splitPath = (path: string): { readonly dir: string; readonly name: string } => {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
};
