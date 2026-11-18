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
  'SourceControl.diff': ({ sessionId, path, scope }) =>
    SourceControl.use((sourceControl) => sourceControl.diff(sessionId, path, scope)),
  'SourceControl.commits': ({ sessionId, limit, offset }) =>
    SourceControl.use((sourceControl) => sourceControl.commits(sessionId, limit, offset)),
}).pipe(
  Layer.provide(
    layerSourceControl.pipe(
      Layer.provide(layerSessionFoldersLive.pipe(Layer.provide(layerSessionsLive))),
    ),
  ),
);
