/**
 * Cross-device messages sent by Agents: two in-process Devices over real loopback `wss://`, each with real Projects
 * and Sessions and the fake Agent. The receiving gate is driven over the viewer's connection (`Inbox.*`), as the
 * sending Device's main calls it.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Option, Stream } from 'effect';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import type { ChainLink, SentProvenance } from '../../src/shared/messaging/messaging.rpc';
import { type PermissionRequest, SessionId } from '../../src/shared/sessions/sessions.rpc';
import type { TestDevice } from '../devices/test-peer';
import { Sessions } from '../sessions/sessions';
import { Settings } from '../settings/settings';
import {
  connected,
  makeMessagingDevice,
  type MessagingDevice,
  messagesUntil,
  textOf,
  userMessages,
} from './messaging-fakes';

const TIMEOUT = 60_000;

const agentProvenance = (
  overrides: Partial<SentProvenance> & { readonly chain: ReadonlyArray<ChainLink> },
): SentProvenance => ({
  by: 'agent',
  deviceName: 'Studio',
  sessionId: SessionId.make('viewer-session'),
  sessionTitle: 'Plan the release',
  projectName: 'spence',
  hops: 1,
  permissionMode: 'ask',
  ...overrides,
});

/** The Session's Queue now. */
const queueOf = (sessionId: SessionId) =>
  Stream.unwrap(Sessions.use((s) => Effect.succeed(s.events(sessionId)))).pipe(
    Stream.filter((item) => item._tag === 'Live'),
    Stream.runHead,
    Effect.map((item) => (Option.isSome(item) ? item.value.state.queue : [])),
  );

/** The Session's live state now. */
const liveOf = (sessionId: SessionId) =>
  Stream.unwrap(Sessions.use((s) => Effect.succeed(s.events(sessionId)))).pipe(
    Stream.filter((item) => item._tag === 'Live'),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.map((item) => item.state),
  );

/** The host's Inbox as the viewer's main reaches it over its connection. */
const inboxOf = (viewer: TestDevice, host: DeviceId) =>
  viewer.deviceConnections.client(host).pipe(Effect.orDie);

