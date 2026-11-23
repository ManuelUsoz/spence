import { Duration, Effect } from 'effect';
import { randomBytes } from 'node:crypto';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import {
  MAX_CROSS_DEVICE_HOPS,
  MessagingError,
  type SentProvenance,
  type TurnResult,
} from '../../src/shared/messaging/messaging.rpc';
import type { ProjectId } from '../../src/shared/projects/projects.rpc';
import type { SessionId, SessionTitle } from '../../src/shared/sessions/sessions.rpc';
import { DeviceIdentity } from '../devices/identity';
import { DeviceConnections, type RemoteClient } from '../lan/connections';
import type { AgentCaller, CrossDeviceTools } from '../sessions/cross-device-tools';
import { type ToolOutcome, toolError } from '../sessions/delegation-server';
import { Sessions } from '../sessions/sessions';

/** What a handle stands for. Only main sees these; the Agent sees the handle alone. */
type Target =
  | {
      readonly kind: 'session';
      readonly deviceId: DeviceId;
      readonly deviceName: string;
      readonly sessionId: SessionId;
      readonly title: string;
    }
  | {
      readonly kind: 'project';
      readonly deviceId: DeviceId;
      readonly deviceName: string;
      readonly projectId: ProjectId;
      readonly name: string;
    }
  | { readonly kind: 'result'; readonly deviceId: DeviceId; readonly receipt: string };

/** How many handles this Device keeps (in memory only, for this run); the oldest goes first. */
const MAX_HANDLES = 5000;

/** Extra time the sender waits past the target's own wait before it gives up on the connection. */
const RESULT_SLACK = Duration.seconds(10);

const titleText = (title: SessionTitle): string => title.user ?? title.auto ?? 'Untitled';

const json = (value: unknown): ToolOutcome => ({ text: JSON.stringify(value) });

/** A refusal from the target Device, as the Agent reads it: the same reasons, one word each. */
const refused = (error: MessagingError): ToolOutcome => toolError(error.reason, error.detail);

/** The connection to a Device failing on the way is `Offline`, like not being connected at all. */
const overConnection = <A>(
  deviceName: string,
  call: Effect.Effect<A, MessagingError | { readonly _tag: string }>,
): Effect.Effect<A, MessagingError> =>
  call.pipe(
    Effect.catchIf(
      (error): error is { readonly _tag: string } => !(error instanceof MessagingError),
      () =>
        Effect.fail(new MessagingError({ reason: 'Offline', detail: `${deviceName} is offline.` })),
    ),
  );

/**
 * The cross-device tools over this Device's connections to its Paired devices. Handles are random tokens, minted here
 * per sending Session, so another Session's handle is unknown to it; they live only in memory for this run.
 */
