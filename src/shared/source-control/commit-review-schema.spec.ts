import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { CommitReviewEntry } from './commit-schema';
import { CommitOperationResult, OperationKind } from './operation-schema';

describe('commit review and durable result', () => {
  it('accepts deletion and untracked entries while retaining staging information', () => {
    for (const change of ['Deleted', 'Untracked']) {
      expect(
        Schema.decodeUnknownResult(CommitReviewEntry)({
          path: 'file',
          selected: false,
          change,
          eligible: true,
          staged: true,
          workingTreeChanged: true,
          hasNewerWorkingContent: true,
          preservesUnselectedStaging: true,
        })._tag,
      ).toBe('Success');
    }
    expect(
      Schema.decodeUnknownResult(CommitReviewEntry)({
        path: 'file',
        selected: true,
        change: 'Ignored',
      })._tag,
    ).toBe('Failure');
  });
  it('distinguishes known, uncertain and partial commit outcomes', () => {
    expect(Schema.decodeUnknownResult(OperationKind)('SourceControl.commit')._tag).toBe('Success');
    for (const result of [
      { _tag: 'Committed', commit: 'abc' },
      { _tag: 'Unknown', detail: 'interrupted' },
      { _tag: 'Partial', detail: 'index restoration failed', commit: 'abc' },
    ]) {
      expect(Schema.decodeUnknownResult(CommitOperationResult)(result)._tag).toBe('Success');
    }
    expect(Schema.decodeUnknownResult(CommitOperationResult)({ _tag: 'Committed' })._tag).toBe(
      'Failure',
    );
  });
});
