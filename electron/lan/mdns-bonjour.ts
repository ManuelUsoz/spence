import { Bonjour, type Service } from 'bonjour-service';
import { Effect, Layer, Queue, Schema, Stream } from 'effect';
import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import { DEVICE_NAME_MAX, DeviceId } from '../../src/shared/devices/devices.rpc';
import { layerMdnsNone } from './mdns-fake';
import { Mdns, type MdnsResponder, SERVICE_TYPE, type SightingEvent } from './mdns';

/** The service metadata (TXT): what another Device announces, untrusted until its certificate proves it. */
const Txt = Schema.Struct({
  id: DeviceId,
  name: Schema.String,
  v: Schema.NumberFromString.pipe(Schema.check(Schema.isInt())),
});
const decodeTxt = Schema.decodeUnknownOption(Txt);

const isIpv4 = (address: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address);

/** Where to reach an announced service: IPv4 first (the packet's sender, then its A records), else IPv6. */
const hostOf = (service: Service): string | undefined => {
  const candidates = [service.referer?.address, ...(service.addresses ?? [])].filter(
    (address): address is string => address !== undefined && address !== '',
  );
  const host = candidates.find(isIpv4) ?? candidates[0];
  return host === undefined ? undefined : host.includes(':') ? `[${host}]` : host;
};

/** A browsed service as a sighting; `undefined` for anything that is not a well-formed Spence announcement. */
export const sightingOf = (service: Service): SightingEvent | undefined => {
  const txt = decodeTxt(service.txt);
  const host = hostOf(service);
  if (txt._tag === 'None' || host === undefined) return undefined;
  return {
    _tag: 'Up',
    device: {
      id: txt.value.id,
      name: txt.value.name.slice(0, DEVICE_NAME_MAX),
      address: `${host}:${service.port}`,
      protocolVersion: txt.value.v,
    },
  };
};

/** The multicast socket under a responder (not public in `bonjour-service`), to catch its errors. */
const socketOf = (bonjour: Bonjour): EventEmitter | undefined => {
  const server: unknown = Reflect.get(bonjour, 'server');
  const mdns: unknown =
    typeof server === 'object' && server !== null ? Reflect.get(server, 'mdns') : undefined;
  return mdns instanceof EventEmitter ? mdns : undefined;
};

const open = Effect.acquireRelease(
  Effect.gen(function* () {
    const errors = yield* Queue.unbounded<unknown>();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(Queue.take(errors), (error) =>
          Effect.logWarning(
            'mDNS failed; nearby discovery may not work until the network changes.',
            error,
          ),
        ),
      ),
    );
    const warn = (error: unknown) => {
      Queue.offerUnsafe(errors, error);
    };
    // multicast-dns reuses the address by default, so another mDNS responder on this machine keeps working.
    const bonjour = new Bonjour({}, warn);
    // An unhandled socket error (EACCES, EADDRINUSE) would crash main: it is logged instead.
    socketOf(bonjour)?.on('error', warn);
    return bonjour;
  }),
  (bonjour) => Effect.callback<void>((resume) => bonjour.destroy(() => resume(Effect.void))),
).pipe(
  Effect.map((bonjour): MdnsResponder => ({
    announce: (announcement) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          bonjour.publish({
            name: `Spence ${announcement.id}`,
            type: SERVICE_TYPE,
            protocol: 'tcp',
            port: announcement.port,
            txt: {
              id: announcement.id,
              name: announcement.name,
              v: String(announcement.protocolVersion),
            },
          }),
        ),
        (service) =>
          Effect.callback<void>((resume) => {
            service.stop(() => resume(Effect.void));
          }),
      ).pipe(Effect.asVoid),
    browse: Stream.callback<SightingEvent>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const browser = bonjour.find({ type: SERVICE_TYPE, protocol: 'tcp' });
          const seen = (service: Service) => {
            const event = sightingOf(service);
            if (event !== undefined) Queue.offerUnsafe(queue, event);
          };
          browser.on('up', seen);
          browser.on('srv-update', seen);
          browser.on('txt-update', seen);
          browser.on('down', (service) => {
            const event = sightingOf(service);
            if (event?._tag === 'Up')
              Queue.offerUnsafe(queue, { _tag: 'Down', id: event.device.id });
          });
          return browser;
        }),
        (browser) => Effect.sync(() => browser.stop()),
      ),
    ),
  })),
);

/** The external addresses of this machine, as one comparable string. */
const interfacesNow = (): string =>
  Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) =>
      (addresses ?? [])
        .filter((address) => !address.internal)
        .map((address) => `${name}/${address.address}`),
    )
    .sort()
    .join(',');

/** Polled: Node has no interface-change event. Cheap, and only the change matters. */
const networkChanges = Stream.tick('5 seconds').pipe(
  Stream.map(interfacesNow),
  Stream.changes,
  Stream.drop(1),
  Stream.map(() => undefined),
);

/** Real multicast over `bonjour-service`, except under e2e, which pairs by typed address and never multicasts. */
export const layerMdnsLive: Layer.Layer<Mdns> =
  process.env['SPENCE_E2E'] === '1' ? layerMdnsNone : Layer.succeed(Mdns, { open, networkChanges });
