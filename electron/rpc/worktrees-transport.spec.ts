import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option, Schema, Stream } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { MessageChannel } from 'node:worker_threads';
import { FilesRpcs } from '../../src/shared/files/files.rpc';
import { HistoryRpcs } from '../../src/shared/history/history.rpc';
import { Timestamp } from '../../src/shared/projects/projects.rpc';
import { DesktopRpcs } from '../../src/shared/rpc/desktop-rpcs';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import {
  OperationId,
  type OperationSnapshot,
  ReviewId,
  SourceControlError,
  SourceControlRpcs,
} from '../../src/shared/source-control/source-control.rpc';
import {
  type CreateWorktreeResult,
  RepositoryId,
  type WorktreeCreateReview,
  WorktreeId,
  WorktreesError,
  WorktreesRpcs,
  type WorktreeInventory,
} from '../../src/shared/worktrees/worktrees.rpc';
import { FolderPicker } from '../projects/folders';
import { Operations } from '../source-control/operations';
import { WorktreeCreate } from '../worktrees/worktree-create';
import { reconcileWorktreeBinding, Worktrees } from '../worktrees/worktrees';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';
import { layerFilesHandlers } from './files';
import { layerHistoryHandlers } from './history';
import { layerSourceControlHandlers } from './source-control';
import { layerWorktreesHandlers } from './worktrees';

