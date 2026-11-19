/**
 * Two in-process Devices for Cross-device message specs: each with real Projects, Sessions and Inbox over its own
 * Store, the fake Agent, and the production LAN (`test-peer.ts`).
 */
import { Effect, Layer, Stream } from 'effect';
import type { Message, SessionId, SessionStreamItem } from '../../src/shared/sessions/sessions.rpc';
import { fakeEntry, installFakeAgent } from '../acp/acpFakes';
import { makeTestDevice, pairDevices, tempDataDir, type TestDevice } from '../devices/test-peer';
import { Projects } from '../projects/projects';
import { layerProjectsHandlersWith } from '../rpc/projects';
import { layerSessionsHandlersWith } from '../rpc/sessions';
import { AgentCatalog, makeAgentCatalog } from '../sessions/session-agent';
import { Sessions } from '../sessions/sessions';
import type { Settings } from '../settings/settings';
import { layerSessionsWithFakeAgent } from '../sessions/sessions-fakes';
import { DeviceIdentity } from '../devices/identity';
import { DeviceConnections } from '../lan/connections';
import { attachAgentTools as attachAgentToolsLive } from './agent-tools';
import { layerInbox } from './inbox';

const PROJECT_FOLDER = process.cwd();

export const isTurnEnd = (item: SessionStreamItem) =>
  item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded';

/** The Session's Transcript up to its next settled Turn. */
export const untilTurnEnds = (sessionId: SessionId) =>
  Stream.unwrap(Sessions.use((s) => Effect.succeed(s.events(sessionId)))).pipe(
    Stream.takeUntil(isTurnEnd),
    Stream.runCollect,
  );

/** The Messages in a Session's Transcript, up to the end of its `turns`-th Turn. */
export const messagesUntil = (sessionId: SessionId, turns: number) =>
  Stream.unwrap(Sessions.use((s) => Effect.succeed(s.events(sessionId))))
    .pipe(
      Stream.mapAccum(
        () => 0,
        (ended, item) => {
          const next = isTurnEnd(item) ? ended + 1 : ended;
          return [next, [{ item, ended: next }]] as const;
        },
      ),
      Stream.takeUntil(({ ended }) => ended >= turns),
      Stream.map(({ item }) => item),
      Stream.runCollect,
    )
    .pipe(
      Effect.map((items) =>
        items.flatMap((item): ReadonlyArray<Message> =>
          item._tag === 'Transcript' && item.event.item._tag === 'Message' ? [item.event.item] : [],
        ),
      ),
    );

/** The user Messages in a Session's Transcript, up to the end of its `turns`-th Turn. */
export const userMessages = (sessionId: SessionId, turns: number) =>
  Effect.map(messagesUntil(sessionId, turns), (messages) =>
    messages.filter((message) => message.role === 'user'),
  );

export const textOf = (message: Message): string =>
  message.parts.flatMap((part) => (part._tag === 'text' ? [part.text] : [])).join('');

/** A Device with real Projects, Sessions and Inbox over its own Store, with the fake Agent. */
export const makeMessagingDevice = Effect.gen(function* () {
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
  const inbox = layerInbox.pipe(Layer.provide(Layer.succeedContext(sessions)));
  const device = yield* makeTestDevice({ serve, inbox });
  const run = <A, E>(effect: Effect.Effect<A, E, Sessions | Projects | Settings>) =>
    Effect.provide(effect, sessions);
  /** A Project of this Device with one Session that has run a Turn. */
  const sessionWithTurn = Effect.gen(function* () {
    const project = yield* run(Projects.use((projects) => projects.add));
    if (project === null) return yield* Effect.die('no Project');
    const sessionId = yield* run(Sessions.use((s) => s.create(project.id)));
    yield* run(Sessions.use((s) => s.prompt(sessionId, [{ _tag: 'text', text: 'echo:ready' }])));
    yield* run(untilTurnEnds(sessionId));
    return { project, sessionId };
  });
  /** Gives this Device's Agents the cross-device tools for the life of the scope, as main does at start. */
  const attachAgentTools = attachAgentToolsLive.pipe(
    Effect.provide(sessions),
    Effect.provideService(DeviceIdentity, device.deviceIdentity),
    Effect.provideService(DeviceConnections, device.deviceConnections),
  );
  return { device, run, sessionWithTurn, attachAgentTools };
});

export type MessagingDevice = Effect.Success<typeof makeMessagingDevice>;

/** Pairs the two and waits until the viewer is connected to the host. */
export const connected = Effect.fnUntraced(function* (host: TestDevice, viewer: TestDevice) {
  yield* pairDevices(host, viewer);
  const hostId = (yield* host.identity).id;
  yield* viewer.awaitConnection(hostId, 'Online');
  return hostId;
});