const makeAgentTools = Effect.gen(function* () {
  const identity = yield* DeviceIdentity;
  const connections = yield* DeviceConnections;

  /** handle -> what it stands for, with the Session it was given to. */
  const handles = new Map<string, { readonly owner: SessionId; readonly target: Target }>();
  /** The same target for the same Session keeps its handle across `list_targets` calls. */
  const byKey = new Map<string, string>();

  const keyOf = (owner: SessionId, target: Target): string => {
    switch (target.kind) {
      case 'session':
        return `${owner}|s|${target.deviceId}|${target.sessionId}`;
      case 'project':
        return `${owner}|p|${target.deviceId}|${target.projectId}`;
      case 'result':
        return `${owner}|r|${target.deviceId}|${target.receipt}`;
    }
  };

  const mint = (owner: SessionId, target: Target): string => {
    const key = keyOf(owner, target);
    const known = byKey.get(key);
    if (known !== undefined) {
      handles.set(known, { owner, target });
      return known;
    }
    const handle = `${target.kind}-${randomBytes(12).toString('base64url')}`;
    handles.set(handle, { owner, target });
    byKey.set(key, handle);
    for (const [oldest, entry] of handles) {
      if (handles.size <= MAX_HANDLES) break;
      handles.delete(oldest);
      byKey.delete(keyOf(entry.owner, entry.target));
    }
    return handle;
  };

  const resolve = <K extends Target['kind']>(
    caller: AgentCaller,
    handle: string,
    kind: K,
  ): Extract<Target, { readonly kind: K }> | undefined => {
    const entry = handles.get(handle);
    if (entry === undefined || entry.owner !== caller.sessionId || entry.target.kind !== kind)
      return undefined;
    return entry.target as Extract<Target, { readonly kind: K }>;
  };

  /** An Agent's Provenance: one hop more than the Turn it acts in, its chain extended by its own Session. */
  const agentProvenance = Effect.fnUntraced(function* (caller: AgentCaller) {
    const self = yield* identity.get;
    const provenance: SentProvenance = {
      by: 'agent',
      deviceName: self.name,
      sessionId: caller.sessionId,
      sessionTitle: caller.title,
      projectName: caller.projectName,
      hops: caller.hops + 1,
      chain: [...caller.chain, { deviceId: self.id, sessionId: caller.sessionId }],
      permissionMode: caller.permissionMode,
    };
    return provenance;
  });

  const tooFar = (caller: AgentCaller): ToolOutcome | undefined =>
    caller.hops + 1 > MAX_CROSS_DEVICE_HOPS
      ? toolError('Loop', 'This conversation has crossed too many Sessions')
      : undefined;

  const clientOf = (deviceId: DeviceId, deviceName: string) =>
    connections
      .client(deviceId)
      .pipe(
        Effect.mapError(
          () => new MessagingError({ reason: 'Offline', detail: `${deviceName} is offline.` }),
        ),
      );

  /** One Paired device's Projects and their (unarchived) Sessions, by handle. */
  const targetsOn = Effect.fnUntraced(function* (
    caller: AgentCaller,
    client: RemoteClient,
    deviceId: DeviceId,
    deviceName: string,
  ) {
    const projects = yield* client['Projects.list']();
    return yield* Effect.forEach(projects, (project) =>
      Effect.map(client['Session.list']({ projectId: project.id }), (sessions) => ({
        handle: mint(caller.sessionId, {
          kind: 'project',
          deviceId,
          deviceName,
          projectId: project.id,
          name: project.name,
        }),
        name: project.name,
        sessions: sessions
          .filter((session) => session.archivedAt === undefined)
          .map((session) => {
            const title = titleText(session.title);
            return {
              handle: mint(caller.sessionId, {
                kind: 'session',
                deviceId,
                deviceName,
                sessionId: session.id,
                title,
              }),
              title,
              state: session.status === 'working' ? 'running' : 'idle',
            };
          }),
      })),
    );
  });

  const listTargets = Effect.fnUntraced(function* (caller: AgentCaller) {
    const devices = yield* Effect.forEach(yield* connections.list, (device) =>
      device.status._tag !== 'Online'
        ? Effect.succeed({ name: device.name, online: false })
        : connections.client(device.id).pipe(
            Effect.flatMap((client) => targetsOn(caller, client, device.id, device.name)),
            Effect.map((projects) => ({ name: device.name, online: true, projects })),
            Effect.orElseSucceed(() => ({ name: device.name, online: false })),
          ),
    );
    return json({ devices });
  });

  const sendMessage = Effect.fnUntraced(function* (
    caller: AgentCaller,
    input: { readonly to: string; readonly text: string },
  ) {
    const target = resolve(caller, input.to, 'session');
    if (target === undefined) return toolError('NotFound', 'No such session handle');
    const loop = tooFar(caller);
    if (loop !== undefined) return loop;
    if (
      !(yield* caller.confirm({ kind: 'send', session: target.title, device: target.deviceName }))
    )
      return toolError('PermissionDenied', 'The user did not allow this message');
    const provenance = yield* agentProvenance(caller);
    const accepted = yield* clientOf(target.deviceId, target.deviceName).pipe(
      Effect.flatMap((client) =>
        overConnection(
          target.deviceName,
          client['Inbox.deliver']({ sessionId: target.sessionId, text: input.text, provenance }),
        ),
      ),
      Effect.result,
    );
    if (accepted._tag === 'Failure') return refused(accepted.failure);
    const { delivery, receipt } = accepted.success;
    return json({
      accepted: true,
      delivery,
      ...(receipt === undefined
        ? {}
        : {
            handle: mint(caller.sessionId, { kind: 'result', deviceId: target.deviceId, receipt }),
          }),
    });
  });

  const startSession = Effect.fnUntraced(function* (
    caller: AgentCaller,
    input: { readonly project: string; readonly text: string },
  ) {
    const target = resolve(caller, input.project, 'project');
    if (target === undefined) return toolError('NotFound', 'No such project handle');
    const loop = tooFar(caller);
    if (loop !== undefined) return loop;
    if (
      !(yield* caller.confirm({ kind: 'start', project: target.name, device: target.deviceName }))
    )
      return toolError('PermissionDenied', 'The user did not allow starting this Session');
    const provenance = yield* agentProvenance(caller);
    const started = yield* clientOf(target.deviceId, target.deviceName).pipe(
      Effect.flatMap((client) =>
        overConnection(
          target.deviceName,
          client['Inbox.start']({ projectId: target.projectId, text: input.text, provenance }),
        ),
      ),
      Effect.result,
    );
    if (started._tag === 'Failure') return refused(started.failure);
    const { sessionId, receipt } = started.success;
    return json({
      accepted: true,
      session: mint(caller.sessionId, {
        kind: 'session',
        deviceId: target.deviceId,
        deviceName: target.deviceName,
        sessionId,
        title: input.text.split(/\r?\n/)[0]?.trim().slice(0, 80) ?? '',
      }),
      ...(receipt === undefined
        ? {}
        : {
            handle: mint(caller.sessionId, { kind: 'result', deviceId: target.deviceId, receipt }),
          }),
    });
  });

  const describeResult = (result: TurnResult): ToolOutcome =>
    result._tag === 'Pending'
      ? json({ status: 'pending' })
      : json({
          status: result.outcome._tag,
          ...(result.outcome._tag === 'failed' ? { detail: result.outcome.detail } : {}),
          ...(result.outcome._tag === 'cutShort' ? { limit: result.outcome.limit } : {}),
          text: result.text,
        });

  const awaitResult = Effect.fnUntraced(function* (
    caller: AgentCaller,
    input: { readonly handle: string; readonly timeoutSeconds: number },
  ) {
    const target = resolve(caller, input.handle, 'result');
    if (target === undefined) return toolError('NotFound', 'No such result handle');
    const deviceName =
      (yield* connections.list).find((device) => device.id === target.deviceId)?.name ??
      'The other Device';
    const timeoutMs = Math.round(input.timeoutSeconds * 1000);
    const result = yield* clientOf(target.deviceId, deviceName).pipe(
      Effect.flatMap((client) =>
        overConnection(
          deviceName,
          client['Inbox.result']({ receipt: target.receipt, timeoutMs }).pipe(
            Effect.timeoutOption(Duration.sum(Duration.millis(timeoutMs), RESULT_SLACK)),
          ),
        ),
      ),
      Effect.result,
    );
    if (result._tag === 'Failure') return refused(result.failure);
    return result.success._tag === 'None'
      ? json({ status: 'pending' })
      : describeResult(result.success.value);
  });

  const tools: CrossDeviceTools = {
    listTargets,
    sendMessage,
    startSession,
    awaitResult,
    isTarget: (caller, to) => resolve(caller, to, 'session') !== undefined,
  };
  return tools;
});

/**
 * Gives this Device's Agents the cross-device tools for the life of the scope, over its connections to its Paired
 * devices. Built after Sessions and the Devices, which is why it is attached rather than provided.
 */
export const attachAgentTools = Effect.gen(function* () {
  const tools = yield* makeAgentTools;
  yield* Sessions.use((sessions) => sessions.attachCrossDeviceTools(tools));
});
