/**
 * Worktrees and Files RPCs over the real MessagePort transport with the production serialization, served from
 * real disposable Git repositories. The Session lookup is the only stand-in: it maps a Session id to a folder and
 * records which folder a draft was moved to.
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
/** Tests that run many real git commands: the 5 s default is too tight while the whole suite runs. */
const LONG_TEST = 30_000;
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
        : Effect.sync(() => {
            served.folder = folder;
          }),
  };
  const layerSessions = Layer.succeed(Sessions, stub as SessionsShape);
  const layerHandlers = Layer.mergeAll(
    WorktreesRpcs.toLayer({
      'Worktrees.list': ({ sessionId }) => Worktrees.use((w) => w.list(sessionId)),
      'Worktrees.prepareDraft': ({ sessionId, branch, base }) =>
        Worktrees.use((w) => w.prepareDraft(sessionId, branch, base)),
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
  it.live(
    'lists the Worktrees, then prepares a draft Session in a new one started from the chosen base',
    () =>
      Effect.gen(function* () {
        const parent = yield* makeRepo;
        const repo = path.join(parent, 'app');
        yield* Effect.promise(async () => {
          await git(repo, 'checkout', '-b', 'develop');
          await writeFile(path.join(repo, 'dev.txt'), 'dev\n');
          await git(repo, 'add', '.');
          await git(repo, 'commit', '-m', 'develop work');
          await git(repo, 'checkout', 'main');
        });
        const served: Served = { folder: repo, prompted: false };
        const client = yield* startServer(served);

        const before = yield* client['Worktrees.list']({ sessionId });
        if (before._tag !== 'Available') throw new Error('expected Available');
        expect(before.canSelect).toBe(true);
        expect(before.entries.map((e) => e.branch)).toEqual(['main']);

        const prepared = yield* client['Worktrees.prepareDraft']({
          sessionId,
          branch: 'wt/side',
          base: 'develop',
        });

        expect(prepared._tag).toBe('Prepared');
        if (prepared._tag !== 'Prepared') return;
        expect(prepared.entry.branch).toBe('wt/side');
        expect(served.folder).toBe(prepared.entry.path);
        const started = yield* Effect.promise(() =>
          readFile(path.join(prepared.entry.path, 'dev.txt'), 'utf8'),
        );
        expect(started.replace(/\r\n/g, '\n')).toBe('dev\n');
      }).pipe(Effect.scoped),
    LONG_TEST,
  );

  it.live(
    'refuses once the Session ran a Turn, and says why a worktree cannot be made, changing nothing',
    () =>
      Effect.gen(function* () {
        const parent = yield* makeRepo;
        const repo = path.join(parent, 'app');
        const served: Served = { folder: repo, prompted: true };
        const client = yield* startServer(served);

        const busy = yield* client['Worktrees.prepareDraft']({ sessionId, branch: 'wt/late' });
        expect(busy).toMatchObject({ _tag: 'Rejected', reason: 'Busy' });

        served.prompted = false;
        const taken = yield* client['Worktrees.prepareDraft']({ sessionId, branch: 'main' });
        const unknownBase = yield* client['Worktrees.prepareDraft']({
          sessionId,
          branch: 'wt/x',
          base: 'nope',
        });
        const invalid = yield* client['Worktrees.prepareDraft']({ sessionId, branch: 'bad name' });

        expect(taken).toMatchObject({ _tag: 'Rejected', reason: 'BranchExists' });
        expect(unknownBase).toMatchObject({ _tag: 'Rejected', reason: 'UnknownBase' });
        expect(invalid).toMatchObject({ _tag: 'Rejected', reason: 'InvalidBranch' });
        expect(served.folder).toBe(repo);
      }).pipe(Effect.scoped),
    LONG_TEST,
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
