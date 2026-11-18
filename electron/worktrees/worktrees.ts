import { Context, Effect, Layer } from 'effect';
import path from 'node:path';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { toWireDefect } from '../../src/shared/rpc/wire-error';
import {
  WorktreesError,
  type CreateWorktreeResult,
  type SelectWorktreeResult,
  type WorktreesResult,
} from '../../src/shared/worktrees/worktrees.rpc';
import { Sessions } from '../sessions/sessions';
import type { WorkerCapabilityFailure } from '../source-control/worker-protocol';
import { createWorktree, listWorktrees } from './worktrees-core';

export interface WorktreesShape {
  readonly list: (id: SessionId) => Effect.Effect<WorktreesResult, WorktreesError>;
  readonly create: (
    id: SessionId,
    branch: string,
  ) => Effect.Effect<CreateWorktreeResult, WorktreesError>;
  readonly select: (
    id: SessionId,
    worktreePath: string,
  ) => Effect.Effect<SelectWorktreeResult, WorktreesError>;
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

const sameFolder = (a: string, b: string): boolean =>
  process.platform === 'win32'
    ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase()
    : path.normalize(a) === path.normalize(b);

export const layerWorktrees = Layer.effect(
  Worktrees,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const folderOf = (id: SessionId) =>
      sessions
        .folderOf(id)
        .pipe(
          Effect.mapError(
            () => new WorktreesError({ reason: 'SessionNotFound', detail: `No Session ${id}.` }),
          ),
        );
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
                Effect.mapError(
                  () =>
                    new WorktreesError({ reason: 'SessionNotFound', detail: `No Session ${id}.` }),
                ),
              )
            : Effect.succeed(unavailable(result)),
        ),
      );

    const create: WorktreesShape['create'] = (id, branch) =>
      folderOf(id).pipe(
        Effect.flatMap((folder) => run(() => createWorktree(folder, branch, GIT, pathEnv()))),
        Effect.map((result): CreateWorktreeResult => {
          if (result._tag === 'Created') return { _tag: 'Created', entry: result.entry };
          if (result._tag === 'Rejected') return result;
          return unavailable(result);
        }),
      );

    const select: WorktreesShape['select'] = (id, worktreePath) =>
      list(id).pipe(
        Effect.flatMap((listed): Effect.Effect<SelectWorktreeResult, WorktreesError> => {
          if (listed._tag !== 'Available') return Effect.succeed(listed);
          const entry = listed.entries.find((candidate) =>
            sameFolder(candidate.path, worktreePath),
          );
          if (entry === undefined) {
            return Effect.succeed({
              _tag: 'Rejected',
              reason: 'Unknown',
              detail: `${worktreePath} is not a Worktree of this repository.`,
            });
          }
          if (entry.missing) {
            return Effect.succeed({
              _tag: 'Rejected',
              reason: 'Missing',
              detail: `${entry.path} no longer exists.`,
            });
          }
          return sessions.setDraftFolder(id, entry.path).pipe(
            Effect.as<SelectWorktreeResult>({ _tag: 'Selected' }),
            Effect.catchTag('SessionError', (error) =>
              error.reason === 'Busy'
                ? Effect.succeed<SelectWorktreeResult>({
                    _tag: 'Rejected',
                    reason: 'Busy',
                    detail: error.detail,
                  })
                : Effect.fail(
                    new WorktreesError({ reason: 'SessionNotFound', detail: error.detail }),
                  ),
            ),
          );
        }),
      );

    return { list, create, select };
  }),
);
