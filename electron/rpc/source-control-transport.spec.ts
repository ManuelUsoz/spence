/**
 * `SourceControl.*` over the real MessagePort transport with the production serialization, served from a real
 * disposable Git repository: the payloads survive `layerSchemaBinary`, which `makeDesktopTestLayer` does not exercise.
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { promisify } from 'node:util';
import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Context, Effect, Layer } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import {
  SourceControlError,
  SourceControlRpcs,
} from '../../src/shared/source-control/source-control.rpc';
import {
  layerSourceControl,
  RecoveryRoot,
  SessionFolders,
  SourceControl,
} from '../source-control/source-control';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';

// Each test runs real git commands; the 5 s default is too tight while the whole suite runs.
vi.setConfig({ testTimeout: 60_000 });

const execFile = promisify(execFileCb);
/** Tests that run many real git commands: the 5 s default is too tight while the whole suite runs. */
const LONG_TEST = 30_000;
const sessionId = SessionId.make('session-1');
const unknownSessionId = SessionId.make('session-unknown');

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  await execFile('git', args, { cwd });
};

const makeRepo = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spence-transport-'));
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.email', 'test@spence.local');
    await git(dir, 'config', 'user.name', 'Spence Test');
    await writeFile(path.join(dir, 'tracked.txt'), 'one\ntwo\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'initial commit');
    await writeFile(path.join(dir, 'tracked.txt'), 'one\nTWO\nthree\n');
    await writeFile(path.join(dir, 'fresh.txt'), 'a\n');
    return dir;
  }),
  (dir) =>
    Effect.promise(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await rm(`${dir}-recovery`, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }),
);

const startServer = Effect.fnUntraced(function* (folder: string) {
  const layerFolders = Layer.succeed(SessionFolders, {
    folderOf: (id: SessionId) =>
      id === sessionId
        ? Effect.succeed(folder)
        : Effect.fail(new SourceControlError({ reason: 'SessionNotFound', detail: 'No Session.' })),
  });
  const layerHandlers = SourceControlRpcs.toLayer({
    'SourceControl.changes': ({ sessionId }) =>
      SourceControl.use((sourceControl) => sourceControl.changes(sessionId)),
    'SourceControl.diff': ({ sessionId, path, previousPath, scope }) =>
      SourceControl.use((sourceControl) =>
        sourceControl.diff(sessionId, path, scope, previousPath),
      ),
    'SourceControl.commits': ({ sessionId, limit, offset }) =>
      SourceControl.use((sourceControl) => sourceControl.commits(sessionId, limit, offset)),
    'SourceControl.commitDetail': ({ sessionId, sha }) =>
      SourceControl.use((sourceControl) => sourceControl.commitDetail(sessionId, sha)),
    'SourceControl.commitDiff': ({ sessionId, sha, path, previousPath }) =>
      SourceControl.use((sourceControl) =>
        sourceControl.commitDiff(sessionId, sha, path, previousPath),
      ),
    'SourceControl.commit': ({ sessionId, message, files, push, remote }) =>
      SourceControl.use((sourceControl) =>
        sourceControl.commit(sessionId, message, files, push, remote),
      ),
    'SourceControl.prepareDiscard': ({ sessionId, files }) =>
      SourceControl.use((sourceControl) => sourceControl.prepareDiscard(sessionId, files)),
    'SourceControl.discard': ({ sessionId, files, token }) =>
      SourceControl.use((sourceControl) => sourceControl.discard(sessionId, files, token)),
    'SourceControl.revert': ({ sessionId, sha }) =>
      SourceControl.use((sourceControl) => sourceControl.revert(sessionId, sha)),
    'SourceControl.branches': ({ sessionId }) =>
      SourceControl.use((sourceControl) => sourceControl.branches(sessionId)),
    'SourceControl.fetch': ({ sessionId }) =>
      SourceControl.use((sourceControl) => sourceControl.fetch(sessionId)),
    'SourceControl.pull': ({ sessionId }) =>
      SourceControl.use((sourceControl) => sourceControl.pull(sessionId)),
    'SourceControl.push': ({ sessionId, remote }) =>
      SourceControl.use((sourceControl) => sourceControl.push(sessionId, remote)),
  }).pipe(
    Layer.provide(
      layerSourceControl.pipe(
        Layer.provide(layerFolders),
        Layer.provide(Layer.succeed(RecoveryRoot, { folder: `${folder}-recovery` })),
      ),
    ),
  );
  const context = yield* Layer.build(
    RpcServer.layer(SourceControlRpcs).pipe(
      Layer.provideMerge(layerIpcServer),
      Layer.provide(layerHandlers),
    ),
  );
  const handoff = Context.get(context, RpcPortHandoff);
  const { port1, port2 } = new MessageChannel();
  handoff.bind(serverPort(port1));
  const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
  return yield* RpcClient.make(SourceControlRpcs).pipe(Effect.provideContext(protocol));
});

