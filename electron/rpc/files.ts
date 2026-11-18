import { Layer } from 'effect';
import { FilesRpcs } from '../../src/shared/files/files.rpc';
import { Files, layerFiles } from '../files/files';
import { layerSessionsLive } from './sessions';

export const layerFilesHandlers = FilesRpcs.toLayer({
  'Files.list': ({ sessionId, path }) => Files.use((files) => files.list(sessionId, path)),
  'Files.read': ({ sessionId, path }) => Files.use((files) => files.read(sessionId, path)),
}).pipe(Layer.provide(layerFiles.pipe(Layer.provide(layerSessionsLive))));
