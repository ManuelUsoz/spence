import { Context, Effect, Layer } from 'effect';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { toWireDefect } from '../../src/shared/rpc/wire-error';
import { FilesError, type FolderListing, type TextFile } from '../../src/shared/files/files.rpc';
import { Sessions } from '../sessions/sessions';
import { listFolder, readTextFile } from './files-core';

export interface FilesShape {
  readonly list: (id: SessionId, path: string) => Effect.Effect<FolderListing, FilesError>;
  readonly read: (id: SessionId, path: string) => Effect.Effect<TextFile, FilesError>;
}

export class Files extends Context.Service<Files, FilesShape>()('files/Files') {}

const GIT = 'git';
const pathEnv = (): string => process.env['PATH'] ?? process.env['Path'] ?? '';

export const layerFiles = Layer.effect(
  Files,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const folderOf = (id: SessionId) =>
      sessions
        .folderOf(id)
        .pipe(
          Effect.mapError(
            () => new FilesError({ reason: 'SessionNotFound', detail: `No Session ${id}.` }),
          ),
        );
    const run = <A>(work: () => Promise<A>) => toWireDefect(Effect.tryPromise(work));
    return {
      list: (id, path) =>
        folderOf(id).pipe(
          Effect.flatMap((folder) => run(() => listFolder(folder, path, GIT, pathEnv()))),
        ),
      read: (id, path) =>
        folderOf(id).pipe(Effect.flatMap((folder) => run(() => readTextFile(folder, path)))),
    };
  }),
);
