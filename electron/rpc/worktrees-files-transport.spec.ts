/**
 * Worktrees and Files RPCs over the real MessagePort transport with the production serialization, served from
 * real disposable Git repositories. The Session lookup is the only stand-in: it maps a Session id to a folder and
 * records which folder a draft was moved to.
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { promisify } from 'node:util';
import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Context, Effect, Layer } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { FilesRpcs } from '../../src/shared/files/files.rpc';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import { SessionError, SessionId } from '../../src/shared/sessions/sessions.rpc';
import { WorktreesRpcs } from '../../src/shared/worktrees/worktrees.rpc';
import { Files, layerFiles } from '../files/files';
import { Sessions, type SessionsShape } from '../sessions/sessions';
import { layerWorktrees, Worktrees } from '../worktrees/worktrees';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';

// Each test runs real git commands; the 5 s default is too tight while the whole suite runs.
vi.setConfig({ testTimeout: 60_000 });

const execFile = promisify(execFileCb);
const sessionId = SessionId.make('session-1');
const unknownSessionId = SessionId.make('session-unknown');

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  await execFile('git', args, { cwd });
};

const makeRepo = Effect.acquireRelease(
  Effect.promise(async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'spence-wt-transport-')));
    const dir = path.join(parent, 'app');
    await mkdir(dir);
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.email', 'test@spence.local');
    await git(dir, 'config', 'user.name', 'Spence Test');
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'main.ts'), 'export const a = 1;\n');
    await writeFile(path.join(dir, '.gitignore'), 'dist/\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'initial commit');
    return parent;
  }),
  (parent) =>
    Effect.promise(() =>
      rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    ),
);

interface Served {
  folder: string;
  /** True once the draft already ran a Turn: moving it is refused. */
  prompted: boolean;
}

const startServer = Effect.fnUntraced(function* (served: Served) {
  const stub: Pick<SessionsShape, 'folderOf' | 'isDraft' | 'setDraftFolder'> = {
    isDraft: () => Effect.succeed(!served.prompted),
    folderOf: (id) =>
      id === sessionId
        ? Effect.succeed(served.folder)
        : Effect.fail(new SessionError({ reason: 'NotFound', detail: 'No Session.' })),
    setDraftFolder: (id, folder) =>
      id !== sessionId
        ? Effect.fail(new SessionError({ reason: 'NotFound', detail: 'No Session.' }))
        : served.prompted
          ? Effect.fail(new SessionError({ reason: 'Busy', detail: 'A Turn already ran.' }))
          : Effect.sync(() => {
              served.folder = folder;
            }),
  };
  const layerSessions = Layer.succeed(Sessions, stub as SessionsShape);
  const layerHandlers = Layer.mergeAll(
    WorktreesRpcs.toLayer({
      'Worktrees.list': ({ sessionId }) => Worktrees.use((w) => w.list(sessionId)),
      'Worktrees.create': ({ sessionId, branch }) =>
        Worktrees.use((w) => w.create(sessionId, branch)),
      'Worktrees.select': ({ sessionId, path }) => Worktrees.use((w) => w.select(sessionId, path)),
    }).pipe(Layer.provide(layerWorktrees.pipe(Layer.provide(layerSessions)))),
    FilesRpcs.toLayer({
      'Files.list': ({ sessionId, path }) => Files.use((f) => f.list(sessionId, path)),
      'Files.read': ({ sessionId, path }) => Files.use((f) => f.read(sessionId, path)),
    }).pipe(Layer.provide(layerFiles.pipe(Layer.provide(layerSessions)))),
  );
  const group = WorktreesRpcs.merge(FilesRpcs);
  const context = yield* Layer.build(
    RpcServer.layer(group).pipe(Layer.provideMerge(layerIpcServer), Layer.provide(layerHandlers)),
  );
  const handoff = Context.get(context, RpcPortHandoff);
  const { port1, port2 } = new MessageChannel();
  handoff.bind(serverPort(port1));
  const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
  return yield* RpcClient.make(group).pipe(Effect.provideContext(protocol));
});

describe('Worktrees over the MessagePort transport', () => {
  it.live('creates a Worktree, lists it, and moves a draft Session into it', () =>
    Effect.gen(function* () {
      const parent = yield* makeRepo;
      const served: Served = { folder: path.join(parent, 'app'), prompted: false };
      const client = yield* startServer(served);

      const created = yield* client['Worktrees.create']({ sessionId, branch: 'feature/x' });
      expect(created._tag).toBe('Created');
      if (created._tag !== 'Created') return;
      expect(created.entry.branch).toBe('feature/x');

      const listed = yield* client['Worktrees.list']({ sessionId });
      if (listed._tag !== 'Available') throw new Error('expected Available');
      expect(listed.entries.map((e) => [e.branch, e.isCurrent])).toEqual([
        ['main', true],
        ['feature/x', false],
      ]);

      const selected = yield* client['Worktrees.select']({ sessionId, path: created.entry.path });
      expect(selected._tag).toBe('Selected');
      expect(served.folder).toBe(created.entry.path);
    }).pipe(Effect.scoped),
  );

  it.live('refuses to move a Session that already ran a Turn, and a path that is no Worktree', () =>
    Effect.gen(function* () {
      const parent = yield* makeRepo;
      const served: Served = { folder: path.join(parent, 'app'), prompted: true };
      const client = yield* startServer(served);
      const created = yield* client['Worktrees.create']({ sessionId, branch: 'later' });
      if (created._tag !== 'Created') throw new Error('expected Created');

      const busy = yield* client['Worktrees.select']({ sessionId, path: created.entry.path });
      const unknown = yield* client['Worktrees.select']({ sessionId, path: parent });

      expect(busy).toMatchObject({ _tag: 'Rejected', reason: 'Busy' });
      expect(unknown).toMatchObject({ _tag: 'Rejected', reason: 'Unknown' });
      expect(served.folder).toBe(path.join(parent, 'app'));
    }).pipe(Effect.scoped),
  );

  it.live('reports an unknown Session as a typed WorktreesError', () =>
    Effect.gen(function* () {
      const parent = yield* makeRepo;
      const client = yield* startServer({ folder: path.join(parent, 'app'), prompted: false });

      const failed = yield* client['Worktrees.list']({ sessionId: unknownSessionId }).pipe(
        Effect.flip,
      );

      expect(failed).toMatchObject({ _tag: 'WorktreesError', reason: 'SessionNotFound' });
    }).pipe(Effect.scoped),
  );
});

describe('Files over the MessagePort transport', () => {
  it.live('lists a folder, reads a file, and refuses a path outside the folder', () =>
    Effect.gen(function* () {
      const parent = yield* makeRepo;
      const client = yield* startServer({ folder: path.join(parent, 'app'), prompted: false });

      const root = yield* client['Files.list']({ sessionId, path: '' });
      if (root._tag !== 'Listing') throw new Error('expected Listing');
      expect(root.entries.map((e) => [e.name, e.kind])).toEqual([
        ['src', 'Dir'],
        ['.gitignore', 'File'],
      ]);

      const file = yield* client['Files.read']({ sessionId, path: 'src/main.ts' });
      expect(file).toEqual({ _tag: 'Text', content: 'export const a = 1;\n', size: 20 });

      const escaped = yield* client['Files.read']({ sessionId, path: '../outside' });
      expect(escaped._tag).toBe('Invalid');
    }).pipe(Effect.scoped),
  );
});
