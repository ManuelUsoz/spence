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
  SessionFolders,
  SourceControl,
} from '../source-control/source-control';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';

const execFile = promisify(execFileCb);
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
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
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
    'SourceControl.diff': ({ sessionId, path, scope }) =>
      SourceControl.use((sourceControl) => sourceControl.diff(sessionId, path, scope)),
    'SourceControl.commits': ({ sessionId, limit, offset }) =>
      SourceControl.use((sourceControl) => sourceControl.commits(sessionId, limit, offset)),
  }).pipe(Layer.provide(layerSourceControl.pipe(Layer.provide(layerFolders))));
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
