import { Schema } from 'effect';
import { SessionId, TurnId } from '../sessions/sessions.rpc';
import { WorktreeId } from '../worktrees/worktrees.rpc';
import { Timestamp } from '../projects/projects.rpc';
import { ObservationId } from './observation-id';

export const ComparisonId = Schema.String.pipe(Schema.brand('ComparisonId'));
export type ComparisonId = typeof ComparisonId.Type;

/** Missing and incomplete captures are distinct from a successfully retained observation. */
export const ComparisonEndpoint = Schema.Union([
  Schema.Struct({ status: Schema.Literal('Complete'), observationId: ObservationId }),
  Schema.Struct({ status: Schema.Literal('Incomplete'), detail: Schema.String }),
  Schema.Struct({ status: Schema.Literal('Missing'), detail: Schema.String }),
]);
export const HistoryComparison = Schema.Struct({
  id: ComparisonId,
  sessionId: SessionId,
  turnId: Schema.optional(TurnId),
  worktreeId: WorktreeId,
  recordedAt: Timestamp,
  before: ComparisonEndpoint,
  after: ComparisonEndpoint,
});
export type HistoryComparison = typeof HistoryComparison.Type;
