import { Effect, Layer } from 'effect';
import path from 'node:path';
import { SourceControlRpcs } from '../../src/shared/source-control/source-control.rpc';
import {
  layerSessionFoldersLive,
  layerSourceControl,
  RecoveryRoot,
  SourceControl,
} from '../source-control/source-control';
import { Store, layerStoreUserData } from '../store/store';
import { layerSessionsLive } from './sessions';

/** Copies of discarded changes live beside Spence's other files, under `<store>/discarded`. */
const layerRecoveryRoot = Layer.effect(
  RecoveryRoot,
  Effect.gen(function* () {
    const store = yield* Store;
    return { folder: path.join(store.root, 'discarded') };
  }),
).pipe(Layer.provide(layerStoreUserData));

/** Unbound: needs `SourceControl`, so a test Device can serve it over its own Sessions. */
export const layerSourceControlHandlersWith = SourceControlRpcs.toLayer({
  'SourceControl.changes': ({ sessionId }) =>
    SourceControl.use((sourceControl) => sourceControl.changes(sessionId)),
  'SourceControl.diff': ({ sessionId, path, previousPath, scope }) =>
    SourceControl.use((sourceControl) => sourceControl.diff(sessionId, path, scope, previousPath)),
  'SourceControl.commits': ({ sessionId, limit, offset }) =>
    SourceControl.use((sourceControl) => sourceControl.commits(sessionId, limit, offset)),
  'SourceControl.commitDetail': ({ sessionId, sha }) =>
    SourceControl.use((sourceControl) => sourceControl.commitDetail(sessionId, sha)),
  'SourceControl.commitDiff': ({ sessionId, sha, path, previousPath }) =>
    SourceControl.use((sourceControl) =>
      sourceControl.commitDiff(sessionId, sha, path, previousPath),
    ),
  'SourceControl.commit': ({ sessionId, message, files, push, remote }) =>
    SourceControl.use((sourceControl) =>
      sourceControl.commit(sessionId, message, files, push, remote),
    ),
  'SourceControl.prepareDiscard': ({ sessionId, files }) =>
    SourceControl.use((sourceControl) => sourceControl.prepareDiscard(sessionId, files)),
  'SourceControl.discard': ({ sessionId, files, token }) =>
    SourceControl.use((sourceControl) => sourceControl.discard(sessionId, files, token)),
  'SourceControl.revert': ({ sessionId, sha }) =>
    SourceControl.use((sourceControl) => sourceControl.revert(sessionId, sha)),
  'SourceControl.branches': ({ sessionId }) =>
    SourceControl.use((sourceControl) => sourceControl.branches(sessionId)),
  'SourceControl.fetch': ({ sessionId }) =>
    SourceControl.use((sourceControl) => sourceControl.fetch(sessionId)),
  'SourceControl.pull': ({ sessionId }) =>
    SourceControl.use((sourceControl) => sourceControl.pull(sessionId)),
  'SourceControl.push': ({ sessionId, remote }) =>
    SourceControl.use((sourceControl) => sourceControl.push(sessionId, remote)),
});

export const layerSourceControlHandlers = layerSourceControlHandlersWith.pipe(
  Layer.provide(
    layerSourceControl.pipe(
      Layer.provide(layerSessionFoldersLive.pipe(Layer.provide(layerSessionsLive))),
      Layer.provide(layerRecoveryRoot),
    ),
  ),
);
