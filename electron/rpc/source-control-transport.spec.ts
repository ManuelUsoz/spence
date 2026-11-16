import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Stream } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MessageChannel } from 'node:worker_threads';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { ProjectId, Timestamp } from '../../src/shared/projects/projects.rpc';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { SourceControlRpcs } from '../../src/shared/source-control/source-control.rpc';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';
import { AgentContextId, layerSessionStore, SessionStore } from '../sessions/session-store';
import { layerSourceControl } from '../source-control/source-control';
import { Operations } from '../source-control/operations';
import { layerStore } from '../store/store';
import { layerGitWorkerDirect } from '../worktrees/git-client';
import { layerWorktrees } from '../worktrees/worktrees';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';
import { layerSourceControlHandlers } from './source-control';

const execFile = promisify(execFileCb);

const runGitCmd = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFile('git', [...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return stdout.trim();
};

describe('SourceControl MessagePort RPC transport', () => {
  it.live(
    'round-trips SourceControlRpcs payloads and typed SourceControlError over MessageChannel',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sc-rpc-')));
        const repoDir = path.join(root, 'repo');
        const storeDir = path.join(root, 'store');

        yield* Effect.promise(async () => {
          await mkdir(repoDir, { recursive: true });
          await runGitCmd(repoDir, ['init', '-b', 'main']);
          await runGitCmd(repoDir, ['config', 'user.email', 'test@spence.local']);
          await runGitCmd(repoDir, ['config', 'user.name', 'Spence Test']);
          await writeFile(path.join(repoDir, 'app.ts'), 'export const x = 1;\n');
          await runGitCmd(repoDir, ['add', '--', 'app.ts']);
          await runGitCmd(repoDir, ['commit', '-m', 'initial commit']);

          await writeFile(
            path.join(repoDir, 'app.ts'),
            'export const x = 1;\nexport const y = 2;\n',
          );
          await runGitCmd(repoDir, ['add', '--', 'app.ts']);
          await writeFile(
            path.join(repoDir, 'app.ts'),
            'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n',
          );
          await writeFile(path.join(repoDir, 'notes.md'), '# hello\n');
        });

        const channel = new MessageChannel();
        const storeLayer = layerStore(storeDir);
        const sessionStoreLayer = layerSessionStore.pipe(Layer.provideMerge(storeLayer));
        const gitWorkerLayer = layerGitWorkerDirect.pipe(
          Layer.provideMerge(layerMergedPath),
          Layer.provideMerge(layerPathSources),
        );
        const worktreesLayer = layerWorktrees.pipe(
          Layer.provideMerge(gitWorkerLayer),
          Layer.provideMerge(storeLayer),
        );
        const sourceControlLayer = layerSourceControl.pipe(
          Layer.provideMerge(Layer.mergeAll(sessionStoreLayer, worktreesLayer, gitWorkerLayer)),
        );

        const serverLayer = RpcServer.layer(SourceControlRpcs).pipe(
          Layer.provide(layerSourceControlHandlers),
          Layer.provide(
            Layer.succeed(Operations, {
              execute: () => Effect.die('unused'),
              registerReconciler: () => Effect.void,
              reconcilePendingForKind: () => Effect.void,
              reconcileOperation: () => Effect.die('unused'),
              dismissOperation: () => Effect.die('unused'),
              cancelOperation: () => Effect.die('unused'),
              listOperations: () => Effect.die('unused'),
              getOperation: () => Effect.die('unused'),
              awaitOperation: () => Effect.die('unused'),
              updates: Stream.empty,
            }),
          ),
          Layer.provideMerge(sourceControlLayer),
          Layer.provideMerge(layerIpcServer),
        );

        const testLayer = Layer.mergeAll(
          serverLayer,
          layerClientProtocol(clientPort(channel.port2)),
        );

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore;
            const handoff = yield* RpcPortHandoff;
            handoff.bind(serverPort(channel.port1));

            const sessionId = SessionId.make('s-rpc-1');
            yield* store.createDraft({
              id: sessionId,
              projectId: ProjectId.make('p-1'),
              cwd: repoDir,
              agentId: AgentId.make('claude'),
              autoTitleIsPlaceholder: true,
              historyProtected: false,
              createdAt: Timestamp.make(1000),
              lastActivityAt: Timestamp.make(1000),
              activeContextId: AgentContextId.make('ctx-1'),
              contexts: [
                {
                  id: AgentContextId.make('ctx-1'),
                  agentId: AgentId.make('claude'),
                  acpSessionIds: [],
                  createdAt: Timestamp.make(1000),
                },
              ],
              permissionMode: 'ask',
            });

            const client = yield* RpcClient.make(SourceControlRpcs);
            const status = yield* client['SourceControl.status']({ sessionId });
            expect(status.state._tag).toBe('Available');
            if (status.state._tag !== 'Available') return;
            expect(status.state.files.map((f) => f.path)).toEqual(['app.ts', 'notes.md']);

            const diff = yield* client['SourceControl.diff']({
              sessionId,
              path: 'app.ts',
              scope: 'combined',
            });
            expect(diff._tag).toBe('Patch');
            if (diff._tag === 'Patch') {
              expect(diff.additions).toBe(2);
            }

            const commits = yield* client['SourceControl.commits']({
              sessionId,
              limit: 10,
              offset: 0,
            });
            expect(commits._tag).toBe('History');
            if (commits._tag !== 'History') return;
            expect(commits.commits).toHaveLength(1);
            const sha = commits.commits[0]?.sha ?? '';

            const detail = yield* client['SourceControl.commitDetail']({ sessionId, sha });
            expect(detail.files.map((f) => f.path)).toEqual(['app.ts']);

            const commitFileDiff = yield* client['SourceControl.commitFileDiff']({
              sessionId,
              sha,
              path: 'app.ts',
            });
            expect(commitFileDiff._tag).toBe('Patch');

            const missingErr = yield* client['SourceControl.status']({
              sessionId: SessionId.make('no-such-session'),
            }).pipe(Effect.flip);
            expect(missingErr._tag).toBe('SourceControlError');
            if (missingErr._tag === 'SourceControlError') {
              expect(missingErr.reason).toBe('NotFound');
            }

            const traversalErr = yield* client['SourceControl.diff']({
              sessionId,
              path: '../escape.txt',
            }).pipe(Effect.flip);
            expect(traversalErr._tag).toBe('SourceControlError');
            if (traversalErr._tag === 'SourceControlError') {
              expect(traversalErr.reason).toBe('InvalidInput');
            }
          }),
        ).pipe(
          Effect.provide(testLayer),
          Effect.ensuring(
            Effect.sync(() => {
              channel.port1.close();
              channel.port2.close();
            }).pipe(
              Effect.andThen(
                Effect.promise(() =>
                  rm(root, { recursive: true, force: true }).catch(() => undefined),
                ),
              ),
            ),
          ),
        );
      }),
    20_000,
  );
});
