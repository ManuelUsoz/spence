/**
 * Offline, reconnect and resume: two in-process Devices over real loopback `wss://`, the viewer reaching the host
 * through a relay that drops and partitions the network (`makeTestLink`). The window's calls go through the
 * production router, as in `remote-session.spec.ts`.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Queue, Stream } from 'effect';
import { RpcClient } from 'effect/rpc';
import { DEVICE_SCOPE_HEADER, type DeviceId } from '../../src/shared/devices/devices.rpc';
import type { SessionId, SessionStreamItem } from '../../src/shared/sessions/sessions.rpc';
import { fakeEntry, installFakeAgent } from '../acp/acpFakes';
import {
  makeTestDevice,
  makeTestLink,
  pairDevices,
  tempDataDir,
  type TestDevice,
  type TestDeviceOptions,
  type TestLink,
} from '../devices/test-peer';
import { Projects } from '../projects/projects';
import { layerProjectsHandlersWith } from '../rpc/projects';
import { layerSessionsHandlersWith } from '../rpc/sessions';
import { AgentCatalog, makeAgentCatalog } from '../sessions/session-agent';
import { Sessions } from '../sessions/sessions';
import { layerSessionsWithFakeAgent } from '../sessions/sessions-fakes';
import { makeFakeLan } from './mdns-fake';
import { makePowerEventsTest } from './power';

const TIMEOUT = 60_000;

const onDevice =
  (device: DeviceId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    RpcClient.withHeaders(effect, { [DEVICE_SCOPE_HEADER]: device });

/** Pairs the viewer with the host through `link` and waits until it is connected. */
const connectedThrough = Effect.fnUntraced(function* (
  host: TestDevice,
  viewer: TestDevice,
  link: TestLink,
) {
  yield* pairDevices(host, viewer, link.address);
  const hostId = (yield* host.identity).id;
  yield* viewer.awaitConnection(hostId, 'Online');
  return hostId;
});

/** A host with real Projects and Sessions (the fake Agent), reached through a link. */
const makeHostWithSessions = Effect.gen(function* () {
  const root = yield* tempDataDir;
  const install = yield* installFakeAgent;
  const sessions = yield* Layer.build(
    layerSessionsWithFakeAgent({ root, install, projectFolder: process.cwd() }).pipe(
      Layer.provideMerge(Layer.succeed(AgentCatalog, makeAgentCatalog([fakeEntry()]))),
    ),
  );
  const serve = Layer.merge(layerSessionsHandlersWith, layerProjectsHandlersWith).pipe(
    Layer.provide(Layer.succeedContext(sessions)),
  );
  const device = yield* makeTestDevice({ serve });
  const run = <A, E>(effect: Effect.Effect<A, E, Sessions | Projects>) =>
    Effect.provide(effect, sessions);
  return { device, run };
});

const transcriptSeqs = (items: ReadonlyArray<SessionStreamItem>): ReadonlyArray<number> =>
  items.flatMap((item) => (item._tag === 'Transcript' ? [item.event.seq] : []));

