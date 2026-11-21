import type { DiffLine } from './diff-model';

/** One row of the Split layout: the old side on the left, the new side on the right. */
export interface SplitRow {
  readonly left: DiffLine | null;
  readonly right: DiffLine | null;
}

/**
 * Lays the lines of one hunk out side by side. A run of deletions followed by a run of additions is paired
 * line by line (the longer run leaves gaps on the other side); context lines appear on both sides.
 */
export const toSplitRows = (lines: ReadonlyArray<DiffLine>): ReadonlyArray<SplitRow> => {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const deleted: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (lines[index]?.kind === 'delete') {
      const next = lines[index];
      if (next !== undefined) deleted.push(next);
      index += 1;
    }
    while (lines[index]?.kind === 'add') {
      const next = lines[index];
      if (next !== undefined) added.push(next);
      index += 1;
    }
    const height = Math.max(deleted.length, added.length);
    for (let row = 0; row < height; row += 1) {
      rows.push({ left: deleted[row] ?? null, right: added[row] ?? null });
    }
  }
  return rows;
};
