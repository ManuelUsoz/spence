import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema, Stream } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { MessageChannel } from 'node:worker_threads';
import { FilesRpcs } from '../../src/shared/files/files.rpc';
import { HistoryRpcs } from '../../src/shared/history/history.rpc';
import { DesktopRpcs } from '../../src/shared/rpc/desktop-rpcs';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import { SourceControlRpcs } from '../../src/shared/source-control/source-control.rpc';
import {
  RepositoryId,
  WorktreeId,
  type WorktreeLocateResult,
  WorktreesError,
  WorktreesRpcs,
  type WorktreeInventory,
} from '../../src/shared/worktrees/worktrees.rpc';
import { SourceControl } from '../source-control/source-control';
import { reconcileWorktreeBinding, Worktrees } from '../worktrees/worktrees';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';
import { layerFilesHandlers } from './files';
import { layerHistoryHandlers } from './history';
import { layerSourceControlHandlers } from './source-control';
import { layerWorktreesHandlers } from './worktrees';

describe('Worktrees RPC over real MessagePort', () => {
  it.effect('round-trips WorktreeInventory, branded IDs, and tagged WorktreesError', () =>
    Effect.gen(function* () {
      expect(DesktopRpcs.requests.has('Worktrees.inventory')).toBe(true);
      expect(DesktopRpcs.requests.has('Worktrees.refresh')).toBe(true);

      const channel = new MessageChannel();
      const repoId = RepositoryId.make('repo:abc123');
      const worktreeId = WorktreeId.make('wt:main');
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
            changes: {
              changedFiles: 2,
              staged: 1,
              unstaged: 1,
              untracked: 0,
              additions: 5,
              deletions: 2,
            },
          },
        ],
        refreshedAt: 1_700_000_000_000,
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
        locate: ({ targetPath, allowRebind }) =>
          Effect.succeed(
            allowRebind
              ? ({
                  _tag: 'Rebound',
                  binding: {
                    state: 'resolved',
                    repositoryId: repoId,
                    worktreeId,
                    expectedPath: targetPath,
                    lastKnownBranch: 'main',
                  },
                  inventory: expected,
                } satisfies WorktreeLocateResult)
              : targetPath === 'C:/other'
                ? ({
                    _tag: 'RequiresRebind',
                    mismatchReason: 'DifferentRepository',
                    candidatePath: targetPath,
                    detail: 'Candidate belongs to another repository.',
                  } satisfies WorktreeLocateResult)
                : ({
                    _tag: 'Verified',
                    entry: expected.worktrees[0]!,
                    binding: {
                      state: 'resolved',
                      repositoryId: repoId,
                      worktreeId,
                      expectedPath: 'C:/repo',
                      lastKnownBranch: 'main',
                    },
                    inventory: expected,
                  } satisfies WorktreeLocateResult),
          ),
        reconcileBinding: reconcileWorktreeBinding,
        updates: Stream.empty,
      });

      const fakeSourceControl = Layer.succeed(SourceControl, {
        status: () => Effect.die('unused in worktrees transport test'),
        diff: () => Effect.die('unused in worktrees transport test'),
        commits: () => Effect.die('unused in worktrees transport test'),
        commitDetail: () => Effect.die('unused in worktrees transport test'),
        commitFileDiff: () => Effect.die('unused in worktrees transport test'),
      });

      const Wave2Group = WorktreesRpcs.merge(FilesRpcs).merge(SourceControlRpcs).merge(HistoryRpcs);
      const serverLayer = RpcServer.layer(Wave2Group).pipe(
        Layer.provide(
          Layer.mergeAll(
            layerWorktreesHandlers,
            layerFilesHandlers,
            layerSourceControlHandlers,
            layerHistoryHandlers,
          ),
        ),
        Layer.provide(Layer.mergeAll(fakeWorktrees, fakeSourceControl)),
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
          expect(refreshed.worktrees[0]?.changes).toEqual({
            changedFiles: 2,
            staged: 1,
            unstaged: 1,
            untracked: 0,
            additions: 5,
            deletions: 2,
          });

          expect(DesktopRpcs.requests.has('Worktrees.locate')).toBe(true);
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

          const verified = yield* client['Worktrees.locate']({
            expectedBinding: {
              state: 'missing',
              repositoryId: repoId,
              worktreeId,
              expectedPath: 'C:/old',
              reason: 'MissingPath',
            },
            targetPath: 'C:/repo',
          });
          expect(verified._tag).toBe('Verified');

          const err = yield* client['Worktrees.inventory']({ path: 'missing-git' }).pipe(
            Effect.flip,
          );
          expect(err._tag).toBe('WorktreesError');
          if (err._tag === 'WorktreesError') {
            expect(err.reason).toBe('MissingGit');
            expect(err.detail).toContain('Git binary');
          }
          expect(Schema.decodeUnknownSync(RepositoryId)(repoId)).toBe(repoId);
        }),
        Layer.mergeAll(serverLayer, layerClientProtocol(clientPort(channel.port2))),
      );
    }),
  );
});
