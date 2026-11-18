import { Context, Effect, Layer } from 'effect';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { toWireDefect } from '../../src/shared/rpc/wire-error';
import {
  WorktreesError,
  type PrepareDraftResult,
  type WorktreesResult,
} from '../../src/shared/worktrees/worktrees.rpc';
import { Sessions } from '../sessions/sessions';
import type { WorkerCapabilityFailure } from '../source-control/worker-protocol';
import { createWorktree, listWorktrees } from './worktrees-core';

export interface WorktreesShape {
  readonly list: (id: SessionId) => Effect.Effect<WorktreesResult, WorktreesError>;
  readonly prepareDraft: (
    id: SessionId,
    branch: string,
    base: string | undefined,
  ) => Effect.Effect<PrepareDraftResult, WorktreesError>;
}

export class Worktrees extends Context.Service<Worktrees, WorktreesShape>()(
  'worktrees/Worktrees',
) {}

const GIT = 'git';
const pathEnv = (): string => process.env['PATH'] ?? process.env['Path'] ?? '';

const unavailable = (failure: WorkerCapabilityFailure) => ({
  _tag: 'Unavailable' as const,
  reason: failure._tag,
  detail: failure.detail,
});

export const layerWorktrees = Layer.effect(
  Worktrees,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const notFound = (id: SessionId) =>
      new WorktreesError({ reason: 'SessionNotFound', detail: `No Session ${id}.` });
    const folderOf = (id: SessionId) =>
      sessions.folderOf(id).pipe(Effect.mapError(() => notFound(id)));
    const run = <A>(work: () => Promise<A>) => toWireDefect(Effect.tryPromise(work));

    const list: WorktreesShape['list'] = (id) =>
      folderOf(id).pipe(
        Effect.flatMap((folder) => run(() => listWorktrees(folder, GIT, pathEnv()))),
        Effect.flatMap((result): Effect.Effect<WorktreesResult, WorktreesError> =>
          result._tag === 'Available'
            ? sessions.isDraft(id).pipe(
                Effect.map((canSelect): WorktreesResult => ({
                  _tag: 'Available',
                  entries: result.entries,
                  canSelect,
                })),
                Effect.mapError(() => notFound(id)),
              )
            : Effect.succeed(unavailable(result)),
        ),
      );

    const prepareDraft: WorktreesShape['prepareDraft'] = (id, branch, base) =>
      sessions.isDraft(id).pipe(
        Effect.mapError(() => notFound(id)),
        Effect.flatMap((draft): Effect.Effect<PrepareDraftResult, WorktreesError> =>
          !draft
            ? Effect.succeed({
                _tag: 'Rejected',
                reason: 'Busy',
                detail: 'This Session already has messages, so it stays in its worktree.',
              })
            : folderOf(id).pipe(
                Effect.flatMap((folder) =>
                  run(() => createWorktree(folder, branch, GIT, pathEnv(), base)),
                ),
                Effect.flatMap((created): Effect.Effect<PrepareDraftResult, WorktreesError> => {
                  if (created._tag === 'Rejected') return Effect.succeed(created);
                  if (created._tag !== 'Created') return Effect.succeed(unavailable(created));
                  const entry = created.entry;
                  return sessions.setDraftFolder(id, entry.path).pipe(
                    Effect.as<PrepareDraftResult>({ _tag: 'Prepared', entry }),
                    Effect.catchTag('SessionError', (error) =>
                      Effect.succeed<PrepareDraftResult>({
                        _tag: 'Rejected',
                        reason: 'StartFailed',
                        detail: error.detail,
                      }),
                    ),
                  );
                }),
              ),
        ),
      );

    return { list, prepareDraft };
  }),
);