describe('SourceControl over the MessagePort transport', () => {
  it.live('serves changes, a file diff and history of the Session folder intact', () =>
    Effect.gen(function* () {
      const folder = yield* makeRepo;
      const client = yield* startServer(folder);

      const changes = yield* client['SourceControl.changes']({ sessionId });
      expect(changes._tag).toBe('Available');
      if (changes._tag !== 'Available') return;
      expect(changes.head).toEqual({ _tag: 'Branch', branch: 'main' });
      expect(changes.files.map((file) => [file.path, file.status])).toEqual([
        ['fresh.txt', 'Untracked'],
        ['tracked.txt', 'Modified'],
      ]);

      const diff = yield* client['SourceControl.diff']({
        sessionId,
        path: 'tracked.txt',
        scope: 'combined',
      });
      expect(diff._tag).toBe('Patch');
      if (diff._tag !== 'Patch') return;
      expect(diff.additions).toBe(2);
      expect(diff.deletions).toBe(1);

      const commits = yield* client['SourceControl.commits']({ sessionId, limit: 10, offset: 0 });
      expect(commits._tag).toBe('History');
      if (commits._tag !== 'History') return;
      expect(commits.commits.map((commit) => commit.subject)).toEqual(['initial commit']);
    }).pipe(Effect.scoped),
  );

  it.live(
    'commits the chosen files and reports the rest still changed, intact over the wire',
    () =>
      Effect.gen(function* () {
        const folder = yield* makeRepo;
        const client = yield* startServer(folder);

        const result = yield* client['SourceControl.commit']({
          sessionId,
          message: 'Update tracked',
          files: [{ path: 'tracked.txt' }],
          push: false,
        });
        expect(result).toMatchObject({ _tag: 'Committed', pushed: 'NotRequested' });

        const changes = yield* client['SourceControl.changes']({ sessionId });
        if (changes._tag !== 'Available') throw new Error('expected Available');
        expect(changes.files.map((file) => file.path)).toEqual(['fresh.txt']);
        expect(changes.remotes).toEqual([]);

        const refused = yield* client['SourceControl.push']({ sessionId });
        expect(refused).toMatchObject({ _tag: 'Rejected', reason: 'NoRemote' });
      }).pipe(Effect.scoped),
    LONG_TEST,
  );

  it.live(
    'shows the plan, discards with its token, refuses a stale token, over the wire',
    () =>
      Effect.gen(function* () {
        const folder = yield* makeRepo;
        const client = yield* startServer(folder);
        const files = [{ path: 'tracked.txt' }, { path: 'fresh.txt' }];

        const plan = yield* client['SourceControl.prepareDiscard']({ sessionId, files });
        if (plan._tag !== 'Ready') throw new Error('expected Ready');
        expect(plan.files.map((file) => [file.path, file.effect])).toEqual([
          ['fresh.txt', 'Remove'],
          ['tracked.txt', 'Restore'],
        ]);

        const stale = yield* client['SourceControl.discard']({
          sessionId,
          files,
          token: 'not-the-token',
        });
        expect(stale).toMatchObject({ _tag: 'Rejected', reason: 'Stale' });

        const done = yield* client['SourceControl.discard']({
          sessionId,
          files,
          token: plan.token,
        });
        expect(done).toMatchObject({ _tag: 'Discarded', count: 2, recoveryDays: 30 });

        const changes = yield* client['SourceControl.changes']({ sessionId });
        if (changes._tag !== 'Available') throw new Error('expected Available');
        expect(changes.files).toEqual([]);
      }).pipe(Effect.scoped),
    LONG_TEST,
  );

  it.live(
    'reverts a commit and refuses an unknown one, over the wire',
    () =>
      Effect.gen(function* () {
        const folder = yield* makeRepo;
        const client = yield* startServer(folder);
        // The fixture leaves tracked changes; commit them so the revert has a clean tree.
        yield* client['SourceControl.commit']({
          sessionId,
          message: 'Second',
          files: [{ path: 'tracked.txt' }, { path: 'fresh.txt' }],
          push: false,
        });
        const history = yield* client['SourceControl.commits']({ sessionId, limit: 5, offset: 0 });
        if (history._tag !== 'History') throw new Error('expected History');

        const unknown = yield* client['SourceControl.revert']({ sessionId, sha: 'f'.repeat(40) });
        expect(unknown).toMatchObject({ _tag: 'Rejected', reason: 'UnknownCommit' });

        const reverted = yield* client['SourceControl.revert']({
          sessionId,
          sha: history.commits[0]!.sha,
        });
        expect(reverted._tag).toBe('Reverted');
      }).pipe(Effect.scoped),
    LONG_TEST,
  );

  it.live(
    'serves a commit with its files and a file diff, and refuses an unknown one, over the wire',
    () =>
      Effect.gen(function* () {
        const folder = yield* makeRepo;
        const client = yield* startServer(folder);
        const history = yield* client['SourceControl.commits']({ sessionId, limit: 5, offset: 0 });
        if (history._tag !== 'History') throw new Error('expected History');
        const sha = history.commits[0]?.sha ?? '';

        const detail = yield* client['SourceControl.commitDetail']({ sessionId, sha });
        if (detail._tag !== 'Detail') throw new Error('expected Detail');
        expect(detail.commit.subject).toBe('initial commit');
        expect(detail.commit.files.map((file) => [file.path, file.status])).toEqual([
          ['tracked.txt', 'Added'],
        ]);

        const diff = yield* client['SourceControl.commitDiff']({
          sessionId,
          sha,
          path: 'tracked.txt',
        });
        expect(diff).toMatchObject({ _tag: 'Patch', deletions: 0 });

        const unknown = yield* client['SourceControl.commitDetail']({
          sessionId,
          sha: 'f'.repeat(40),
        });
        expect(unknown._tag).toBe('UnknownCommit');
      }).pipe(Effect.scoped),
  );

  it.live('reports an unknown Session as a typed SourceControlError', () =>
    Effect.gen(function* () {
      const folder = yield* makeRepo;
      const client = yield* startServer(folder);

      const failed = yield* client['SourceControl.changes']({ sessionId: unknownSessionId }).pipe(
        Effect.flip,
      );

      expect(failed._tag).toBe('SourceControlError');
      expect(failed.reason).toBe('SessionNotFound');
    }).pipe(Effect.scoped),
  );
});
