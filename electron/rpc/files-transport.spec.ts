import { MessageChannel } from 'node:worker_threads';
import { it } from '@effect/vitest';
import { Context, Effect, Layer, Stream } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { describe, expect } from 'vitest';
import {
  FileOperationRpcs,
  FileOperationsError,
  type FileOperationReview,
} from '../../src/shared/files/file-operations.rpc';
import { FilesError, FilesRpcs, type FilesPreview } from '../../src/shared/files/files.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { OperationId, ReviewId } from '../../src/shared/source-control/source-control.rpc';
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

const sampleReview: FileOperationReview = {
  reviewId: ReviewId.make('rev-1'),
  issuedAt: 1,
  expiresAt: 2,
  kind: 'Files.create',
  targets: [
    {
      path: 'new.ts',
      kind: 'missing',
      exists: false,
      willBeTrashed: false,
      willBePermanentlyRemoved: false,
    },
  ],
  warnings: [],
  blockers: [],
  requiresPermanentConfirmation: false,
};

const filesHandlers = FilesRpcs.toLayer({
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

const fileOperationHandlers = FileOperationRpcs.toLayer({
  'FileOperations.reviewCreate': ({ dirPath, name }) =>
    name.includes('..')
      ? Effect.fail(new FileOperationsError({ reason: 'OutsideRoot', detail: 'Bad name' }))
      : Effect.succeed({
          ...sampleReview,
          kind: 'Files.create',
          targets: [
            {
              path: dirPath === '' ? name : `${dirPath}/${name}`,
              kind: 'missing',
              exists: false,
              willBeTrashed: false,
              willBePermanentlyRemoved: false,
            },
          ],
        }),
  'FileOperations.reviewRename': ({ relativePath, newName }) =>
    Effect.succeed({
      ...sampleReview,
      kind: 'Files.rename',
      targets: [
        {
          path: relativePath,
          kind: 'file',
          exists: true,
          willBeTrashed: false,
          willBePermanentlyRemoved: false,
          destinationPath: newName,
        },
      ],
    }),
  'FileOperations.reviewDelete': ({ relativePaths }) =>
    Effect.succeed({
      ...sampleReview,
      kind: 'Files.delete',
      targets: relativePaths.map((p) => ({
        path: p,
        kind: 'file',
        exists: true,
        willBeTrashed: true,
        willBePermanentlyRemoved: false,
      })),
    }),
  'FileOperations.execute': ({ allowPermanentDelete }) =>
    allowPermanentDelete
      ? Effect.succeed({
          id: OperationId.make('op-1'),
          kind: 'Files.delete' as const,
          title: 'Delete',
          phase: 'Completed' as const,
          outcome: 'Succeeded' as const,
          warnings: [],
          createdAt: 1,
          updatedAt: 1,
        })
      : Effect.fail(
          new FileOperationsError({
            reason: 'TrashUnavailable',
            detail: 'Trash is unavailable. Confirm permanent deletion to proceed.',
          }),
        ),
});

const rpcGroup = FilesRpcs.merge(FileOperationRpcs);

const startServer = Effect.fnUntraced(function* () {
  const context = yield* Layer.build(
    RpcServer.layer(rpcGroup).pipe(
      Layer.provideMerge(layerIpcServer),
      Layer.provide(Layer.mergeAll(filesHandlers, fileOperationHandlers)),
    ),
  );
  const handoff = Context.get(context, RpcPortHandoff);
  return Effect.fnUntraced(function* () {
    const { port1, port2 } = new MessageChannel();
    handoff.bind(serverPort(port1));
    const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
    return yield* RpcClient.make(rpcGroup).pipe(Effect.provideContext(protocol));
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

describe('FileOperationRpcs over the MessagePort transport', () => {
  it.live('round-trips review and execute with typed FileOperationsError', () =>
    Effect.gen(function* () {
      const connect = yield* startServer();
      const client = yield* connect();

      const createReview = yield* client['FileOperations.reviewCreate']({
        target: { projectId },
        dirPath: '',
        name: 'new.ts',
        kind: 'file',
      });
      expect(createReview.kind).toBe('Files.create');
      expect(createReview.targets[0]).toMatchObject({ path: 'new.ts', exists: false });

      const blocked = yield* client['FileOperations.reviewCreate']({
        target: { projectId },
        dirPath: '',
        name: '../escape',
        kind: 'file',
      }).pipe(Effect.flip);
      expect(blocked).toMatchObject({ _tag: 'FileOperationsError', reason: 'OutsideRoot' });

      const renameReview = yield* client['FileOperations.reviewRename']({
        target: { projectId },
        relativePath: 'old.ts',
        newName: 'renamed.ts',
      });
      expect(renameReview.kind).toBe('Files.rename');
      expect(renameReview.targets[0]?.destinationPath).toBe('renamed.ts');

      const deleteReview = yield* client['FileOperations.reviewDelete']({
        target: { projectId },
        relativePaths: ['a.ts', 'b.ts'],
      });
      expect(deleteReview.kind).toBe('Files.delete');
      expect(deleteReview.targets).toHaveLength(2);

      const firstExecute = yield* client['FileOperations.execute']({
        reviewId: deleteReview.reviewId,
        operationId: OperationId.make('op-1'),
      }).pipe(Effect.flip);
      expect(firstExecute).toMatchObject({
        _tag: 'FileOperationsError',
        reason: 'TrashUnavailable',
      });

      const secondExecute = yield* client['FileOperations.execute']({
        reviewId: deleteReview.reviewId,
        operationId: OperationId.make('op-1'),
        allowPermanentDelete: true,
      });
      expect(secondExecute.outcome).toBe('Succeeded');
    }).pipe(Effect.scoped),
  );
});
