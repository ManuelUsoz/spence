/**
 * Cross-device messages sent by a person: two in-process Devices over real loopback `wss://`, each with real Projects
 * and Sessions and the fake Agent. The viewer sends as its window does (`MessagingRpcs`); the host's Transcript shows
 * what arrived and with which Provenance.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Stream } from 'effect';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import type { SendingSession } from '../../src/shared/messaging/messaging.rpc';
import {
  type Message,
  SessionId,
  type SessionStreamItem,
} from '../../src/shared/sessions/sessions.rpc';
import { fakeEntry, installFakeAgent } from '../acp/acpFakes';
import { makeTestDevice, pairDevices, tempDataDir, type TestDevice } from '../devices/test-peer';
import { Projects } from '../projects/projects';
import { layerProjectsHandlersWith } from '../rpc/projects';
import { layerSessionsHandlersWith } from '../rpc/sessions';
import { AgentCatalog, makeAgentCatalog } from '../sessions/session-agent';
import { Sessions } from '../sessions/sessions';
import { layerSessionsWithFakeAgent } from '../sessions/sessions-fakes';
import { layerInbox } from './inbox';

const TIMEOUT = 60_000;

const PROJECT_FOLDER = process.cwd();

/** A Device with real Projects, Sessions and Inbox over its own Store, with the fake Agent. */
const makeDevice = Effect.gen(function* () {
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
  const run = <A, E>(effect: Effect.Effect<A, E, Sessions | Projects>) =>
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
  return { device, run, sessionWithTurn };
});

/** Pairs the two and waits until the viewer is connected to the host. */
const connected = Effect.fnUntraced(function* (host: TestDevice, viewer: TestDevice) {
  yield* pairDevices(host, viewer);
  const hostId = (yield* host.identity).id;
  yield* viewer.awaitConnection(hostId, 'Online');
  return hostId;
});

const isTurnEnd = (item: SessionStreamItem) =>
  item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded';

/** The Session's Transcript up to its next settled Turn. */
const untilTurnEnds = (sessionId: SessionId) =>
  Stream.unwrap(Sessions.use((s) => Effect.succeed(s.events(sessionId)))).pipe(
    Stream.takeUntil(isTurnEnd),
    Stream.runCollect,
  );

/** The user Messages in a Session's Transcript, up to the end of its `turns`-th Turn. */
const userMessages = (sessionId: SessionId, turns: number) =>
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
          item._tag === 'Transcript' &&
          item.event.item._tag === 'Message' &&
          item.event.item.role === 'user'
            ? [item.event.item]
            : [],
        ),
      ),
    );

const textOf = (message: Message): string =>
  message.parts.flatMap((part) => (part._tag === 'text' ? [part.text] : [])).join('');

const sender = (sessionId: SessionId, device?: DeviceId): SendingSession => ({
  ...(device === undefined ? {} : { device }),
  sessionId,
  title: 'Plan the release',
  projectName: 'spence',
});