describe('Cross-device messages from an Agent: the receiving gate', () => {
  it.live(
    'is Forbidden until the host allows Agents from that Device, then shows who asked under which mode',
    () =>
      Effect.gen(function* () {
        const host = yield* makeMessagingDevice;
        const viewer = yield* makeMessagingDevice;
        const hostId = yield* connected(host.device, viewer.device);
        const viewerSelf = yield* viewer.device.identity;
        const target = yield* host.sessionWithTurn;
        const inbox = yield* inboxOf(viewer.device, hostId);
        const provenance = agentProvenance({
          chain: [{ deviceId: viewerSelf.id, sessionId: SessionId.make('viewer-session') }],
        });

        const refused = yield* Effect.flip(
          inbox['Inbox.deliver']({
            sessionId: target.sessionId,
            text: 'echo:hi',
            provenance,
          }),
        );
        expect(refused).toMatchObject({ _tag: 'MessagingError', reason: 'Forbidden' });

        yield* host.device.setAllowAgents(viewerSelf.id, true);
        const accepted = yield* inbox['Inbox.deliver']({
          sessionId: target.sessionId,
          text: 'echo:hi',
          provenance,
        });

        expect(accepted.delivery).toBe('started');
        const messages = yield* host.run(userMessages(target.sessionId, 2));
        const received = messages.at(-1);
        expect(received === undefined ? '' : textOf(received)).toBe('echo:hi');
        expect(received?.from).toMatchObject({
          by: 'agent',
          hops: 1,
          permissionMode: 'ask',
          device: { id: viewerSelf.id, name: 'Studio' },
          chain: [{ deviceId: viewerSelf.id, sessionId: 'viewer-session' }],
        });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'refuses an Agent’s Message to a busy Session as Busy instead of queueing it',
    () =>
      Effect.gen(function* () {
        const host = yield* makeMessagingDevice;
        const viewer = yield* makeMessagingDevice;
        const hostId = yield* connected(host.device, viewer.device);
        const viewerSelf = yield* viewer.device.identity;
        yield* host.device.setAllowAgents(viewerSelf.id, true);
        const target = yield* host.sessionWithTurn;
        yield* host.run(
          Sessions.use((s) => s.prompt(target.sessionId, [{ _tag: 'text', text: 'hold' }])),
        );
        const inbox = yield* inboxOf(viewer.device, hostId);

        const error = yield* Effect.flip(
          inbox['Inbox.deliver']({
            sessionId: target.sessionId,
            text: 'echo:are you there',
            provenance: agentProvenance({
              chain: [{ deviceId: viewerSelf.id, sessionId: SessionId.make('viewer-session') }],
            }),
          }),
        );

        expect(error).toMatchObject({ _tag: 'MessagingError', reason: 'Busy' });
        expect(yield* host.run(queueOf(target.sessionId))).toEqual([]);
        yield* host.run(Sessions.use((s) => s.cancel(target.sessionId)));
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'refuses as a loop: more than 3 hops, a target already in the chain, or the sender itself',
    () =>
      Effect.gen(function* () {
        const host = yield* makeMessagingDevice;
        const viewer = yield* makeMessagingDevice;
        const hostId = yield* connected(host.device, viewer.device);
        const viewerSelf = yield* viewer.device.identity;
        yield* host.device.setAllowAgents(viewerSelf.id, true);
        const target = yield* host.sessionWithTurn;
        const inbox = yield* inboxOf(viewer.device, hostId);
        const viewerLink = { deviceId: viewerSelf.id, sessionId: SessionId.make('viewer-session') };
        const targetLink = { deviceId: hostId, sessionId: target.sessionId };
        const send = (provenance: SentProvenance) =>
          Effect.flip(
            inbox['Inbox.deliver']({ sessionId: target.sessionId, text: 'echo:loop', provenance }),
          );

        const tooFar = yield* send(agentProvenance({ hops: 4, chain: [viewerLink] }));
        const back = yield* send(agentProvenance({ hops: 2, chain: [targetLink, viewerLink] }));
        const self = yield* send(
          agentProvenance({ sessionId: target.sessionId, chain: [targetLink] }),
        );

        for (const error of [tooFar, back, self])
          expect(error).toMatchObject({ _tag: 'MessagingError', reason: 'Loop' });
        const messages = yield* host.run(userMessages(target.sessionId, 1));
        expect(messages.map(textOf)).toEqual(['echo:ready']);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});

/** What the Agent of a Session said in its `turn`-th Turn (1-based), as one text. */
const agentSaid = (sessionId: SessionId, turn: number) =>
  Effect.map(messagesUntil(sessionId, turn), (messages) => {
    const turns = [...new Set(messages.map((message) => message.turnId))];
    const turnId = turns[turn - 1];
    return messages
      .filter((message) => message.role === 'agent' && message.turnId === turnId)
      .map(textOf)
      .join('');
  });

/** Has the Session's Agent call a Spence tool in a new Turn, and returns what the tool answered. */
const callTool = Effect.fnUntraced(function* (
  device: MessagingDevice,
  sessionId: SessionId,
  turn: number,
  tool: string,
  args: Readonly<Record<string, unknown>>,
) {
  yield* device.run(
    Sessions.use((s) =>
      s.prompt(sessionId, [{ _tag: 'text', text: `mcp:${tool}:${JSON.stringify(args)}` }]),
    ),
  );
  const said = yield* device.run(agentSaid(sessionId, turn));
  return JSON.parse(said) as Record<string, unknown>;
});

/** The first Session handle `list_targets` gives the Session's Agent, in its `turn`-th Turn. */
const firstSessionHandle = Effect.fnUntraced(function* (
  device: MessagingDevice,
  sessionId: SessionId,
  turn: number,
) {
  const listed = (yield* callTool(
    device,
    sessionId,
    turn,
    'list_targets',
    {},
  )) as unknown as ListedTargets;
  const handle = listed.devices[0]?.projects?.[0]?.sessions[0]?.handle;
  if (handle === undefined) return yield* Effect.die('no target');
  return handle;
});

/** The next pending Permission request in the Session other than `seen`. */
const nextPermission = (sessionId: SessionId, seen: ReadonlySet<string>) =>
  Stream.unwrap(Sessions.use((s) => Effect.succeed(s.events(sessionId)))).pipe(
    Stream.map((item): PermissionRequest | undefined =>
      item._tag === 'Transcript' &&
      item.event.item._tag === 'PermissionRequest' &&
      item.event.item.state._tag === 'pending' &&
      !seen.has(item.event.item.id)
        ? item.event.item
        : undefined,
    ),
    Stream.filter((request): request is PermissionRequest => request !== undefined),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

interface ListedTargets {
  readonly devices: ReadonlyArray<{
    readonly name: string;
    readonly online: boolean;
    readonly projects?: ReadonlyArray<{
      readonly handle: string;
      readonly name: string;
      readonly sessions: ReadonlyArray<{ readonly handle: string; readonly title: string }>;
    }>;
  }>;
}

describe('Cross-device messages from an Agent: its tools', () => {
  it.live(
    'an Agent lists targets by opaque handle and sends a Message there under Auto, with its Provenance',
    () =>
      Effect.gen(function* () {
        const host = yield* makeMessagingDevice;
        const viewer = yield* makeMessagingDevice;
        const hostId = yield* connected(host.device, viewer.device);
        const viewerSelf = yield* viewer.device.identity;
        const hostSelf = yield* host.device.identity;
        yield* host.device.setAllowAgents(viewerSelf.id, true);
        const target = yield* host.sessionWithTurn;
        const sender = yield* viewer.sessionWithTurn;
        yield* viewer.attachAgentTools;

        const listed = (yield* callTool(
          viewer,
          sender.sessionId,
          2,
          'list_targets',
          {},
        )) as unknown as ListedTargets;
        const raw = JSON.stringify(listed);
        // Opaque: no Device or Session ids, addresses or tokens.
        expect(raw).not.toContain(hostId);
        expect(raw).not.toContain(target.sessionId);
        expect(raw).not.toContain('127.0.0.1');
        const device = listed.devices.find((entry) => entry.name === hostSelf.name);
        expect(device?.online).toBe(true);
        const handle = device?.projects?.[0]?.sessions[0]?.handle ?? '';

        const sent = yield* callTool(viewer, sender.sessionId, 3, 'send_message', {
          to: handle,
          text: 'echo:from an Agent',
        });

        expect(sent).toMatchObject({ accepted: true, delivery: 'started' });
        expect(typeof sent['handle']).toBe('string');
        const messages = yield* host.run(userMessages(target.sessionId, 2));
        const received = messages.at(-1);
        expect(received === undefined ? '' : textOf(received)).toBe('echo:from an Agent');
        expect(received?.from).toMatchObject({
          sessionId: sender.sessionId,
          by: 'agent',
          hops: 1,
          permissionMode: 'auto',
          device: { id: viewerSelf.id, name: viewerSelf.name },
          chain: [{ deviceId: viewerSelf.id, sessionId: sender.sessionId }],
        });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'under Ask the send is a Permission request in the sending Session: Deny sends nothing, Allow once sends',
    () =>
      Effect.gen(function* () {
        const host = yield* makeMessagingDevice;
        const viewer = yield* makeMessagingDevice;
        yield* connected(host.device, viewer.device);
        const viewerSelf = yield* viewer.device.identity;
        yield* host.device.setAllowAgents(viewerSelf.id, true);
        const target = yield* host.sessionWithTurn;
        const sender = yield* viewer.sessionWithTurn;
        yield* viewer.attachAgentTools;
        yield* viewer.run(
          Sessions.use((s) =>
            s.setOption({ sessionId: sender.sessionId, option: 'permissionMode', value: 'ask' }),
          ),
        );
        const handle = yield* firstSessionHandle(viewer, sender.sessionId, 2);
        const send = { to: handle, text: 'echo:may I' };

        const denied = yield* Effect.forkChild(
          callTool(viewer, sender.sessionId, 3, 'send_message', send),
        );
        const first = yield* viewer.run(nextPermission(sender.sessionId, new Set()));
        expect(first.options.map((option) => option.kind)).toEqual(['allowOnce', 'rejectOnce']);
        yield* viewer.run(
          Sessions.use((s) => s.answerPermission(sender.sessionId, first.id, 'deny')),
        );
        expect(yield* Fiber.join(denied)).toMatchObject({ error: { reason: 'PermissionDenied' } });

        const allowed = yield* Effect.forkChild(
          callTool(viewer, sender.sessionId, 4, 'send_message', send),
        );
        const second = yield* viewer.run(nextPermission(sender.sessionId, new Set([first.id])));
        yield* viewer.run(
          Sessions.use((s) => s.answerPermission(sender.sessionId, second.id, 'allow-once')),
        );
        expect(yield* Fiber.join(allowed)).toMatchObject({ accepted: true });

        const messages = yield* host.run(userMessages(target.sessionId, 2));
        expect(messages.map(textOf)).toEqual(['echo:ready', 'echo:may I']);
        expect(messages.at(-1)?.from?.permissionMode).toBe('ask');
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'await_result returns the Turn outcome and its final Message text, or pending while it runs',
    () =>
      Effect.gen(function* () {
        const host = yield* makeMessagingDevice;
        const viewer = yield* makeMessagingDevice;
        yield* connected(host.device, viewer.device);
        const viewerSelf = yield* viewer.device.identity;
        yield* host.device.setAllowAgents(viewerSelf.id, true);
        const target = yield* host.sessionWithTurn;
        const sender = yield* viewer.sessionWithTurn;
        yield* viewer.attachAgentTools;
        const handle = yield* firstSessionHandle(viewer, sender.sessionId, 2);

        const done = yield* callTool(viewer, sender.sessionId, 3, 'send_message', {
          to: handle,
          text: 'echo:the answer is 42',
        });
        const result = yield* callTool(viewer, sender.sessionId, 4, 'await_result', {
          handle: done['handle'],
          timeoutSeconds: 30,
        });
        expect(result).toEqual({ status: 'done', text: 'the answer is 42' });

        const held = yield* callTool(viewer, sender.sessionId, 5, 'send_message', {
          to: handle,
          text: 'hold',
        });
        const pending = yield* callTool(viewer, sender.sessionId, 6, 'await_result', {
          handle: held['handle'],
          timeoutSeconds: 0,
        });
        expect(pending).toEqual({ status: 'pending' });
        // Ensure the fake Agent has entered `hold` (`waitForCancel`) before `session/cancel` arrives.
        yield* host.run(
          Stream.unwrap(Sessions.use((s) => Effect.succeed(s.events(target.sessionId)))).pipe(
            Stream.filter(
              (item) =>
                item._tag === 'Transcript' &&
                item.event.item._tag === 'Message' &&
                item.event.item.role === 'agent' &&
                textOf(item.event.item) === 'working',
            ),
            Stream.runHead,
          ),
        );
        yield* host.run(Sessions.use((s) => s.cancel(target.sessionId)));
        const cancelled = yield* callTool(viewer, sender.sessionId, 7, 'await_result', {
          handle: held['handle'],
          timeoutSeconds: 30,
        });
        expect(cancelled).toMatchObject({ status: 'cancelled' });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'start_session starts a Session on the other Device under that Device’s default Permission mode',
    () =>
      Effect.gen(function* () {
        const host = yield* makeMessagingDevice;
        const viewer = yield* makeMessagingDevice;
        yield* connected(host.device, viewer.device);
        const viewerSelf = yield* viewer.device.identity;
        yield* host.device.setAllowAgents(viewerSelf.id, true);
        const target = yield* host.sessionWithTurn;
        yield* host.run(
          Settings.use((settings) => settings.update({ defaultPermissionMode: 'ask' })),
        );
        const sender = yield* viewer.sessionWithTurn;
        yield* viewer.attachAgentTools;
        const listed = (yield* callTool(
          viewer,
          sender.sessionId,
          2,
          'list_targets',
          {},
        )) as unknown as ListedTargets;
        const project = listed.devices[0]?.projects?.[0]?.handle;

        const started = yield* callTool(viewer, sender.sessionId, 3, 'start_session', {
          project,
          text: 'echo:take it from here',
        });

        expect(started).toMatchObject({ accepted: true });
        expect(typeof started['session']).toBe('string');
        const result = yield* callTool(viewer, sender.sessionId, 4, 'await_result', {
          handle: started['handle'],
          timeoutSeconds: 30,
        });
        expect(result).toEqual({ status: 'done', text: 'take it from here' });
        const sessions = yield* host.run(Sessions.use((s) => s.list(target.project.id)));
        const created = sessions.find((session) => session.id !== target.sessionId);
        if (created === undefined) return yield* Effect.die('no new Session');
        const live = yield* host.run(liveOf(created.id));
        // The host's default, not the sender's (Auto).
        expect(live.options.permissionMode).toBe('ask');
        const [first] = yield* host.run(userMessages(created.id, 1));
        expect(first?.from).toMatchObject({ by: 'agent', permissionMode: 'auto', hops: 1 });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a receiving Session’s Agent cannot send back along the chain its Turn came through',
    () =>
      Effect.gen(function* () {
        const host = yield* makeMessagingDevice;
        const viewer = yield* makeMessagingDevice;
        // The viewer hosts too, so the host learns where to reach it back when they pair.
        yield* viewer.device.setHosting(true);
        const hostId = yield* connected(host.device, viewer.device);
        const viewerSelf = yield* viewer.device.identity;
        yield* host.device.setAllowAgents(viewerSelf.id, true);
        yield* viewer.device.setAllowAgents(hostId, true);
        yield* host.device.connect(viewerSelf.id);
        yield* host.device.awaitConnection(viewerSelf.id, 'Online');
        yield* host.sessionWithTurn;
        const sender = yield* viewer.sessionWithTurn;
        yield* viewer.attachAgentTools;
        yield* host.attachAgentTools;
        const handle = yield* firstSessionHandle(viewer, sender.sessionId, 2);

        // The viewer's Agent asks the host Session's Agent to list its targets: the viewer's Session among them.
        const listing = yield* callTool(viewer, sender.sessionId, 3, 'send_message', {
          to: handle,
          text: 'mcp:list_targets:{}',
        });
        const listed = yield* callTool(viewer, sender.sessionId, 4, 'await_result', {
          handle: listing['handle'],
          timeoutSeconds: 30,
        });
        const back = (JSON.parse(String(listed['text'])) as ListedTargets).devices[0]?.projects?.[0]
          ?.sessions[0]?.handle;
        // ...then to send to it: the viewer's Session is in the chain, so it is refused as a loop.
        const replying = yield* callTool(viewer, sender.sessionId, 5, 'send_message', {
          to: handle,
          text: `mcp:send_message:${JSON.stringify({ to: back, text: 'echo:pong' })}`,
        });
        const replied = yield* callTool(viewer, sender.sessionId, 6, 'await_result', {
          handle: replying['handle'],
          timeoutSeconds: 30,
        });

        expect(JSON.parse(String(replied['text']))).toMatchObject({ error: { reason: 'Loop' } });
        const received = yield* viewer.run(userMessages(sender.sessionId, 6));
        expect(received.some((message) => textOf(message) === 'echo:pong')).toBe(false);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
