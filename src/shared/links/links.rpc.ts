import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

/**
 * Opens a destination outside the app. The renderer only asks for destinations that passed `isAllowedExternalUrl`;
 * main validates again before handing the URL to the operating system.
 */
export class LinkError extends Schema.TaggedError<LinkError>()('LinkError', {
  reason: Schema.Literals(['Rejected', 'OpenFailed']),
  detail: Schema.String,
}) {}

export const LinksRpcs = RpcGroup.make(
  Rpc.make('Links.openExternal', {
    payload: { url: Schema.String },
    error: LinkError,
  }),
);
