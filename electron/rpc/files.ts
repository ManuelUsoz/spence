import { Layer } from 'effect';
import { FilesRpcs } from '../../src/shared/files/files.rpc';
import { Files, layerFiles } from '../files/files';
import { layerSessionsLive } from './sessions';

/** Unbound: needs `Files`, so a test Device can serve it over its own Sessions. */
export const layerFilesHandlersWith = FilesRpcs.toLayer({
  'Files.list': ({ sessionId, path }) => Files.use((files) => files.list(sessionId, path)),
  'Files.read': ({ sessionId, path }) => Files.use((files) => files.read(sessionId, path)),
});

export const layerFilesHandlers = layerFilesHandlersWith.pipe(
  Layer.provide(layerFiles.pipe(Layer.provide(layerSessionsLive))),
);
