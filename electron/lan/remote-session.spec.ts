/**
 * Using a Remote Session: two in-process Devices over real loopback `wss://`, the host serving real Projects and
 * Sessions with the fake Agent, the viewer calling them as its window would (`DeviceScopedRpcs` through the
 * production router, the Device named in the `DEVICE_SCOPE_HEADER`).
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer, Option, Stream } from 'effect';
import { RpcClient } from 'effect/rpc';
import { DEVICE_SCOPE_HEADER, type DeviceId } from '../../src/shared/devices/devices.rpc';
import type { SessionId, SessionStreamItem } from '../../src/shared/sessions/sessions.rpc';
import { fakeEntry, installFakeAgent } from '../acp/acpFakes';
import { AgentLifetime } from '../acp/acpLifetime';
import { makeTestDevice, pairDevices, tempDataDir, type TestDevice } from '../devices/test-peer';
import { layerProjectsHandlersWith } from '../rpc/projects';
import { layerSessionsHandlersWith } from '../rpc/sessions';
import { Projects } from '../projects/projects';
import { AgentCatalog, makeAgentCatalog } from '../sessions/session-agent';
import { Sessions } from '../sessions/sessions';
import { layerSessionsWithFakeAgent } from '../sessions/sessions-fakes';

/** Spawning the fake Agent and a real ACP handshake take longer than the default on a cold machine. */
const TIMEOUT = 60_000;

const PROJECT_FOLDER = process.cwd();

