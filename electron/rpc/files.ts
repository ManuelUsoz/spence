import { Effect, Stream } from 'effect';
import { FilesRpcs } from '../../src/shared/files/files.rpc';
import { Files } from '../files/files';

/** Handler layer for workspace file browsing, previewing, watching, and external opening. */
export const layerFilesHandlers = FilesRpcs.toLayer({
  'Files.listDir': ({ target, dirPath, cursor, limit, showIgnoredFiles }) =>
    Files.use((files) =>
      files.listDir({
        target,
        dirPath,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(showIgnoredFiles === undefined ? {} : { showIgnoredFiles }),
      }),
    ),
  'Files.readPreview': ({ target, relativePath, maxBytes }) =>
    Files.use((files) =>
      files.readPreview({
        target,
        relativePath,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      }),
    ),
  'Files.openExternal': ({ target, relativePath }) =>
    Files.use((files) => files.openExternal({ target, relativePath })),
  'Files.watch': ({ target }) =>
    Stream.unwrap(Files.use((files) => Effect.succeed(files.watch(target)))),
});
