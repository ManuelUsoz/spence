import { Layer } from 'effect';
import { SourceControlRpcs } from '../../src/shared/source-control/source-control.rpc';
import {
  layerSessionFoldersLive,
  layerSourceControl,
  SourceControl,
} from '../source-control/source-control';
import { layerSessionsLive } from './sessions';

export const layerSourceControlHandlers = SourceControlRpcs.toLayer({
  'SourceControl.changes': ({ sessionId }) =>
    SourceControl.use((sourceControl) => sourceControl.changes(sessionId)),
  'SourceControl.diff': ({ sessionId, path, previousPath, scope }) =>
    SourceControl.use((sourceControl) => sourceControl.diff(sessionId, path, scope, previousPath)),
  'SourceControl.commits': ({ sessionId, limit, offset }) =>
    SourceControl.use((sourceControl) => sourceControl.commits(sessionId, limit, offset)),
  'SourceControl.commit': ({ sessionId, message, files, push, remote }) =>
    SourceControl.use((sourceControl) =>
      sourceControl.commit(sessionId, message, files, push, remote),
    ),
  'SourceControl.fetch': ({ sessionId }) =>
    SourceControl.use((sourceControl) => sourceControl.fetch(sessionId)),
  'SourceControl.pull': ({ sessionId }) =>
    SourceControl.use((sourceControl) => sourceControl.pull(sessionId)),
  'SourceControl.push': ({ sessionId, remote }) =>
    SourceControl.use((sourceControl) => sourceControl.push(sessionId, remote)),
}).pipe(
  Layer.provide(
    layerSourceControl.pipe(
      Layer.provide(layerSessionFoldersLive.pipe(Layer.provide(layerSessionsLive))),
    ),
  ),
);
