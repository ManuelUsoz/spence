import { MessageChannel } from 'node:worker_threads';
import { it } from '@effect/vitest';
import { Context, Effect, Layer, Stream } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { describe, expect } from 'vitest';
import { FilesError, FilesRpcs, type FilesPreview } from '../../src/shared/files/files.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';

const projectId = ProjectId.make('proj-1');
const opened: string[] = [];

const previewSample: FilesPreview = {
  _tag: 'Text',
  path: 'src/app.ts',
  content: 'export const ready = true;\n',
  byteLength: 27,
  totalBytes: 27,
  truncated: false,
  previewLimitBytes: 2 * 1024 * 1024,
  mtimeMs: 1234,
};

const layerHandlers = FilesRpcs.toLayer({
  'Files.listDir': ({ dirPath, showIgnoredFiles }) =>
    Effect.succeed({
      dirPath,
      isGitRepo: true,
      showIgnoredFiles: showIgnoredFiles ?? false,
      entries: [
        { path: 'src', name: 'src', kind: 'directory', ignored: false },
        { path: 'README.md', name: 'README.md', kind: 'file', ignored: false, size: 12 },
      ],
      hasMore: false,
    }),
  'Files.readPreview': ({ relativePath }) =>
    relativePath.includes('..')
      ? Effect.fail(new FilesError({ reason: 'OutsideRoot', detail: 'Traversal blocked' }))
      : Effect.succeed(previewSample),
  'Files.openExternal': ({ relativePath }) =>
    Effect.sync(() => {
      opened.push(relativePath);
    }),
  'Files.watch': () =>
    Stream.make(
      { _tag: 'Changed', paths: ['src/app.ts'], overflow: false },
      { _tag: 'Changed', paths: [''], overflow: true },
    ),
});

const startServer = Effect.fnUntraced(function* () {
  const context = yield* Layer.build(
    RpcServer.layer(FilesRpcs).pipe(
      Layer.provideMerge(layerIpcServer),
      Layer.provide(layerHandlers),
    ),
  );
  const handoff = Context.get(context, RpcPortHandoff);
  return Effect.fnUntraced(function* () {
    const { port1, port2 } = new MessageChannel();
    handoff.bind(serverPort(port1));
    const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
    return yield* RpcClient.make(FilesRpcs).pipe(Effect.provideContext(protocol));
  });
});

describe('FilesRpcs over the MessagePort transport', () => {
  it.live('round-trips listDir, readPreview, openExternal, watch stream, and typed errors', () =>
    Effect.gen(function* () {
      const connect = yield* startServer();
      const client = yield* connect();

      const page = yield* client['Files.listDir']({
        target: { projectId },
        dirPath: '',
      });
      expect(page.entries.map((entry) => entry.name)).toEqual(['src', 'README.md']);

      const preview = yield* client['Files.readPreview']({
        target: { projectId },
        relativePath: 'src/app.ts',
      });
      expect(preview).toEqual(previewSample);

      const escaped = yield* client['Files.readPreview']({
        target: { projectId },
        relativePath: '../secret.txt',
      }).pipe(Effect.flip);
      expect(escaped).toMatchObject({ _tag: 'FilesError', reason: 'OutsideRoot' });

      yield* client['Files.openExternal']({
        target: { projectId },
        relativePath: 'src/app.ts',
      });
      expect(opened).toContain('src/app.ts');

      const events = yield* client['Files.watch']({ target: { projectId } }).pipe(
        Stream.runCollect,
        Effect.timeout('5 seconds'),
      );
      expect([...events]).toEqual([
        { _tag: 'Changed', paths: ['src/app.ts'], overflow: false },
        { _tag: 'Changed', paths: [''], overflow: true },
      ]);
    }).pipe(Effect.scoped),
  );
});
