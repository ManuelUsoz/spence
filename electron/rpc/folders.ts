import { FoldersRpcs } from '../../src/shared/folders/folders.rpc';
import { browseFolders } from '../folders/folders';

export const layerFoldersHandlers = FoldersRpcs.toLayer({
  'Folders.browse': ({ path, hidden }) => browseFolders(path, hidden),
});
