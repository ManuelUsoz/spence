import { Context, Effect, Layer, Option, Queue, Stream } from 'effect';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { toWireDefect } from '../../src/shared/rpc/wire-error';
import {
  WorktreesError,
  type PrepareDraftResult,
  type WorktreePrepEvent,
  type WorktreePrepStep,
  type WorktreesResult,
} from '../../src/shared/worktrees/worktrees.rpc';
import { folderKey } from '../projects/folder-key';
import { Projects } from '../projects/projects';
import { Sessions } from '../sessions/sessions';
import type { WorkerCapabilityFailure } from '../source-control/worker-protocol';
import { BranchOrigins } from './branch-origins';
import { detectProjectSetupCommand, runWorktreeSetupCommand } from './worktree-setup';
import { createWorktree, listWorktrees } from './worktrees-core';

export interface WorktreesShape {
  readonly list: (id: SessionId) => Effect.Effect<WorktreesResult, WorktreesError>;
  readonly prepareDraft: (
    id: SessionId,
    branch: string,
    base: string | undefined,
  ) => Effect.Effect<PrepareDraftResult, WorktreesError>;
  readonly prepareDraftStream: (
    id: SessionId,
    branch: string,
    base: string | undefined,
    setupCommand?: string | null,
  ) => Stream.Stream<WorktreePrepEvent, WorktreesError>;
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
    const projects = Option.getOrUndefined(yield* Effect.serviceOption(Projects));
    const branchOrigins = Option.getOrUndefined(yield* Effect.serviceOption(BranchOrigins));
    const notFound = (id: SessionId) =>
      new WorktreesError({ reason: 'SessionNotFound', detail: `No Session ${id}.` });
    const folderOf = (id: SessionId) =>
      sessions.folderOf(id).pipe(Effect.mapError(() => notFound(id)));
    const run = <A>(work: () => Promise<A>) => toWireDefect(Effect.tryPromise(work));

    const resolveSetupCommand = Effect.fnUntraced(function* (
      folder: string,
      primaryPath?: string,
    ): Effect.fn.Return<string | null> {
      if (projects !== undefined) {
        const listed = yield* projects.list;
        const folderNorm = folderKey(folder, process.platform);
        const primaryNorm =
          primaryPath === undefined ? undefined : folderKey(primaryPath, process.platform);
        const match = listed.find((project) => {
          const key = folderKey(project.path, process.platform);
          return key === folderNorm || (primaryNorm !== undefined && key === primaryNorm);
        });
        if (match?.settings.worktreeSetupCommand !== undefined) {
          return match.settings.worktreeSetupCommand;
        }
      }
      return yield* Effect.promise(() => detectProjectSetupCommand(folder));
    });

