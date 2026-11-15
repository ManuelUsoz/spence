import { SourceControlRpcs } from '../../src/shared/source-control/source-control.rpc';
import { SourceControl } from '../source-control/source-control';

/** Handler layer for Source Control inspection RPCs. */
export const layerSourceControlHandlers = SourceControlRpcs.toLayer({
  'SourceControl.status': ({ sessionId }) => SourceControl.use((sc) => sc.status(sessionId)),
  'SourceControl.diff': ({ sessionId, path, scope }) =>
    SourceControl.use((sc) => sc.diff(sessionId, path, scope)),
  'SourceControl.commits': ({ sessionId, limit, offset }) =>
    SourceControl.use((sc) => sc.commits(sessionId, limit, offset)),
  'SourceControl.commitDetail': ({ sessionId, sha }) =>
    SourceControl.use((sc) => sc.commitDetail(sessionId, sha)),
  'SourceControl.commitFileDiff': ({ sessionId, sha, path }) =>
    SourceControl.use((sc) => sc.commitFileDiff(sessionId, sha, path)),
});
