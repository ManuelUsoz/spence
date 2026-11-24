/**
 * Permission requests, Attention and several viewers of one Remote Session: two (or three) in-process Devices over
 * real loopback `wss://`, the host serving real Sessions with the fake Agent, each viewer calling them as its window
 * would (`DeviceScopedRpcs` through the production router, the Device named in the `DEVICE_SCOPE_HEADER`).
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Queue, Stream } from 'effect';
import { RpcClient } from 'effect/rpc';
import { DEVICE_SCOPE_HEADER, type DeviceId } from '../../src/shared/devices/devices.rpc';
import type {
  SessionId,
  SessionNotification,
  SessionStreamItem,
  TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';
import type { Settings as SettingsValue } from '../../src/shared/settings/settings.rpc';
import { PaneId, PanelId, TabId, type WorkspaceState } from '../../src/shared/tabs/tabs.rpc';
import { fakeEntry, installFakeAgent } from '../acp/acpFakes';
import { makeTestDevice, pairDevices, tempDataDir, type TestDevice } from '../devices/test-peer';
import { Projects } from '../projects/projects';
import { layerProjectsHandlersWith } from '../rpc/projects';
import { layerSessionsHandlersWith } from '../rpc/sessions';
import {
  InAppNotifications,
  layerInAppNotificationChannel,
  layerInAppNotifications,
} from '../sessions/in-app-notifications';
import {
  layerNotificationDispatcher,
  makeOsNotificationChannel,
  NotificationChannel,
  NotificationDispatcher,
} from '../sessions/notifier';
import { layerTabActivations } from '../sessions/tab-activations';
import { AgentCatalog, makeAgentCatalog } from '../sessions/session-agent';
import { layerSessionVisibility, SessionVisibility } from '../sessions/session-visibility';
import { layerSessionsWithFakeAgent } from '../sessions/sessions-fakes';
import { layerWindowFocus, WindowFocus } from '../sessions/window-focus';
import { Settings } from '../settings/settings';
import { DeviceConnections } from './connections';
import { layerRemoteNotifier } from './remote-notifier';

/** Spawning the fake Agent and a real ACP handshake take longer than the default on a cold machine. */
const TIMEOUT = 60_000;

const PROJECT_FOLDER = process.cwd();

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
  const run = <A, E>(effect: Effect.Effect<A, E, Projects>) => Effect.provide(effect, sessions);
  return { device, run };
});

/** Pairs the two and waits until the viewer is connected to the host. */
const connected = Effect.fnUntraced(function* (host: TestDevice, viewer: TestDevice) {
  yield* pairDevices(host, viewer);
  const hostId = (yield* host.identity).id;
  yield* viewer.awaitConnection(hostId, 'Online');
  return hostId;
});

const transcriptOf = (items: ReadonlyArray<SessionStreamItem>): ReadonlyArray<TranscriptItem> =>
  items.flatMap((item) => (item._tag === 'Transcript' ? [item.event.item] : []));

const agentText = (items: ReadonlyArray<SessionStreamItem>): string =>
  transcriptOf(items)
    .flatMap((event) => {
      if (event._tag === 'Message' && event.role === 'agent') {
        return event.parts.flatMap((part) => (part._tag === 'text' ? [part.text] : []));
      }
      if (event._tag === 'MessageDelta') return [event.text];
      return [];
    })
    .join('');

const permissionStates = (items: ReadonlyArray<SessionStreamItem>) =>
  transcriptOf(items).flatMap((event) => (event._tag === 'PermissionRequest' ? [event.state] : []));

