import { Effect } from 'effect';
import { AssetsError, AssetsRpcs } from '../../src/shared/assets/assets.rpc';

/**
 * The window's own Device mints no handles: its Transcripts keep their bytes inline, so a handle is only ever valid on
 * a LAN connection (`serveRemoteAssets`). A call naming a Remote device is routed there before reaching this.
 */
export const layerAssetsHandlers = AssetsRpcs.toLayer({
  'Assets.read': ({ handle }) =>
    Effect.fail(new AssetsError({ reason: 'NotFound', detail: `No asset ${handle} here.` })),
});