/** Runs a call as the window does for a Remote Session: naming the Device it is for. */
const onDevice =
  (device: DeviceId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    RpcClient.withHeaders(effect, { [DEVICE_SCOPE_HEADER]: device });

/** A Device whose own Projects and Sessions are real, over its own Store, with the fake Agent. */
const makeDeviceWithSessions = Effect.gen(function* () {
  const root = yield* tempDataDir;
  const install = yield* installFakeAgent;
  const sessions = yield* Layer.build(
    layerSessionsWithFakeAgent({ root, install, projectFolder: PROJECT_FOLDER }).pipe(
      Layer.provideMerge(Layer.succeed(AgentCatalog, makeAgentCatalog([fakeEntry()]))),
    ),
  );
  const serve = Layer.merge(layerSessionsHandlersWith, layerProjectsHandlersWith).pipe(
    Layer.provide(Layer.succeedContext(sessions)),
  );
  const device = yield* makeTestDevice({ serve });
  const run = <A, E>(effect: Effect.Effect<A, E, Sessions | Projects | AgentLifetime>) =>
    Effect.provide(effect, sessions);
  return { device, run };
});

/** Pairs the two and waits until the viewer is connected to the host. */
const connected = Effect.fnUntraced(function* (host: TestDevice, viewer: TestDevice) {
  yield* pairDevices(host, viewer);
  const hostId = (yield* host.identity).id;
  yield* viewer.awaitConnection(hostId, 'Online');
  return hostId;
});

const transcriptUntilTurnEnds = <E, R>(stream: Stream.Stream<SessionStreamItem, E, R>) =>
  stream.pipe(
    Stream.takeUntil((item) => item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded'),
    Stream.runCollect,
  );

const agentText = (items: ReadonlyArray<SessionStreamItem>): string =>
  items
    .flatMap((item) => {
      if (item._tag !== 'Transcript') return [];
      const event = item.event.item;
      if (event._tag === 'Message' && event.role === 'agent') {
        return event.parts.flatMap((part) => (part._tag === 'text' ? [part.text] : []));
      }
      if (event._tag === 'MessageDelta') return [event.text];
      return [];
    })
    .join('');

describe('Remote Sessions', () => {
  it.live(
    'a viewer connects to its Paired devices and sees them Online',
    () =>
      Effect.gen(function* () {
        const host = yield* makeTestDevice();
        const viewer = yield* makeTestDevice();
        const hostId = yield* connected(host, viewer);
        const hostName = (yield* host.identity).name;

        const connections = yield* viewer.connections;
        expect(connections).toEqual([
          { id: hostId, name: hostName, status: { _tag: 'Online', name: hostName } },
        ]);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'unpairing closes the connection and drops the Device',
    () =>
      Effect.gen(function* () {
        const host = yield* makeTestDevice();
        const viewer = yield* makeTestDevice();
        const hostId = yield* connected(host, viewer);

        yield* viewer.unpair(hostId);

        expect(yield* viewer.connections).toEqual([]);
        const exit = yield* Effect.exit(onDevice(hostId)(viewer.desktop['Projects.list']()));
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    "a call naming a Remote device reaches that Device's Projects; one naming none stays Local",
    () =>
      Effect.gen(function* () {
        const host = yield* makeDeviceWithSessions;
        const viewer = yield* makeDeviceWithSessions;
        const hostId = yield* connected(host.device, viewer.device);
        const hosted = yield* host.run(Projects.use((projects) => projects.add));
        if (hosted === null) return yield* Effect.die('no Project');

        const remote = yield* onDevice(hostId)(viewer.device.desktop['Projects.list']());
        const local = yield* viewer.device.desktop['Projects.list']();

        expect(remote.map((project) => project.id)).toEqual([hosted.id]);
        expect(local).toEqual([]);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a Remote Session runs end to end: create, prompt, and the Turn streams back',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDeviceWithSessions;
        const viewer = yield* makeDeviceWithSessions;
        const hostId = yield* connected(host.device, viewer.device);
        const hosted = yield* host.run(Projects.use((projects) => projects.add));
        if (hosted === null) return yield* Effect.die('no Project');
        const api = viewer.device.desktop;
        const remote = onDevice(hostId);

        const sessionId = yield* remote(api['Session.create']({ projectId: hosted.id }));
        yield* remote(
          api['Session.prompt']({ sessionId, parts: [{ _tag: 'text', text: 'echo:hello there' }] }),
        );
        const items = yield* remote(transcriptUntilTurnEnds(api['Session.events']({ sessionId })));

        expect(agentText(items)).toBe('hello there');
        const listed = yield* remote(api['Session.list']({ projectId: hosted.id }));
        expect(listed.map((session) => session.id)).toEqual([sessionId]);
        // The Session lives on the host only.
        expect(yield* api['Projects.list']()).toEqual([]);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a Turn started from a viewer finishes on the host after the viewer quits',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDeviceWithSessions;
        const hosted = yield* host.run(Projects.use((projects) => projects.add));
        if (hosted === null) return yield* Effect.die('no Project');

        // The viewer starts a Turn, then quits (its scope closes) without waiting for it.
        const sessionId = yield* Effect.gen(function* () {
          const viewer = yield* makeDeviceWithSessions;
          const remote = onDevice(yield* connected(host.device, viewer.device));
          const api = viewer.device.desktop;
          const id = yield* remote(api['Session.create']({ projectId: hosted.id }));
          yield* remote(
            api['Session.prompt']({
              sessionId: id,
              parts: [{ _tag: 'text', text: 'echo:still here' }],
            }),
          );
          return id;
        }).pipe(Effect.scoped);

        const items = yield* host.run(
          transcriptUntilTurnEnds(
            Stream.unwrap(Sessions.use((sessions) => Effect.succeed(sessions.events(sessionId)))),
          ),
        );
        const ended = items.flatMap((item) =>
          item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded'
            ? [item.event.item.outcome._tag]
            : [],
        );
        expect(ended).toEqual(['done']);
        expect(agentText(items)).toBe('still here');
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    "the viewer's quit confirmation counts its Local Turns only",
    () =>
      Effect.gen(function* () {
        const host = yield* makeDeviceWithSessions;
        const viewer = yield* makeDeviceWithSessions;
        const remote = onDevice(yield* connected(host.device, viewer.device));
        const hosted = yield* host.run(Projects.use((projects) => projects.add));
        if (hosted === null) return yield* Effect.die('no Project');
        const api = viewer.device.desktop;
        const sessionId = yield* remote(api['Session.create']({ projectId: hosted.id }));
        yield* remote(
          api['Session.prompt']({ sessionId, parts: [{ _tag: 'text', text: 'hold' }] }),
        );

        expect(yield* host.run(runningTurnOf(sessionId))).toBe(true);
        expect(yield* host.run(AgentLifetime.use((lifetime) => lifetime.working))).toBe(1);
        expect(yield* viewer.run(AgentLifetime.use((lifetime) => lifetime.working))).toBe(0);

        yield* remote(api['Session.cancel']({ sessionId }));
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});

/** Whether the host still runs a Turn in the Session. */
const runningTurnOf = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const head = yield* Stream.runHead(sessions.events(sessionId, Number.MAX_SAFE_INTEGER));
    return Option.isSome(head) && head.value._tag === 'Live'
      ? head.value.state.runningTurn !== undefined
      : false;
  });