describe('Remote Permissions, Attention and concurrent viewers', () => {
  it.live(
    'Allow once, Always allow and Deny answered from a viewer reach the Agent as they do Local',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDeviceWithSessions;
        const viewer = yield* makeDeviceWithSessions;
        const hostId = yield* connected(host.device, viewer.device);
        const hosted = yield* host.run(Projects.use((projects) => projects.add));
        if (hosted === null) return yield* Effect.die('no Project');
        const api = viewer.device.desktop;
        const remote = onDevice(hostId);

        for (const optionId of ['allow', 'always', 'reject']) {
          const sessionId = yield* remote(api['Session.create']({ projectId: hosted.id }));
          yield* remote(
            api['Session.setOption']({ sessionId, option: 'permissionMode', value: 'ask' }),
          );
          yield* remote(
            api['Session.prompt']({ sessionId, parts: [{ _tag: 'text', text: 'permit' }] }),
          );
          const pending = yield* pendingRequest(api, hostId, sessionId);

          yield* remote(
            api['Session.answerPermission']({ sessionId, requestId: pending.id, optionId }),
          );

          const items = yield* untilTurnEnds(api, hostId, sessionId);
          expect(agentText(items)).toBe(`permission ${optionId}`);
          expect(permissionStates(items).at(-1)).toEqual({
            _tag: 'answered',
            optionId,
            by: 'user',
          });
        }
      }).pipe(Effect.scoped),
    TIMEOUT * 2,
  );

  it.live(
    'with two viewers of one Session, the second prompt is Busy and the first Permission answer wins',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDeviceWithSessions;
        const first = yield* makeDeviceWithSessions;
        const second = yield* makeDeviceWithSessions;
        const hostId = yield* connected(host.device, first.device);
        yield* connected(host.device, second.device);
        const hosted = yield* host.run(Projects.use((projects) => projects.add));
        if (hosted === null) return yield* Effect.die('no Project');
        const remote = onDevice(hostId);
        const a = first.device.desktop;
        const b = second.device.desktop;

        const sessionId = yield* remote(a['Session.create']({ projectId: hosted.id }));
        yield* remote(
          a['Session.setOption']({ sessionId, option: 'permissionMode', value: 'ask' }),
        );
        yield* remote(
          a['Session.prompt']({ sessionId, parts: [{ _tag: 'text', text: 'permit' }] }),
        );
        // Both viewers follow the Session with no lock; both see the request.
        const seenByA = yield* pendingRequest(a, hostId, sessionId);
        const seenByB = yield* pendingRequest(b, hostId, sessionId);
        expect(seenByB.id).toBe(seenByA.id);

        const busy = yield* Effect.flip(
          remote(b['Session.prompt']({ sessionId, parts: [{ _tag: 'text', text: 'echo:hi' }] })),
        );
        expect(busy).toMatchObject({ _tag: 'SessionError', reason: 'Busy' });

        yield* remote(
          a['Session.answerPermission']({ sessionId, requestId: seenByA.id, optionId: 'allow' }),
        );
        yield* remote(
          b['Session.answerPermission']({ sessionId, requestId: seenByB.id, optionId: 'reject' }),
        );

        const items = yield* untilTurnEnds(b, hostId, sessionId);
        expect(agentText(items)).toBe('permission allow');
        expect(permissionStates(items)).toEqual([
          { _tag: 'pending' },
          { _tag: 'answered', optionId: 'allow', by: 'user' },
        ]);
      }).pipe(Effect.scoped),
    TIMEOUT * 2,
  );

  it.live(
    'a Remote Session that needs an answer notifies the viewer, naming its Device',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDeviceWithSessions;
        const viewer = yield* makeDeviceWithSessions;
        const hostId = yield* connected(host.device, viewer.device);
        const hosted = yield* host.run(Projects.use((projects) => projects.add));
        if (hosted === null) return yield* Effect.die('no Project');
        const api = viewer.device.desktop;
        const remote = onDevice(hostId);

        const notified = yield* Queue.unbounded<SessionNotification>();
        const settingsStub = Layer.succeed(Settings, {
          get: Effect.succeed<SettingsValue>({
            language: 'en',
            theme: 'system',
            notifications: true,
            sendMode: 'queue',
            projectOrder: { by: 'lastUsed', direction: 'desc' },
            defaultPermissionMode: 'auto',
            defaultAgent: 'claude',
            autoArchiveDays: null,
            subagents: 'workers',
            crossProjectAccess: [],
            browserAllowedOrigins: [],
            agents: {},
          }),
          update: () => Effect.die('unused'),
          changes: Stream.empty,
        });
        const dispatcherLayer = layerNotificationDispatcher.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              settingsStub,
              layerSessionVisibility,
              layerWindowFocus,
              Layer.succeed(
                NotificationChannel,
                NotificationChannel.of({
                  notify: (notification) => Effect.asVoid(Queue.offer(notified, notification)),
                }),
              ),
            ),
          ),
        );
        const remoteLayer = yield* Layer.build(
          Layer.mergeAll(
            dispatcherLayer,
            layerRemoteNotifier.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(DeviceConnections, viewer.device.deviceConnections),
                  dispatcherLayer,
                ),
              ),
            ),
          ),
        );

        const sessionId = yield* remote(api['Session.create']({ projectId: hosted.id }));
        yield* remote(
          api['Session.setOption']({ sessionId, option: 'permissionMode', value: 'ask' }),
        );
        // The notifier follows the Device's changes from when it connects: give it a moment to subscribe.
        yield* Effect.sleep('200 millis');
        yield* remote(
          api['Session.prompt']({ sessionId, parts: [{ _tag: 'text', text: 'permit' }] }),
        );

        const blocked = yield* Queue.take(notified);
        expect(blocked).toMatchObject({
          device: hostId,
          sessionId,
          projectId: hosted.id,
          cause: 'blocked',
        });
        expect(blocked.turnId).toBeDefined();
        const pending = yield* pendingRequest(api, hostId, sessionId);
        yield* remote(
          api['Session.answerPermission']({ sessionId, requestId: pending.id, optionId: 'allow' }),
        );
        yield* untilTurnEnds(api, hostId, sessionId);
        expect(yield* Queue.take(notified)).toMatchObject({
          device: hostId,
          sessionId,
          projectId: hosted.id,
          turnId: blocked.turnId,
          cause: 'turnFinished',
        });

        // When window is focused and Remote Session is visible in active Tab, notifications are suppressed.
        const tabId = TabId.make('tab-rem');
        const paneId = PaneId.make('pane-rem');
        const panelId = PanelId.make('panel-rem');
        const remoteWorkspace: WorkspaceState = {
          activeProjectId: hosted.id,
          projects: [
            {
              projectId: hosted.id,
              device: hostId,
              activeTabId: tabId,
              tabs: [
                {
                  id: tabId,
                  focusedPanelId: panelId,
                  layout: {
                    rootPaneId: paneId,
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: paneId,
                        panels: [{ id: panelId, spec: { _tag: 'Session', sessionId } }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };
        yield* Effect.provide(
          Effect.gen(function* () {
            const visibility = yield* SessionVisibility;
            const focus = yield* WindowFocus;
            const dispatcher = yield* NotificationDispatcher;
            yield* focus.setFocused(true);
            yield* visibility.setWorkspace(remoteWorkspace, false);
            yield* Effect.yieldNow;
            yield* dispatcher.sync;
          }),
          remoteLayer,
        );
        yield* remote(
          api['Session.prompt']({ sessionId, parts: [{ _tag: 'text', text: 'permit' }] }),
        );
        const secondPending = yield* pendingRequest(api, hostId, sessionId);
        yield* Effect.provide(
          NotificationDispatcher.use((d) => d.sync),
          remoteLayer,
        );
        expect(yield* Queue.clear(notified)).toEqual([]);
        yield* remote(
          api['Session.answerPermission']({
            sessionId,
            requestId: secondPending.id,
            optionId: 'allow',
          }),
        );
        yield* untilTurnEnds(api, hostId, sessionId);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'routes Remote Session notifications to InAppNotifications when focused and off-screen, and to OS when unfocused',
    () =>
      Effect.gen(function* () {
        const host = yield* makeDeviceWithSessions;
        const viewer = yield* makeDeviceWithSessions;
        const hostId = yield* connected(host.device, viewer.device);
        const hosted = yield* host.run(Projects.use((projects) => projects.add));
        if (hosted === null) return yield* Effect.die('no Project');
        const api = viewer.device.desktop;
        const remote = onDevice(hostId);

        const settingsLayer = Layer.succeed(Settings, {
          get: Effect.succeed<SettingsValue>({
            language: 'en',
            theme: 'system',
            notifications: true,
            sendMode: 'queue',
            projectOrder: { by: 'lastUsed', direction: 'desc' },
            defaultPermissionMode: 'auto',
            defaultAgent: 'claude',
            autoArchiveDays: null,
            subagents: 'workers',
            crossProjectAccess: [],
            browserAllowedOrigins: [],
            agents: {},
          }),
          update: () => Effect.die('unused'),
          changes: Stream.empty,
        });

        let focused = false;
        const osShown: Array<{ readonly title: string; readonly body: string }> = [];
        const osChannel = makeOsNotificationChannel({
          platform: 'win32',
          systemLanguages: () => ['en-US'],
          isFocused: () => focused,
          focusWindow: () => undefined,
          flashFrame: () => undefined,
          setDockBadge: () => undefined,
          showNotification: ({ title, body }) => {
            osShown.push({ title, body });
          },
        }).pipe(Layer.provideMerge(Layer.mergeAll(settingsLayer, layerTabActivations)));

        const dispatcherLayer = layerNotificationDispatcher.pipe(
          Layer.provideMerge(
            Layer.mergeAll(settingsLayer, layerSessionVisibility, layerWindowFocus, osChannel),
          ),
        );
        const inAppLayer = layerInAppNotificationChannel.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              dispatcherLayer,
              layerInAppNotifications,
              settingsLayer,
              layerWindowFocus,
            ),
          ),
        );
        const appLayer = yield* Layer.build(
          Layer.mergeAll(
            dispatcherLayer,
            inAppLayer,
            layerRemoteNotifier.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(DeviceConnections, viewer.device.deviceConnections),
                  dispatcherLayer,
                ),
              ),
            ),
          ),
        );

        const inAppQueue = yield* Queue.unbounded<SessionNotification>();
        yield* Effect.provide(
          Effect.gen(function* () {
            const inApp = yield* InAppNotifications;
            const focus = yield* WindowFocus;
            const dispatcher = yield* NotificationDispatcher;
            yield* Stream.runForEach(inApp.stream, (n) =>
              Effect.asVoid(Queue.offer(inAppQueue, n)),
            ).pipe(Effect.forkScoped);
            focused = true;
            yield* focus.setFocused(true);
            yield* Effect.yieldNow;
            yield* dispatcher.sync;
          }),
          appLayer,
        );

        const sessionId = yield* remote(api['Session.create']({ projectId: hosted.id }));
        yield* remote(
          api['Session.setOption']({ sessionId, option: 'permissionMode', value: 'ask' }),
        );
        yield* Effect.sleep('200 millis');
        yield* remote(
          api['Session.prompt']({ sessionId, parts: [{ _tag: 'text', text: 'permit' }] }),
        );

        // Focused + off-screen Remote Session -> in-app only, no OS notification.
        const blocked = yield* Queue.take(inAppQueue);
        expect(blocked).toMatchObject({
          device: hostId,
          sessionId,
          projectId: hosted.id,
          cause: 'blocked',
        });
        expect(blocked.turnId).toBeDefined();
        expect(osShown).toEqual([]);

        // Unfocus before answering permission -> turnFinished goes to OS only.
        yield* Effect.provide(
          Effect.gen(function* () {
            const focus = yield* WindowFocus;
            const dispatcher = yield* NotificationDispatcher;
            focused = false;
            yield* focus.setFocused(false);
            yield* Effect.yieldNow;
            yield* dispatcher.sync;
          }),
          appLayer,
        );

        const pending = yield* pendingRequest(api, hostId, sessionId);
        yield* remote(
          api['Session.answerPermission']({ sessionId, requestId: pending.id, optionId: 'allow' }),
        );
        yield* untilTurnEnds(api, hostId, sessionId);
        yield* Effect.provide(
          NotificationDispatcher.use((d) => d.sync),
          appLayer,
        );

        expect(osShown).toHaveLength(1);
        expect(osShown[0]?.body).toBe('Turn finished');
        expect(yield* Queue.clear(inAppQueue)).toEqual([]);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});

type ViewerApi = TestDevice['desktop'];

/** The first pending Permission request the viewer sees in the Session. */
const pendingRequest = (api: ViewerApi, hostId: DeviceId, sessionId: SessionId) =>
  api['Session.events']({ sessionId }).pipe(
    Stream.flatMap((item) =>
      item._tag === 'Transcript' &&
      item.event.item._tag === 'PermissionRequest' &&
      item.event.item.state._tag === 'pending'
        ? Stream.make(item.event.item)
        : Stream.empty,
    ),
    Stream.runHead,
    Effect.flatMap((head) =>
      head._tag === 'Some' ? Effect.succeed(head.value) : Effect.die('no request'),
    ),
    onDevice(hostId),
  );

/** The Session's Transcript as the viewer sees it, up to the end of the Turn. */
const untilTurnEnds = (api: ViewerApi, hostId: DeviceId, sessionId: SessionId) =>
  api['Session.events']({ sessionId }).pipe(
    Stream.takeUntil((item) => item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded'),
    Stream.runCollect,
    onDevice(hostId),
  );
