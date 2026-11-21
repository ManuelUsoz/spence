import { Cause, Effect, Layer, Predicate, Result, Stream } from 'effect';
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

/** Session streams the router keeps open across a dropped connection, re-subscribing when the Device is back. */
const RESUMED_STREAMS: ReadonlySet<string> = new Set(['Session.events', 'Session.changes']);

/** A stream ended by losing the connection (the client failing, or closing under it), not by its contract. */
const lostConnection = (cause: Cause.Cause<unknown>): boolean => {
  if (Cause.hasInterruptsOnly(cause)) return true;
  const error = Cause.findError(cause);
  return (
    Result.isSuccess(error) &&
    Predicate.isTagged(error.success, 'RpcClientError') &&
    !Cause.hasDies(cause)
  );
};

/** `Session.events` items carry a Transcript `seq`; others none. */
const seqOf = (item: unknown): number | undefined =>
  Predicate.isTagged(item, 'Transcript') &&
  Predicate.hasProperty(item, 'event') &&
  Predicate.hasProperty(item.event, 'seq') &&
  typeof item.event.seq === 'number'
    ? item.event.seq
    : undefined;

/**
 * A Session stream on a Remote device as one continuous stream: while the Device is not connected it waits, and
 * when the connection drops it subscribes again once the Device is back. `Session.events` resumes after the last
 * `seq` it passed on, so no Transcript event is missed or repeated. Contract errors end it as they are; a Device
 * that is no longer paired ends it as a defect.
 */
const resumedStream = (
  connections: DeviceConnections['Service'],
  device: DeviceId,
  tag: string,
  payload: unknown,
): Stream.Stream<unknown, unknown> => {
  const events = tag === 'Session.events';
  let lastSeq: number | undefined =
    events && Predicate.hasProperty(payload, 'afterSeq') && typeof payload.afterSeq === 'number'
      ? payload.afterSeq
      : undefined;
  let stale: RemoteClient | undefined;
  const subscribe = (): Stream.Stream<unknown, unknown> =>
    Stream.unwrap(
      connections.awaitClient(device, stale).pipe(
        Effect.catchTag('DeviceUnavailable', (error) => Effect.die(error)),
        Effect.map((client) => {
          stale = client;
          const resumed =
            events && lastSeq !== undefined && Predicate.isObject(payload)
              ? { ...payload, afterSeq: lastSeq }
              : payload;
          return callOf(client, tag)(resumed) as Stream.Stream<unknown, unknown>;
        }),
      ),
    ).pipe(
      Stream.filter((item) => {
        const seq = seqOf(item);
        if (seq === undefined) return true;
        if (lastSeq !== undefined && seq <= lastSeq) return false;
        lastSeq = seq;
        return true;
      }),
      Stream.catchCause((cause) =>
        lostConnection(cause) ? Stream.suspend(subscribe) : Stream.failCause(cause),
      ),
    );
  return Stream.suspend(subscribe);
};

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
 * come back as they are; a Device that is not connected, or a transport failure, is a defect, except for the
 * Session streams, which wait for the Device and resume (`resumedStream`). Only the window's
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
                  if (RESUMED_STREAMS.has(tag)) {
                    return resumedStream(connections, device, tag, payload);
                  }
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