    const list: WorktreesShape['list'] = (id) =>
      folderOf(id).pipe(
        Effect.flatMap((folder) =>
          run(() => listWorktrees(folder, GIT, pathEnv())).pipe(
            Effect.map((result) => ({ folder, result })),
          ),
        ),
        Effect.flatMap(({ folder, result }): Effect.Effect<WorktreesResult, WorktreesError> =>
          result._tag === 'Available'
            ? Effect.all({
                canSelect: sessions.isDraft(id).pipe(Effect.mapError(() => notFound(id))),
                setupCommand: resolveSetupCommand(
                  folder,
                  result.entries.find((entry) => entry.isPrimary)?.path,
                ),
              }).pipe(
                Effect.map(({ canSelect, setupCommand }): WorktreesResult => ({
                  _tag: 'Available',
                  entries: result.entries,
                  canSelect,
                  setupCommand,
                })),
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
                  const recordOrigin =
                    branchOrigins !== undefined &&
                    created.createdFromBranch !== null &&
                    entry.branch !== null
                      ? branchOrigins.record({
                          worktreePath: entry.path,
                          branch: entry.branch,
                          createdFromBranch: created.createdFromBranch,
                        })
                      : Effect.void;
                  return recordOrigin.pipe(
                    Effect.andThen(sessions.setDraftFolder(id, entry.path)),
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

    const prepareDraftStream: WorktreesShape['prepareDraftStream'] = (
      id,
      branch,
      base,
      setupCommandOverride,
    ) =>
      Stream.callback<WorktreePrepEvent, WorktreesError>(
        Effect.fnUntraced(function* (queue) {
          const controller = new AbortController();
          const emit = (event: WorktreePrepEvent) => Queue.offer(queue, event);
          const emitStep = (step: WorktreePrepStep) => emit({ _tag: 'Step', step });
          const finish = (result: PrepareDraftResult) =>
            emit({ _tag: 'Done', result }).pipe(Effect.andThen(Queue.end(queue)));

          yield* Effect.gen(function* () {
            const draft = yield* sessions.isDraft(id).pipe(Effect.mapError(() => notFound(id)));
            if (!draft) {
              yield* finish({
                _tag: 'Rejected',
                reason: 'Busy',
                detail: 'This Session already has messages, so it stays in its worktree.',
              });
              return;
            }

            const folder = yield* folderOf(id);
            yield* emitStep({
              id: 'createWorktree',
              title: 'Create worktree',
              detail: branch,
              status: 'running',
            });

            const created = yield* run(() => createWorktree(folder, branch, GIT, pathEnv(), base));
            if (created._tag === 'Rejected') {
              yield* emitStep({
                id: 'createWorktree',
                title: 'Create worktree',
                detail: branch,
                status: 'failed',
                output: created.detail,
              });
              yield* finish(created);
              return;
            }
            if (created._tag !== 'Created') {
              const result = unavailable(created);
              yield* emitStep({
                id: 'createWorktree',
                title: 'Create worktree',
                detail: branch,
                status: 'failed',
                output: result.detail,
              });
              yield* finish(result);
              return;
            }

            const entry = created.entry;
            if (
              branchOrigins !== undefined &&
              created.createdFromBranch !== null &&
              entry.branch !== null
            ) {
              yield* branchOrigins.record({
                worktreePath: entry.path,
                branch: entry.branch,
                createdFromBranch: created.createdFromBranch,
              });
            }
            yield* emitStep({
              id: 'createWorktree',
              title: 'Create worktree',
              detail: entry.folderName,
              status: 'done',
            });

            const command =
              setupCommandOverride === null
                ? null
                : setupCommandOverride !== undefined
                  ? setupCommandOverride.trim() || null
                  : yield* resolveSetupCommand(entry.path, folder);

            if (command === null) {
              yield* emitStep({
                id: 'setupProject',
                title: 'Prepare project',
                status: 'skipped',
              });
            } else {
              yield* emitStep({
                id: 'setupProject',
                title: 'Prepare project',
                detail: command,
                status: 'running',
              });
              const setupResult = yield* Effect.promise(() =>
                runWorktreeSetupCommand(
                  entry.path,
                  command,
                  (tail) => {
                    Queue.offerUnsafe(queue, {
                      _tag: 'Step',
                      step: {
                        id: 'setupProject',
                        title: 'Prepare project',
                        detail: command,
                        status: 'running',
                        output: tail,
                      },
                    });
                  },
                  controller.signal,
                ),
              );
              yield* emitStep({
                id: 'setupProject',
                title: 'Prepare project',
                detail: command,
                status: setupResult.ok ? 'done' : 'failed',
                ...(setupResult.output.trim().length > 0 ? { output: setupResult.output } : {}),
              });
            }

            yield* emitStep({
              id: 'startSession',
              title: 'Start session in worktree',
              status: 'running',
            });

            const started = yield* sessions.setDraftFolder(id, entry.path).pipe(
              Effect.as<PrepareDraftResult>({ _tag: 'Prepared', entry }),
              Effect.catchTag('SessionError', (error) =>
                Effect.succeed<PrepareDraftResult>({
                  _tag: 'Rejected',
                  reason: 'StartFailed',
                  detail: error.detail,
                }),
              ),
            );

            if (started._tag === 'Prepared') {
              yield* emitStep({
                id: 'startSession',
                title: 'Start session in worktree',
                status: 'done',
              });
            } else {
              yield* emitStep({
                id: 'startSession',
                title: 'Start session in worktree',
                status: 'failed',
                output: started.detail,
              });
            }
            yield* finish(started);
          }).pipe(
            Effect.catchCause((cause) => Queue.failCause(queue, cause)),
            Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
            Effect.forkScoped,
          );
        }),
      );

    return { list, prepareDraft, prepareDraftStream };
  }),
);