describe('Cross-device messages from a person', () => {
  it.live(
    'a Message to a Session on another Device starts a Turn there and shows who sent it',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDevice;
        const viewer = yield* makeDevice;
        const hostId = yield* connected(host.device, viewer.device);
        const viewerSelf = yield* viewer.device.identity;
        const target = yield* host.sessionWithTurn;
        const from = SessionId.make('viewer-session');

        const delivery = yield* viewer.device.messaging['Messaging.send']({
          from: sender(from),
          device: hostId,
          sessionId: target.sessionId,
          text: 'echo:from the other room',
        });

        expect(delivery).toBe('started');
        const messages = yield* host.run(userMessages(target.sessionId, 2));
        const received = messages.at(-1);
        expect(received === undefined ? '' : textOf(received)).toBe('echo:from the other room');
        expect(received?.from).toEqual({
          sessionId: from,
          title: 'Plan the release',
          projectName: 'spence',
          hops: 0,
          device: { id: viewerSelf.id, name: viewerSelf.name },
          by: 'person',
        });
        // A person's own Message asks nobody for an answer on the receiving side.
        const [listed] = yield* host.run(Sessions.use((s) => s.list(target.project.id)));
        expect(listed?.attention).toBeUndefined();
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a busy Session queues a person’s Message instead of refusing it',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDevice;
        const viewer = yield* makeDevice;
        const hostId = yield* connected(host.device, viewer.device);
        const target = yield* host.sessionWithTurn;
        yield* host.run(
          Sessions.use((s) => s.prompt(target.sessionId, [{ _tag: 'text', text: 'hold' }])),
        );

        const delivery = yield* viewer.device.messaging['Messaging.send']({
          from: sender(SessionId.make('viewer-session')),
          device: hostId,
          sessionId: target.sessionId,
          text: 'when you are done',
        });

        expect(delivery).toBe('queued');
        yield* host.run(Sessions.use((s) => s.cancel(target.sessionId)));
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a Session the other Device does not have is NotFound',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDevice;
        const viewer = yield* makeDevice;
        const hostId = yield* connected(host.device, viewer.device);

        const error = yield* Effect.flip(
          viewer.device.messaging['Messaging.send']({
            from: sender(SessionId.make('viewer-session')),
            device: hostId,
            sessionId: SessionId.make('no-such-session'),
            text: 'hello?',
          }),
        );

        expect(error).toMatchObject({ _tag: 'MessagingError', reason: 'NotFound' });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a Device that is not connected is Offline, and the Message never reaches the Session',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDevice;
        const viewer = yield* makeDevice;
        const hostId = yield* connected(host.device, viewer.device);
        const target = yield* host.sessionWithTurn;
        yield* host.device.setHosting(false);
        // Reconnecting (then Offline after a minute): not connected either way.
        yield* viewer.device.awaitConnection(hostId, 'Reconnecting');

        const error = yield* Effect.flip(
          viewer.device.messaging['Messaging.send']({
            from: sender(SessionId.make('viewer-session')),
            device: hostId,
            sessionId: target.sessionId,
            text: 'anyone there?',
          }),
        );

        expect(error).toMatchObject({ _tag: 'MessagingError', reason: 'Offline' });
        const messages = yield* host.run(userMessages(target.sessionId, 1));
        expect(messages.map(textOf)).toEqual(['echo:ready']);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a Message back to the Session it came from is refused as a loop',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDevice;
        const viewer = yield* makeDevice;
        const hostId = yield* connected(host.device, viewer.device);
        const target = yield* host.sessionWithTurn;

        // The person sends from the host's Session (open in the viewer's window) to that same Session.
        const error = yield* Effect.flip(
          viewer.device.messaging['Messaging.send']({
            from: sender(target.sessionId, hostId),
            device: hostId,
            sessionId: target.sessionId,
            text: 'talking to myself',
          }),
        );

        expect(error).toMatchObject({ _tag: 'MessagingError', reason: 'Loop' });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'starting a Session on another Device sends its first Message, seeded by a summary',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDevice;
        const viewer = yield* makeDevice;
        const hostId = yield* connected(host.device, viewer.device);
        const viewerSelf = yield* viewer.device.identity;
        const project = yield* host.run(Projects.use((projects) => projects.add));
        if (project === null) return yield* Effect.die('no Project');

        const sessionId = yield* viewer.device.messaging['Messaging.startSession']({
          from: sender(SessionId.make('viewer-session')),
          device: hostId,
          projectId: project.id,
          text: 'Take over the release notes.',
          summary: 'We drafted the changelog.',
        });

        const listed = yield* host.run(Sessions.use((s) => s.list(project.id)));
        expect(listed.map((session) => session.id)).toEqual([sessionId]);
        const [first] = yield* host.run(userMessages(sessionId, 1));
        expect(first === undefined ? '' : textOf(first)).toContain('Take over the release notes.');
        expect(first === undefined ? '' : textOf(first)).toContain('We drafted the changelog.');
        expect(first?.from?.device).toEqual({ id: viewerSelf.id, name: viewerSelf.name });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'the Local device is a target too: its own Inbox, with this Device as the sender',
    () =>
      Effect.gen(function* () {
        const local = yield* makeDevice;
        const self = yield* local.device.identity;
        const target = yield* local.sessionWithTurn;

        const delivery = yield* local.device.messaging['Messaging.send']({
          from: sender(SessionId.make('another-local-session')),
          sessionId: target.sessionId,
          text: 'echo:next door',
        });

        expect(delivery).toBe('started');
        const messages = yield* local.run(userMessages(target.sessionId, 2));
        expect(messages.at(-1)?.from?.device).toEqual({ id: self.id, name: self.name });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
