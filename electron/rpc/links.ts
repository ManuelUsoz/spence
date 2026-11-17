import { shell } from 'electron';
import { Effect } from 'effect';
import { isAllowedExternalUrl } from '../../src/shared/links/link-policy';
import { LinkError, LinksRpcs } from '../../src/shared/links/links.rpc';

/**
 * The one privileged door to the browser. The renderer only asks for destinations it already validated; main
 * validates again and rejects everything that is not an absolute HTTPS URL without credentials.
 */
export const openExternal = (url: string): Effect.Effect<void, LinkError> =>
  isAllowedExternalUrl(url)
    ? Effect.tryPromise({
        try: () => shell.openExternal(url),
        catch: (cause) =>
          new LinkError({
            reason: 'OpenFailed',
            detail: `Could not open the link: ${String(cause)}`,
          }),
      })
    : Effect.fail(
        new LinkError({
          reason: 'Rejected',
          detail: 'Only absolute HTTPS links without credentials open.',
        }),
      );

export const layerLinksHandlers = LinksRpcs.toLayer({
  'Links.openExternal': ({ url }) => openExternal(url),
});