const turnsEnded = (items: ReadonlyArray<SessionStreamItem>): number =>
  items.filter((item) => item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded').length;

describe('Offline, reconnect and resume', () => {
  it.live(
    'a partitioned host shows Reconnecting, and is Online again once the network heals',
    () =>
      Effect.gen(function* () {
        const host = yield* makeTestDevice();
        const viewer = yield* makeTestDevice();
        const link = yield* makeTestLink(host);
        const hostId = yield* connectedThrough(host, viewer, link);

        yield* link.partition;
        yield* viewer.awaitConnection(hostId, 'Reconnecting');
        yield* link.heal;

        yield* viewer.awaitConnection(hostId, 'Online');
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  const offlineThenWoken = (
    wake: (
      lan: { readonly changeNetwork: Effect.Effect<void> },
      resume: Effect.Effect<void>,
    ) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const lan = yield* makeFakeLan;
      const power = yield* makePowerEventsTest;
      const options: TestDeviceOptions = {
        lan,
        power: power.layer,
        reconnectingFor: '1 second',
      };
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice(options);
      const link = yield* makeTestLink(host);
      const hostId = yield* connectedThrough(host, viewer, link);

      yield* link.partition;
      yield* viewer.awaitConnection(hostId, 'Offline');
      // Offline, it is tried only every 30 s: anything sooner is the wake-up.
      yield* link.heal;
      yield* wake(lan, power.resume);

      yield* viewer.awaitConnection(hostId, 'Online').pipe(Effect.timeout('10 seconds'));
    }).pipe(Effect.scoped);

  it.live(
    'after a while it shows Offline; a network change reaches it again at once',
    () => offlineThenWoken((lan) => lan.changeNetwork),
    TIMEOUT,
  );

  it.live(
    'after a while it shows Offline; waking the computer reaches it again at once',
    () => offlineThenWoken((_lan, resume) => resume),
    TIMEOUT,
  );

  it.live(
    'Retry reaches an Offline Device at once',
    () =>
      Effect.gen(function* () {
        const host = yield* makeTestDevice();
        const viewer = yield* makeTestDevice({ reconnectingFor: '1 second' });
        const link = yield* makeTestLink(host);
        const hostId = yield* connectedThrough(host, viewer, link);

        yield* link.partition;
        yield* viewer.awaitConnection(hostId, 'Offline');
        yield* link.heal;
        yield* viewer.connect(hostId).pipe(Effect.timeout('10 seconds'));

        expect((yield* viewer.connections)[0]?.status._tag).toBe('Online');
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a host that stops hosting while its Session is followed shows Reconnecting',
    () =>
      Effect.gen(function* () {
        const host = yield* makeHostWithSessions;
        const viewer = yield* makeTestDevice();
        yield* pairDevices(host.device, viewer);
        const hostId = (yield* host.device.identity).id;
        yield* viewer.awaitConnection(hostId, 'Online');
        const hosted = yield* host.run(Projects.use((projects) => projects.add));
        if (hosted === null) return yield* Effect.die('no Project');
        const remote = onDevice(hostId);
        const api = viewer.desktop;
        const sessionId = yield* remote(api['Session.create']({ projectId: hosted.id }));
        yield* api['Session.events']({ sessionId }).pipe(Stream.runDrain, remote, Effect.forkChild);
        yield* api['Session.changes']().pipe(Stream.runDrain, remote, Effect.forkChild);
        yield* remote(
          api['Session.prompt']({ sessionId, parts: [{ _tag: 'text', text: 'echo:hi' }] }),
        );

        yield* host.device.setHosting(false);

        yield* viewer.awaitConnection(hostId, 'Reconnecting').pipe(Effect.timeout('10 seconds'));
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    "a Remote Session's events resume after a drop and a partition, without gaps or duplicates",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHostWithSessions;
        const viewer = yield* makeTestDevice();
        const link = yield* makeTestLink(host.device);
        const hostId = yield* connectedThrough(host.device, viewer, link);
        const hosted = yield* host.run(Projects.use((projects) => projects.add));
        if (hosted === null) return yield* Effect.die('no Project');
        const api = viewer.desktop;
        const remote = onDevice(hostId);
        const sessionId: SessionId = yield* remote(api['Session.create']({ projectId: hosted.id }));
        const prompt = (text: string) =>
          host.run(
            Sessions.use((sessions) =>
              sessions.prompt(sessionId, [{ _tag: 'text', text: `echo:${text}` }]),
            ),
          );

        // The window follows the Session through the router, as one stream for the whole test.
        const seen: Array<SessionStreamItem> = [];
        const arrived = yield* Queue.unbounded<void>();
        const follower = yield* api['Session.events']({ sessionId }).pipe(
          Stream.runForEach((item) =>
            Effect.andThen(
              Effect.sync(() => seen.push(item)),
              Queue.offer(arrived, undefined),
            ),
          ),
          remote,
          Effect.forkChild,
        );
        const untilTurns = (count: number) =>
          Effect.whileLoop({
            while: () => turnsEnded(seen) < count,
            body: () => Queue.take(arrived),
            step: () => undefined,
          });

        yield* prompt('one');
        yield* untilTurns(1);

        // A drop: the connection goes, the network stays.
        yield* link.dropConnection;
        yield* prompt('two');
        yield* untilTurns(2);

        // A partition: a Turn runs and ends on the host while the viewer cannot reach it.
        yield* link.partition;
        yield* viewer.awaitConnection(hostId, 'Reconnecting');
        yield* prompt('three');
        yield* host.run(hostTranscript(sessionId, 3));
        yield* link.heal;
        yield* untilTurns(3);

        yield* Fiber.interrupt(follower);
        const seqs = transcriptSeqs(seen);
        const hostSeqs = transcriptSeqs(yield* host.run(hostTranscript(sessionId, 3)));
        expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
        for (const seq of hostSeqs) expect(seqs).toContain(seq);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});

/** The host's own Transcript of the Session up to its `count`-th ended Turn. */
const hostTranscript = (sessionId: SessionId, count: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    let ended = 0;
    const items = yield* sessions.events(sessionId).pipe(
      Stream.takeUntil((item) => {
        if (item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded') ended += 1;
        return ended >= count;
      }),
      Stream.runCollect,
    );
    return items;
  });