describe('Worktrees RPC over real MessagePort', () => {
  it.effect(
    'round-trips WorktreeInventory, WorktreeCreate, SourceControl operations, and tagged errors',
    () =>
      Effect.gen(function* () {
        expect(DesktopRpcs.requests.has('Worktrees.inventory')).toBe(true);
        expect(DesktopRpcs.requests.has('Worktrees.refresh')).toBe(true);
        expect(DesktopRpcs.requests.has('Worktrees.prepareCreate')).toBe(true);
        expect(DesktopRpcs.requests.has('Worktrees.revalidateCreate')).toBe(true);
        expect(DesktopRpcs.requests.has('Worktrees.executeCreate')).toBe(true);
        expect(DesktopRpcs.requests.has('Worktrees.pickDestination')).toBe(true);
        expect(DesktopRpcs.requests.has('SourceControl.listOperations')).toBe(true);
        expect(DesktopRpcs.requests.has('SourceControl.getOperation')).toBe(true);
        expect(DesktopRpcs.requests.has('SourceControl.operationEvents')).toBe(true);
        expect(DesktopRpcs.requests.has('SourceControl.reconcileOperation')).toBe(true);
        expect(DesktopRpcs.requests.has('SourceControl.dismissOperation')).toBe(true);
        expect(DesktopRpcs.requests.has('SourceControl.cancelOperation')).toBe(true);

        const channel = new MessageChannel();
        const repoId = RepositoryId.make('repo:abc123');
        const worktreeId = WorktreeId.make('wt:main');
        const createdWorktreeId = WorktreeId.make('wt:feat-rpc');
        const reviewId = ReviewId.make('rev-rpc-1');
        const operationId = OperationId.make('op-rpc-1');
        const ts = Timestamp.make(1_700_000_000_000);

        const createdEntry = {
          id: createdWorktreeId,
          repositoryId: repoId,
          path: 'C:/repo-feat-rpc',
          folderName: 'repo-feat-rpc',
          head: {
            _tag: 'Branch' as const,
            branch: 'feat/rpc',
            ref: 'refs/heads/feat/rpc',
            commit: 'deadbeef',
          },
          isPrimary: false,
          bare: false,
          missing: false,
        };

        const expected: WorktreeInventory = {
          cwd: 'C:/repo',
          capability: {
            _tag: 'Available',
            gitVersion: '2.49.0',
            executable: 'git',
          },
          repositoryId: repoId,
          commonDir: 'C:/repo/.git',
          currentWorktreeId: worktreeId,
          worktrees: [
            {
              id: worktreeId,
              repositoryId: repoId,
              path: 'C:/repo',
              folderName: 'repo',
              head: {
                _tag: 'Branch',
                branch: 'main',
                ref: 'refs/heads/main',
                commit: 'deadbeef',
              },
              isPrimary: true,
              bare: false,
              missing: false,
            },
          ],
          refreshedAt: 1_700_000_000_000,
        };

        const sampleReview: WorktreeCreateReview = {
          reviewId,
          issuedAt: ts,
          expiresAt: Timestamp.make(ts + 60_000),
          stale: false,
          repositoryId: repoId,
          sourceWorktreeId: worktreeId,
          sourcePath: 'C:/repo',
          sourceHead: expected.worktrees[0]!.head,
          sourceDirtyCount: 1,
          defaultBranch: 'feat/new-branch',
          defaultDestination: 'C:/repo-new-branch',
          eligibleBranches: [{ name: 'ready', commit: 'deadbeef', checkedOut: false }],
          warnings: [],
          blockers: [],
        };

        const completedOp: OperationSnapshot = {
          id: operationId,
          kind: 'Worktree.create',
          title: 'Create Worktree (feat/rpc)',
          phase: 'Completed',
          outcome: 'Succeeded',
          progress: { step: 'Done', detail: 'Worktree created.' },
          warnings: [],
          repositoryKey: repoId,
          sourcePath: 'C:/repo',
          targetPath: 'C:/repo-feat-rpc',
          branch: 'feat/rpc',
          createdAt: ts,
          updatedAt: ts,
        };

        const recoveryOp: OperationSnapshot = {
          ...completedOp,
          id: OperationId.make('op-rpc-rec'),
          phase: 'NeedsRecovery',
          outcome: 'Unknown',
          progress: { step: 'Done', detail: 'Needs recovery inspection.' },
          unknownReason: 'Interrupted mid-run.',
          recovery: {
            summary: 'Check worktree registration.',
            detail: 'Git registered worktree before crash.',
            observedFolderExists: true,
            observedRegisteredInGit: true,
            observedBranchExists: true,
            canReconcile: true,
            canDismiss: true,
          },
        };

        const createResult: CreateWorktreeResult = {
          operation: completedOp,
          worktree: createdEntry,
          inventory: {
            ...expected,
            worktrees: [...expected.worktrees, createdEntry],
          },
        };

        const fakeWorktrees = Layer.succeed(Worktrees, {
          platform: process.platform,
          inventory: (targetPath) =>
            targetPath === 'missing-git'
              ? Effect.fail(
                  new WorktreesError({
                    reason: 'MissingGit',
                    detail: 'Git binary was not found on PATH.',
                  }),
                )
              : Effect.succeed(expected),
          refresh: () => Effect.succeed(expected),
          locate: ({ targetPath }) =>
            Effect.succeed({
              _tag: 'RequiresRebind',
              mismatchReason: 'DifferentRepository',
              candidatePath: targetPath,
              detail: 'Candidate belongs to another repository.',
            }),
          reconcileBinding: reconcileWorktreeBinding,
          updates: Stream.empty,
        });

        const fakeWorktreeCreate = Layer.succeed(WorktreeCreate, {
          prepareCreate: () => Effect.succeed(sampleReview),
          revalidateCreate: () =>
            Effect.succeed({
              ...sampleReview,
              stale: true,
              staleReason: 'Repository state changed since initial review.',
            }),
          executeCreate: (input) =>
            input.branch === 'stale'
              ? Effect.fail(
                  new WorktreesError({
                    reason: 'StaleReview',
                    detail: 'Review expired or repo changed.',
                  }),
                )
              : Effect.succeed(createResult),
        });

        const fakePicker = Layer.succeed(FolderPicker, {
          pick: Effect.succeed(Option.some('C:/picked-worktree')),
        });

        const fakeOperations = Layer.succeed(Operations, {
          execute: () => Effect.succeed(completedOp),
          registerReconciler: () => Effect.void,
          reconcilePendingForKind: () => Effect.void,
          reconcileOperation: (id) =>
            Effect.succeed({ ...recoveryOp, id, phase: 'Completed', outcome: 'Succeeded' }),
          dismissOperation: (id) =>
            Effect.succeed({ ...recoveryOp, id, phase: 'Completed', outcome: 'Cancelled' }),
          cancelOperation: (id) =>
            id === completedOp.id
              ? Effect.fail(
                  new SourceControlError({
                    reason: 'Conflict',
                    detail: 'Already completed.',
                  }),
                )
              : Effect.succeed({ ...recoveryOp, id, phase: 'Completed', outcome: 'Cancelled' }),
          listOperations: () => Effect.succeed([completedOp, recoveryOp]),
          getOperation: (id) => Effect.succeed(id === recoveryOp.id ? recoveryOp : completedOp),
          awaitOperation: () => Effect.succeed(completedOp),
          updates: Stream.fromIterable([completedOp]),
        });

        const Wave2Group = WorktreesRpcs.merge(FilesRpcs)
          .merge(SourceControlRpcs)
          .merge(HistoryRpcs);
        const serverLayer = RpcServer.layer(Wave2Group).pipe(
          Layer.provide(
            Layer.mergeAll(
              layerWorktreesHandlers,
              layerFilesHandlers,
              layerSourceControlHandlers,
              layerHistoryHandlers,
            ),
          ),
          Layer.provide(
            Layer.mergeAll(fakeWorktrees, fakeWorktreeCreate, fakePicker, fakeOperations),
          ),
          Layer.provideMerge(layerIpcServer),
        );

        yield* Effect.provide(
          Effect.gen(function* () {
            const handoff = yield* RpcPortHandoff;
            handoff.bind(serverPort(channel.port1));
            const client = yield* RpcClient.make(Wave2Group);

            const inv = yield* client['Worktrees.inventory']({ path: 'C:/repo' });
            expect(inv).toEqual(expected);

            const refreshed = yield* client['Worktrees.refresh']({ path: 'C:/repo' });
            expect(refreshed.currentWorktreeId).toBe(worktreeId);
            expect(refreshed.repositoryId).toBe(repoId);
            const mismatch = yield* client['Worktrees.locate']({
              expectedBinding: {
                state: 'missing',
                repositoryId: repoId,
                worktreeId,
                expectedPath: 'C:/repo',
                reason: 'MissingPath',
              },
              targetPath: 'C:/other',
            });
            expect(mismatch._tag).toBe('RequiresRebind');

            const invErr = yield* client['Worktrees.inventory']({ path: 'missing-git' }).pipe(
              Effect.flip,
            );
            expect(invErr._tag).toBe('WorktreesError');
            if (invErr._tag === 'WorktreesError') {
              expect(invErr.reason).toBe('MissingGit');
              expect(invErr.detail).toContain('Git binary');
            }
            expect(Schema.decodeUnknownSync(RepositoryId)(repoId)).toBe(repoId);

            const review = yield* client['Worktrees.prepareCreate']({ path: 'C:/repo' });
            expect(review.reviewId).toBe(reviewId);
            expect(review.eligibleBranches).toHaveLength(1);

            const revalidated = yield* client['Worktrees.revalidateCreate']({
              reviewId,
              sourcePath: 'C:/repo',
              destinationPath: 'C:/repo-feat-rpc',
              branch: 'feat/rpc',
              startFrom: { mode: 'Head' },
            });
            expect(revalidated.stale).toBe(true);

            const created = yield* client['Worktrees.executeCreate']({
              reviewId,
              operationId,
              sourcePath: 'C:/repo',
              destinationPath: 'C:/repo-feat-rpc',
              branch: 'feat/rpc',
              startFrom: { mode: 'Head' },
            });
            expect(created.operation.outcome).toBe('Succeeded');
            expect(created.worktree?.id).toBe(createdWorktreeId);

            const staleErr = yield* client['Worktrees.executeCreate']({
              reviewId,
              operationId,
              sourcePath: 'C:/repo',
              destinationPath: 'C:/repo-feat-rpc',
              branch: 'stale',
              startFrom: { mode: 'Head' },
            }).pipe(Effect.flip);
            expect(staleErr._tag).toBe('WorktreesError');
            if (staleErr._tag === 'WorktreesError') {
              expect(staleErr.reason).toBe('StaleReview');
            }

            const picked = yield* client['Worktrees.pickDestination']({});
            expect(picked).toBe('C:/picked-worktree');

            const listed = yield* client['SourceControl.listOperations']({});
            expect(listed.map((op) => op.id)).toEqual([operationId, recoveryOp.id]);

            const got = yield* client['SourceControl.getOperation']({
              operationId: recoveryOp.id,
            });
            expect(got.phase).toBe('NeedsRecovery');

            const events = yield* client['SourceControl.operationEvents'](undefined).pipe(
              Stream.take(1),
              Stream.runCollect,
            );
            expect([...events][0]?.id).toBe(operationId);

            const reconciled = yield* client['SourceControl.reconcileOperation']({
              operationId: recoveryOp.id,
            });
            expect(reconciled.phase).toBe('Completed');

            const dismissed = yield* client['SourceControl.dismissOperation']({
              operationId: recoveryOp.id,
            });
            expect(dismissed.outcome).toBe('Cancelled');

            const cancelErr = yield* client['SourceControl.cancelOperation']({
              operationId,
            }).pipe(Effect.flip);
            expect(cancelErr._tag).toBe('SourceControlError');
            if (cancelErr._tag === 'SourceControlError') {
              expect(cancelErr.reason).toBe('Conflict');
            }
          }),
          Layer.mergeAll(serverLayer, layerClientProtocol(clientPort(channel.port2))),
        );
      }),
  );
});
