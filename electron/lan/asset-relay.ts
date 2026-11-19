import { Effect, Layer, Option, Stream } from 'effect';
import type { Rpc, RpcGroup } from 'effect/rpc';
import { type AssetHandle, AssetsError } from '../../src/shared/assets/assets.rpc';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import { DeviceScopedRpcs } from '../../src/shared/rpc/remote-rpcs';
import type { SessionId, SessionStreamItem } from '../../src/shared/sessions/sessions.rpc';
import { assetRefsOf, streamOfResult } from './assets';
import { targetDevice } from './router';

/** Where a handle was sent: the `index`-th asset of the Message at `seq` of a Session. */
interface Locator {
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly index: number;
}

/** How many handles per Device are remembered; the oldest are forgotten first. */
const MAX_LOCATORS = 4_096;

type Rpcs = RpcGroup.Rpcs<typeof DeviceScopedRpcs>;
type Handlers = Rpc.ToHandler<Rpcs>;

type Options = {
  readonly headers: Parameters<typeof targetDevice>[0];
} & Record<string, unknown>;
type EventsHandler = (
  payload: { readonly sessionId: SessionId; readonly afterSeq?: number },
  options: Options,
) => Stream.Stream<SessionStreamItem, unknown>;
type ReadHandler = (
  payload: { readonly handle: AssetHandle },
  options: Options,
) => Effect.Effect<{ readonly data: string }, { readonly _tag: string }>;

/**
 * The viewer's side of Remote assets, over the routed handlers. Handles belong to one connection, so after a
 * reconnect every handle a window already holds is `NotFound` on the host. This remembers where each handle of a
 * Remote Session's Transcript was sent; when the host no longer knows one, the Message is read again on the new
 * connection and the fresh handle is used instead, so a placeholder retried on reconnect shows its asset. Nothing is
 * kept but locations; the bytes are never stored here.
 */
export const relayRemoteAssets = <E, R>(routed: Layer.Layer<Handlers, E, R>) =>
  DeviceScopedRpcs.toLayer(
    Effect.gen(function* () {
      const handlers: Record<string, unknown> = {};
      for (const tag of DeviceScopedRpcs.requests.keys()) {
        handlers[tag] = yield* DeviceScopedRpcs.accessHandler(tag as Rpc.Tag<Rpcs>);
      }
      // The routed handlers of these two tags, typed by what this relay does with them.
      const events = handlers['Session.events'] as (
        ...args: Parameters<EventsHandler>
      ) => Parameters<typeof streamOfResult<SessionStreamItem, unknown>>[0];
      const read = handlers['Assets.read'] as ReadHandler;

      const located = new Map<DeviceId, Map<AssetHandle, Locator>>();
      /** Handles that were replaced by a fresh one on a newer connection. */
      const replaced = new Map<DeviceId, Map<AssetHandle, AssetHandle>>();
      const remember = <V>(
        maps: Map<DeviceId, Map<AssetHandle, V>>,
        device: DeviceId,
        handle: AssetHandle,
        value: V,
      ) => {
        const known = maps.get(device) ?? new Map<AssetHandle, V>();
        maps.set(device, known);
        known.delete(handle);
        known.set(handle, value);
        if (known.size > MAX_LOCATORS) {
          const oldest = known.keys().next();
          if (oldest.done !== true) known.delete(oldest.value);
        }
      };

      const record = (device: DeviceId, sessionId: SessionId, item: SessionStreamItem) => {
        if (item._tag !== 'Transcript' || item.event.item._tag !== 'Message') return;
        const { seq } = item.event;
        assetRefsOf(item.event.item.parts).forEach((ref, index) => {
          if (ref.handle !== undefined) {
            remember(located, device, ref.handle, { sessionId, seq, index });
          }
        });
      };

      const followEvents: EventsHandler = (payload, options) => {
        const device = targetDevice(options.headers);
        const items = streamOfResult(events(payload, options));
        return device === undefined
          ? items
          : Stream.tap(items, (item) => Effect.sync(() => record(device, payload.sessionId, item)));
      };

      /** The handle the asset at `locator` has on the connection now, read again through `options`. */
      const relocate = (locator: Locator, options: Options) =>
        streamOfResult(
          events({ sessionId: locator.sessionId, afterSeq: locator.seq - 1 }, options),
        ).pipe(
          Stream.filter((item) => item._tag === 'Transcript' && item.event.seq >= locator.seq),
          Stream.runHead,
          Effect.map((head) =>
            Option.flatMap(head, (item) =>
              item._tag === 'Transcript' &&
              item.event.seq === locator.seq &&
              item.event.item._tag === 'Message'
                ? Option.fromNullishOr(assetRefsOf(item.event.item.parts)[locator.index]?.handle)
                : Option.none(),
            ),
          ),
        );

      const readAsset: ReadHandler = (payload, options) => {
        const device = targetDevice(options.headers);
        if (device === undefined) return read(payload, options);
        const current = replaced.get(device)?.get(payload.handle) ?? payload.handle;
        return read({ handle: current }, options).pipe(
          Effect.catchIf(
            (error) => error._tag === 'AssetsError',
            Effect.fnUntraced(function* (notFound) {
              const locator = located.get(device)?.get(current);
              if (locator === undefined) return yield* Effect.fail(notFound);
              const fresh = yield* relocate(locator, options).pipe(Effect.orDie);
              if (Option.isNone(fresh) || fresh.value === current) {
                return yield* Effect.fail(notFound);
              }
              remember(located, device, fresh.value, locator);
              remember(replaced, device, payload.handle, fresh.value);
              return yield* read({ handle: fresh.value }, options);
            }),
          ),
          // The router makes a Device that is not connected a defect, which would end every call of the window's
          // connection; an asset that cannot be fetched now is only a placeholder, retried on reconnect.
          Effect.catchDefect(() =>
            Effect.fail(
              new AssetsError({
                reason: 'Unavailable',
                detail: `Device ${device} is not connected.`,
              }),
            ),
          ),
        );
      };

      handlers['Session.events'] = followEvents;
      handlers['Assets.read'] = readAsset;
      // One handler per tag, built from the group at run time, so the handlers' type is asserted.
      return handlers as unknown as RpcGroup.HandlersFrom<Rpcs>;
    }),
  ).pipe(Layer.provide(routed)) as Layer.Layer<Handlers, E, R>;
