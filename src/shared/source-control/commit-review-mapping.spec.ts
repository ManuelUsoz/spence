import { describe, expect, it } from 'vitest';
import type { ChangedFileEntry } from './source-control.rpc';
import { mapCommitReviewEntries } from './commit-review-mapping';

const file = (overrides: Partial<ChangedFileEntry>): ChangedFileEntry => ({
  path: 'a',
  status: 'Modified',
  indexStatus: 'Modified',
  workTreeStatus: 'Modified',
  staged: true,
  unstaged: true,
  hasStagedAndUnstaged: true,
  stagedNetZeroWorking: false,
  kind: 'Regular',
  additions: null,
  deletions: null,
  ...overrides,
});

describe('mapCommitReviewEntries', () => {
  it('groups a recreated file and reports missing selections while ignoring unrelated unsupported paths', () => {
    const result = mapCommitReviewEntries(
      [
        file({
          path: 'a',
          status: 'Deleted',
          indexStatus: 'Deleted',
          workTreeStatus: 'Unmodified',
        }),
        file({
          path: 'a',
          status: 'Untracked',
          indexStatus: 'Untracked',
          workTreeStatus: 'Untracked',
        }),
        file({ path: 'rename', status: 'Renamed', indexStatus: 'Renamed', previousPath: 'old' }),
        file({ path: 'conflict', status: 'Conflicted', indexStatus: 'Conflicted' }),
      ],
      { _tag: 'Selected', paths: ['a', 'missing'] },
    );
    expect(result.entries).toMatchObject([
      { path: 'a', change: 'Modified', staged: true, workingTreeChanged: true },
    ]);
    expect(result.blockers).toEqual([
      expect.objectContaining({
        code: 'UnsupportedStatus',
        detail: expect.stringContaining('conflict'),
      }),
      expect.objectContaining({ code: 'MissingPath', detail: expect.stringContaining('missing') }),
    ]);
  });
  it('retains selection and distinguishes staged and working content', () => {
    const result = mapCommitReviewEntries(
      [file({}), file({ path: 'b', workTreeStatus: 'Unmodified' })],
      { _tag: 'Selected', paths: ['a'] },
    );
    expect(result.blockers).toEqual([]);
    expect(result.entries).toMatchObject([
      { selected: true, staged: true, workingTreeChanged: true, hasNewerWorkingContent: true },
      {
        selected: false,
        staged: true,
        workingTreeChanged: false,
        preservesUnselectedStaging: true,
      },
    ]);
  });

  it('maps untracked and deleted files and blocks renames and unsupported slots', () => {
    const result = mapCommitReviewEntries(
      [
        file({ status: 'Untracked', indexStatus: 'Untracked', workTreeStatus: 'Untracked' }),
        file({
          path: 'gone',
          status: 'Deleted',
          indexStatus: 'Unmodified',
          workTreeStatus: 'Deleted',
        }),
        file({ path: 'rename', status: 'Renamed', indexStatus: 'Renamed', previousPath: 'old' }),
        file({ path: 'conflict', status: 'Conflicted', indexStatus: 'Conflicted' }),
      ],
      { _tag: 'All' },
    );
    expect(result.entries).toMatchObject([
      { change: 'Untracked', staged: false, workingTreeChanged: true },
      { change: 'Deleted', staged: false, workingTreeChanged: true },
    ]);
    expect(result.blockers).toHaveLength(2);
  });
});
