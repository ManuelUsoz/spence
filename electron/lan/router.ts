import { Effect, Layer, Predicate, Stream } from 'effect';
import { type Headers } from 'effect/http';
import { type Rpc, RpcSchema, type RpcGroup } from 'effect/rpc';
import { DEVICE_SCOPE_HEADER, DeviceId } from '../../src/shared/devices/devices.rpc';
import { DeviceConnections, type RemoteClient } from './connections';

/** The Device a call names in `DEVICE_SCOPE_HEADER`; none for the Local device. */
export const targetDevice = (headers: Headers.Headers): DeviceId | undefined => {
  const value = headers[DEVICE_SCOPE_HEADER];
  return value === undefined || value === '' ? undefined : DeviceId.make(value);
};

/** A Device that is not connected, or the connection failing: nothing the window can act on. */
const isTransportFailure = (error: unknown): boolean =>
  Predicate.isTagged(error, 'RpcClientError') || Predicate.isTagged(error, 'DeviceUnavailable');

/** A Remote call failing for a transport reason: nothing the window can act on, so a defect. */
const dieOnTransport = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.catchIf(effect, isTransportFailure, (error) => Effect.die(error));

type AnyCall = (
  payload: unknown,
) => Effect.Effect<unknown, unknown> | Stream.Stream<unknown, unknown>;

/** The client method for `tag`, called with a decoded payload (the client encodes it again). */
const callOf = (client: RemoteClient, tag: string): AnyCall =>
  // The client is keyed by every tag of `RemoteRpcs`; this router only ever asks for tags of that group.
  (client as unknown as Readonly<Record<string, AnyCall>>)[tag] ??
  (() => Effect.die(`${tag} is not served to Paired devices`));

/**
 * Routes every RPC of `group` (a subset of `RemoteRpcs`) by `DEVICE_SCOPE_HEADER`: no header runs the `local` handler
 * as before; a Device id forwards the call, its payload unchanged, to that Remote device's connection. Contract errors
 * come back as they are; a Device that is not connected, or a transport failure, is a defect. Only the window's
 * server is built with it: the LAN server serves the local handlers, so a Remote device never relays to a third.
 */
export const routeToDevices =
  <Rpcs extends Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>) =>
  <E, R>(
    local: Layer.Layer<Rpc.ToHandler<Rpcs>, E, R>,
  ): Layer.Layer<Rpc.ToHandler<Rpcs>, E, R | DeviceConnections> =>
    group
      .toLayer(
        Effect.gen(function* () {
          const connections = yield* DeviceConnections;
          const handlers: Record<string, unknown> = {};
          for (const [tag, rpc] of group.requests) {
            const handleLocally = yield* group.accessHandler(tag as Rpc.Tag<Rpcs>);
            const remote = (device: DeviceId, payload: unknown) =>
              Effect.map(connections.client(device), (client) => callOf(client, tag)(payload));
            handlers[tag] = RpcSchema.isStreamSchema(
              (rpc as unknown as Rpc.AnyWithProps).successSchema,
            )
              ? (payload: unknown, options: Parameters<typeof handleLocally>[1]) => {
                  const device = targetDevice(options.headers);
                  if (device === undefined) return handleLocally(payload as never, options);
                  return Stream.unwrap(
                    dieOnTransport(
                      remote(device, payload) as Effect.Effect<
                        Stream.Stream<unknown, unknown>,
                        unknown
                      >,
                    ),
                  ).pipe(Stream.catchIf(isTransportFailure, (error) => Stream.die(error)));
                }
              : (payload: unknown, options: Parameters<typeof handleLocally>[1]) => {
                  const device = targetDevice(options.headers);
                  if (device === undefined) return handleLocally(payload as never, options);
                  return dieOnTransport(
                    Effect.flatten(
                      remote(device, payload) as Effect.Effect<
                        Effect.Effect<unknown, unknown>,
                        unknown
                      >,
                    ),
                  );
                };
          }
          // One handler per tag, built from the group at run time, so the handlers' type is asserted.
          return handlers as unknown as RpcGroup.HandlersFrom<Rpcs>;
        }),
      )
      .pipe(Layer.provide(local)) as Layer.Layer<Rpc.ToHandler<Rpcs>, E, R | DeviceConnections>;
