/**
 * Cross-device messages sent by a person: two in-process Devices over real loopback `wss://`, each with real Projects
 * and Sessions and the fake Agent. The viewer sends as its window does (`MessagingRpcs`); the host's Transcript shows
 * what arrived and with which Provenance.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import type { SendingSession } from '../../src/shared/messaging/messaging.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { Projects } from '../projects/projects';
import { Sessions } from '../sessions/sessions';
import { connected, makeMessagingDevice, textOf, userMessages } from './messaging-fakes';

const TIMEOUT = 60_000;

const makeDevice = makeMessagingDevice;

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
          chain: [{ deviceId: viewerSelf.id, sessionId: from }],
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
