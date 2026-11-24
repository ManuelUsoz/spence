import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, PubSub, Queue, Stream } from 'effect';
import { DeviceId } from '../../src/shared/devices/devices.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  SessionId,
  type SessionNotification,
  TurnId,
  type LiveState,
  type SessionChange,
} from '../../src/shared/sessions/sessions.rpc';
import type { Settings as SettingsValue } from '../../src/shared/settings/settings.rpc';
import {
  PaneId,
  PanelId,
  TabId,
  type TabActivation,
  type WorkspaceState,
} from '../../src/shared/tabs/tabs.rpc';
import { Settings } from '../settings/settings';
import {
  InAppNotifications,
  layerInAppNotificationChannel,
  layerInAppNotifications,
} from './in-app-notifications';
import {
  layerNotificationDispatcher,
  layerNotifier,
  makeOsNotificationChannel,
  NotificationChannel,
  type NotificationDeliveryContext,
  NotificationDispatcher,
  Notifier,
  type OsNotificationHost,
} from './notifier';
import { layerSessionVisibility, SessionVisibility } from './session-visibility';
import { Sessions, type SessionsShape } from './sessions';
import { layerTabActivations, TabActivations } from './tab-activations';
import { layerWindowFocus, WindowFocus } from './window-focus';

const PROJECT = ProjectId.make('p1');
const PROJECT_2 = ProjectId.make('p2');
const SESSION = SessionId.make('s1');
const SESSION_2 = SessionId.make('s2');

const liveState = (overrides: Partial<LiveState> = {}): LiveState => ({
  agentStatus: 'ready',
  status: 'idle',
  title: { auto: 'Fix login bug', autoIsPlaceholder: false },
  options: { permissionMode: 'auto' },
  commands: [],
  commandsLoaded: true,
  queue: [],
  canAttachImages: false,
  imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
  ...overrides,
});

const baseSettings = (overrides: Partial<SettingsValue> = {}): SettingsValue => ({
  language: 'en',
  theme: 'system',
  notifications: true,
  sendMode: 'queue',
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  subagents: 'workers' as const,
  crossProjectAccess: [],
  browserAllowedOrigins: [],
  agents: {},
  ...overrides,
});

const makeSettingsStub = (initial: SettingsValue) =>
  Layer.effect(
    Settings,
    Effect.gen(function* () {
      let current = initial;
      const bus = yield* PubSub.unbounded<SettingsValue>();
      return Settings.of({
        get: Effect.sync(() => current),
        update: (patch) =>
          Effect.gen(function* () {
            current = {
              ...current,
              ...(patch.notifications === undefined ? {} : { notifications: patch.notifications }),
              ...(patch.language === undefined ? {} : { language: patch.language }),
            };
            yield* PubSub.publish(bus, current);
            return current;
          }),
        changes: Stream.unwrap(
          Effect.gen(function* () {
            const sub = yield* PubSub.subscribe(bus);
            return Stream.concat(Stream.make(current), Stream.fromSubscription(sub));
          }),
        ),
      });
    }),
  );

const singleSessionWorkspace = (options: {
  readonly projectId: ProjectId;
  readonly sessionId: SessionId;
  readonly device?: DeviceId;
}): WorkspaceState => {
  const tabId = TabId.make(`tab-${options.sessionId}`);
  const paneId = PaneId.make(`pane-${options.sessionId}`);
  const panelId = PanelId.make(`panel-${options.sessionId}`);
  return {
    activeProjectId: options.projectId,
    projects: [
      {
        projectId: options.projectId,
        ...(options.device === undefined ? {} : { device: options.device }),
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
                  panels: [
                    { id: panelId, spec: { _tag: 'Session', sessionId: options.sessionId } },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
};

const stubSessions = (changes: Stream.Stream<SessionChange>) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      changes,
      backgroundTabs: Stream.empty,
      list: () => Effect.die('unused'),
      create: () => Effect.die('unused'),
      setAgent: () => Effect.die('unused'),
      agentOf: () => Effect.die('unused'),
      folderOf: () => Effect.die('unused'),
      isDraft: () => Effect.die('unused'),
      setDraftFolder: () => Effect.die('unused'),
      prompt: () => Effect.die('unused'),
      runWorkflow: () => Effect.die('unused'),
      steer: () => Effect.die('unused'),
      enqueue: () => Effect.die('unused'),
      enqueueFrom: () => Effect.die('unused'),
      setQueue: () => Effect.die('unused'),
      clearQueue: () => Effect.die('unused'),
      cancel: () => Effect.die('unused'),
      stopAgent: () => Effect.die('unused'),
      checkExitGate: () => Effect.die('unused'),
      cancelProject: () => Effect.die('unused'),
      rename: () => Effect.die('unused'),
      retryAgent: () => Effect.die('unused'),
      loginAgent: () => Effect.die('unused'),
      archive: () => Effect.die('unused'),
      unarchive: () => Effect.die('unused'),
      remove: () => Effect.die('unused'),
      countWorkers: () => Effect.die('unused'),
      protectedFromAutoArchive: Effect.die('unused'),
      setOption: () => Effect.die('unused'),
      clearContext: () => Effect.die('unused'),
      compact: () => Effect.die('unused'),
      startEmptyContext: () => Effect.die('unused'),
      prepareHandoff: () => Effect.die('unused'),
      revalidateHandoff: () => Effect.die('unused'),
      executeHandoff: () => Effect.die('unused'),
      listHandoffAttempts: () => Effect.die('unused'),
      answerPermission: () => Effect.die('unused'),
      events: () => Stream.die('unused'),
      setTabs: () => Effect.die('unused'),
      restoreTabs: Effect.die('unused'),
      getComposer: () => Effect.die('unused'),
      setComposer: () => Effect.die('unused'),
      attachCrossDeviceTools: () => Effect.die('unused'),
    } satisfies SessionsShape),
  );

const makeHarness = (
  bus: PubSub.PubSub<SessionChange>,
  emitted: Queue.Queue<{
    readonly notification: SessionNotification;
    readonly context: NotificationDeliveryContext | undefined;
  }>,
  initialSettings: SettingsValue = baseSettings(),
) => {
  const baseDeps = Layer.mergeAll(
    makeSettingsStub(initialSettings),
    layerSessionVisibility,
    layerWindowFocus,
    Layer.succeed(
      NotificationChannel,
      NotificationChannel.of({
        notify: (notification, context) =>
          Effect.asVoid(Queue.offer(emitted, { notification, context })),
      }),
    ),
  );
  const dispatcherLayer = layerNotificationDispatcher.pipe(Layer.provideMerge(baseDeps));
  return Layer.mergeAll(
    dispatcherLayer,
    layerNotifier.pipe(
      Layer.provide(Layer.mergeAll(stubSessions(Stream.fromPubSub(bus)), dispatcherLayer)),
    ),
  );
};

describe('Notifier (Worker-thread evaluator)', () => {
  it.effect(
    'emits blocked, error, and turnFinished (done/refused/cutShort) with turnId, ignores duplicates, and skips initial settled baseline',
    () =>
      Effect.gen(function* () {
        const bus = yield* PubSub.unbounded<SessionChange>();
        const emitted = yield* Queue.unbounded<{
          readonly notification: SessionNotification;
          readonly context: NotificationDeliveryContext | undefined;
        }>();

        yield* Effect.gen(function* () {
          const dispatcher = yield* NotificationDispatcher;
          yield* Notifier;
          yield* Effect.yieldNow;

          // Initial settled state on startup/reconnection must NOT fire turnFinished.
          const baselineSession = SessionId.make('baseline');
          yield* PubSub.publish(bus, {
            sessionId: baselineSession,
            projectId: PROJECT,
            state: liveState({
              status: 'idle',
              lastTurn: { turnId: TurnId.make('t-old'), outcome: 'done' },
            }),
          });
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          expect(yield* Queue.clear(emitted)).toEqual([]);

          // Transition into blocked emits once with runningTurn turnId.
          const firstTitle = { auto: 'Fix login bug', autoIsPlaceholder: false };
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({
              status: 'blocked',
              runningTurn: TurnId.make('t1'),
              title: firstTitle,
            }),
          });
          expect((yield* Queue.take(emitted)).notification).toEqual({
            sessionId: SESSION,
            projectId: PROJECT,
            turnId: TurnId.make('t1'),
            cause: 'blocked',
            title: 'Fix login bug',
            sessionTitle: firstTitle,
          });

          // Repeated blocked with same cause does not re-emit.
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({
              status: 'blocked',
              runningTurn: TurnId.make('t1'),
              title: { auto: 'Fix login bug urgently', autoIsPlaceholder: false },
            }),
          });
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          expect(yield* Queue.clear(emitted)).toEqual([]);

          // Switching directly from blocked to error emits error with turnId.
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({
              status: 'error',
              lastTurn: { turnId: TurnId.make('t1'), outcome: 'failed' },
              title: firstTitle,
            }),
          });
          expect((yield* Queue.take(emitted)).notification).toEqual({
            sessionId: SESSION,
            projectId: PROJECT,
            turnId: TurnId.make('t1'),
            cause: 'error',
            title: 'Fix login bug',
            sessionTitle: firstTitle,
          });

          // Clearing to working does not emit; settling done, refused, and cutShort each emit turnFinished once.
          for (const [turnName, outcome] of [
            ['t2', 'done'],
            ['t3', 'refused'],
            ['t4', 'cutShort'],
          ] as const) {
            const tid = TurnId.make(turnName);
            yield* PubSub.publish(bus, {
              sessionId: SESSION,
              projectId: PROJECT,
              state: liveState({ status: 'working', runningTurn: tid, title: firstTitle }),
            });
            yield* PubSub.publish(bus, {
              sessionId: SESSION,
              projectId: PROJECT,
              state: liveState({
                status: 'idle',
                lastTurn: { turnId: tid, outcome },
                title: firstTitle,
              }),
            });
            expect((yield* Queue.take(emitted)).notification).toEqual({
              sessionId: SESSION,
              projectId: PROJECT,
              turnId: tid,
              cause: 'turnFinished',
              title: 'Fix login bug',
              sessionTitle: firstTitle,
            });
            // Non-status live update keeping same lastTurn must not re-emit turnFinished.
            yield* PubSub.publish(bus, {
              sessionId: SESSION,
              projectId: PROJECT,
              state: liveState({
                status: 'idle',
                lastTurn: { turnId: tid, outcome },
                title: { auto: 'Renamed', autoIsPlaceholder: false },
              }),
            });
            yield* Effect.yieldNow;
            yield* dispatcher.sync;
            expect(yield* Queue.clear(emitted)).toEqual([]);
          }

          // Placeholder title resolves to empty string in notification.title, and turnId is omitted when absent.
          const placeholderTitle = { auto: '', autoIsPlaceholder: true };
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({ status: 'error', title: placeholderTitle }),
          });
          expect((yield* Queue.take(emitted)).notification).toEqual({
            sessionId: SESSION,
            projectId: PROJECT,
            cause: 'error',
            title: '',
            sessionTitle: placeholderTitle,
          });
        }).pipe(Effect.provide(makeHarness(bus, emitted)));
      }),
  );

  it.effect(
    'suppresses cancelled Turns, completed Compactions, archived Sessions, disabled settings, and Worker turnFinished while keeping Worker blocked/error',
    () =>
      Effect.gen(function* () {
        const bus = yield* PubSub.unbounded<SessionChange>();
        const emitted = yield* Queue.unbounded<{
          readonly notification: SessionNotification;
          readonly context: NotificationDeliveryContext | undefined;
        }>();

        yield* Effect.gen(function* () {
          const dispatcher = yield* NotificationDispatcher;
          const settings = yield* Settings;
          yield* Notifier;
          yield* Effect.yieldNow;

          // 1. User-cancelled Turn suppresses notification.
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({ status: 'working', runningTurn: TurnId.make('t-cancel') }),
          });
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({
              status: 'idle',
              lastTurn: { turnId: TurnId.make('t-cancel'), outcome: 'cancelled' },
            }),
          });

          // 2. Completed Compaction (working -> idle without a new lastTurn) suppresses notification.
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({
              status: 'working',
              compacting: true,
              lastTurn: { turnId: TurnId.make('t-cancel'), outcome: 'cancelled' },
            }),
          });
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({
              status: 'idle',
              lastTurn: { turnId: TurnId.make('t-cancel'), outcome: 'cancelled' },
            }),
          });

          // 3. Archived Session suppresses notification even if lastTurn or status is present.
          const archivedId = SessionId.make('archived-s');
          yield* PubSub.publish(bus, {
            sessionId: archivedId,
            projectId: PROJECT,
            state: liveState({ status: 'working', runningTurn: TurnId.make('t-arch') }),
          });
          yield* PubSub.publish(bus, {
            sessionId: archivedId,
            projectId: PROJECT,
            state: liveState({
              status: 'idle',
              archived: true,
              lastTurn: { turnId: TurnId.make('t-arch'), outcome: 'done' },
            }),
          });

          // 4. Worker Session suppresses turnFinished, but still notifies on blocked and error.
          const workerId = SessionId.make('worker-1');
          yield* PubSub.publish(bus, {
            sessionId: workerId,
            projectId: PROJECT,
            state: liveState({
              parentSessionId: SESSION,
              status: 'working',
              runningTurn: TurnId.make('wt-1'),
            }),
          });
          yield* PubSub.publish(bus, {
            sessionId: workerId,
            projectId: PROJECT,
            state: liveState({
              parentSessionId: SESSION,
              status: 'idle',
              lastTurn: { turnId: TurnId.make('wt-1'), outcome: 'done' },
            }),
          });
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          expect(yield* Queue.clear(emitted)).toEqual([]);

          yield* PubSub.publish(bus, {
            sessionId: workerId,
            projectId: PROJECT,
            state: liveState({
              parentSessionId: SESSION,
              status: 'blocked',
              runningTurn: TurnId.make('wt-2'),
            }),
          });
          expect((yield* Queue.take(emitted)).notification.cause).toBe('blocked');

          yield* PubSub.publish(bus, {
            sessionId: workerId,
            projectId: PROJECT,
            state: liveState({
              parentSessionId: SESSION,
              status: 'error',
              lastTurn: { turnId: TurnId.make('wt-2'), outcome: 'failed' },
            }),
          });
          expect((yield* Queue.take(emitted)).notification.cause).toBe('error');

          // 5. Disabled settings.notifications suppresses notifications and does not replay on re-enable.
          yield* settings.update({ notifications: false });
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          yield* PubSub.publish(bus, {
            sessionId: SESSION_2,
            projectId: PROJECT,
            state: liveState({ status: 'blocked', runningTurn: TurnId.make('t-muted') }),
          });
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          expect(yield* Queue.clear(emitted)).toEqual([]);

          yield* settings.update({ notifications: true });
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          expect(yield* Queue.clear(emitted)).toEqual([]);
        }).pipe(Effect.provide(makeHarness(bus, emitted)));
      }),
  );

  it.effect(
    'suppresses focused visible Sessions across Local and Remote Projects, respects overlays/Settings, and fans out to pluggable channels',
    () =>
      Effect.gen(function* () {
        const bus = yield* PubSub.unbounded<SessionChange>();
        const emitted = yield* Queue.unbounded<{
          readonly notification: SessionNotification;
          readonly context: NotificationDeliveryContext | undefined;
        }>();
        const extraChannelEvents = yield* Queue.unbounded<{
          readonly notification: SessionNotification;
          readonly context: NotificationDeliveryContext | undefined;
        }>();

        yield* Effect.gen(function* () {
          const dispatcher = yield* NotificationDispatcher;
          const visibility = yield* SessionVisibility;
          const focus = yield* WindowFocus;
          yield* Notifier;

          // Register a second pluggable channel (e.g., future voice / toast channel).
          yield* dispatcher.registerChannel({
            notify: (notification, context) =>
              Effect.asVoid(Queue.offer(extraChannelEvents, { notification, context })),
          });

          // Window is focused and s1 is visible -> suppressed for all channels.
          yield* focus.setFocused(true);
          yield* visibility.setWorkspace(
            singleSessionWorkspace({ projectId: PROJECT, sessionId: SESSION }),
          );
          yield* Effect.yieldNow;
          yield* dispatcher.sync;

          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({ status: 'blocked', runningTurn: TurnId.make('t-vis') }),
          });
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          expect(yield* Queue.clear(emitted)).toEqual([]);
          expect(yield* Queue.clear(extraChannelEvents)).toEqual([]);

          // Full-Tab overlay or global Settings view obscures s1 -> s1 notifies with windowFocused: true!
          yield* visibility.setObscured(true);
          yield* Effect.yieldNow;
          yield* dispatcher.sync;

          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({
              status: 'error',
              lastTurn: { turnId: TurnId.make('t-vis'), outcome: 'failed' },
            }),
          });
          const first = yield* Queue.take(emitted);
          expect(first.notification.cause).toBe('error');
          expect(first.context).toEqual({ windowFocused: true });
          expect((yield* Queue.take(extraChannelEvents)).notification.cause).toBe('error');

          // Unobscured Remote Session visible in active Tab while focused -> suppressed.
          const studio = DeviceId.make('studio');
          yield* visibility.setWorkspace(
            singleSessionWorkspace({ projectId: PROJECT_2, sessionId: SESSION_2, device: studio }),
            false,
          );
          yield* Effect.yieldNow;
          yield* dispatcher.sync;

          const remoteFiber = yield* dispatcher
            .observe(
              Stream.make({
                sessionId: SESSION_2,
                projectId: PROJECT_2,
                state: liveState({ status: 'blocked', runningTurn: TurnId.make('t-rem') }),
              }),
              studio,
            )
            .pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          expect(yield* Queue.clear(emitted)).toEqual([]);

          // Unfocused window -> visible Local session DOES notify with windowFocused: false.
          yield* focus.setFocused(false);
          yield* visibility.setWorkspace(
            singleSessionWorkspace({ projectId: PROJECT, sessionId: SESSION }),
            false,
          );
          yield* Effect.yieldNow;
          yield* dispatcher.sync;

          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({ status: 'blocked', runningTurn: TurnId.make('t-unfocused') }),
          });
          const unfocused = yield* Queue.take(emitted);
          expect(unfocused.notification.cause).toBe('blocked');
          expect(unfocused.context).toEqual({ windowFocused: false });
          void remoteFiber;
        }).pipe(Effect.provide(makeHarness(bus, emitted)));
      }),
  );
});

describe('makeOsNotificationChannel', () => {
  const runChannel = (
    settings: SettingsValue,
    hostOverrides: Partial<OsNotificationHost>,
    notification: SessionNotification,
    env?: Readonly<Record<string, string | undefined>>,
    deliveryContext?: NotificationDeliveryContext,
  ) =>
    Effect.gen(function* () {
      const shown: Array<{
        readonly title: string;
        readonly body: string;
        readonly onClick: () => void;
      }> = [];
      let focusedCount = 0;
      let flashCount = 0;
      const badges: string[] = [];

      const host: OsNotificationHost = {
        platform: 'win32',
        systemLanguages: () => ['en-US'],
        isFocused: () => false,
        focusWindow: () => {
          focusedCount += 1;
        },
        flashFrame: () => {
          flashCount += 1;
        },
        setDockBadge: (badge) => {
          badges.push(badge);
        },
        showNotification: (options) => {
          shown.push(options);
        },
        ...hostOverrides,
      };

      const layer = makeOsNotificationChannel(host, env).pipe(
        Layer.provideMerge(Layer.mergeAll(makeSettingsStub(settings), layerTabActivations)),
      );

      const activations: TabActivation[] = [];
      yield* Effect.gen(function* () {
        const channel = yield* NotificationChannel;
        const tabActivations = yield* TabActivations;
        const queue = yield* Queue.unbounded<TabActivation>();
        yield* Stream.runForEach(tabActivations.stream, (item) =>
          Effect.asVoid(Queue.offer(queue, item)),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        yield* channel.notify(notification, deliveryContext);
        for (const entry of shown) entry.onClick();
        yield* Effect.yieldNow;
        activations.push(...(yield* Queue.clear(queue)));
      }).pipe(Effect.provide(layer));

      return { shown, focusedCount, flashCount, badges, activations };
    });

  const fixTitle = { auto: 'Fix bug', autoIsPlaceholder: false } as const;
  const blankTitle = { auto: '', autoIsPlaceholder: true } as const;

  it.effect('mutes notifications when Settings.notifications is false or window is focused', () =>
    Effect.gen(function* () {
      const disabled = yield* runChannel(
        baseSettings({ notifications: false }),
        {},
        {
          sessionId: SESSION,
          projectId: PROJECT,
          cause: 'blocked',
          title: 'Fix bug',
          sessionTitle: fixTitle,
        },
      );
      expect(disabled.shown).toEqual([]);
      expect(disabled.flashCount).toBe(0);

      const focusedByHost = yield* runChannel(
        baseSettings({ notifications: true }),
        { isFocused: () => true },
        {
          sessionId: SESSION,
          projectId: PROJECT,
          cause: 'blocked',
          title: 'Fix bug',
          sessionTitle: fixTitle,
        },
      );
      expect(focusedByHost.shown).toEqual([]);
      expect(focusedByHost.flashCount).toBe(0);

      const focusedByContext = yield* runChannel(
        baseSettings({ notifications: true }),
        { isFocused: () => false },
        {
          sessionId: SESSION,
          projectId: PROJECT,
          cause: 'turnFinished',
          title: 'Fix bug',
          sessionTitle: fixTitle,
        },
        undefined,
        { windowFocused: true },
      );
      expect(focusedByContext.shown).toEqual([]);
    }),
  );

  it.effect(
    'localizes all 3 causes in EN and ES, flashes/badges only on blocked, and includes turnId in TabActivation',
    () =>
      Effect.gen(function* () {
        const t1 = TurnId.make('t1');
        const t2 = TurnId.make('t2');
        const winBlocked = yield* runChannel(
          baseSettings({ language: 'en' }),
          { platform: 'win32', isFocused: () => false },
          {
            sessionId: SESSION,
            projectId: PROJECT,
            turnId: t1,
            cause: 'blocked',
            title: 'Fix bug',
            sessionTitle: fixTitle,
          },
        );
        expect(winBlocked.shown).toHaveLength(1);
        expect(winBlocked.shown[0]?.title).toBe('Fix bug');
        expect(winBlocked.shown[0]?.body).toBe('Waiting for your answer');
        expect(winBlocked.flashCount).toBe(1);
        expect(winBlocked.badges).toEqual([]);
        expect(winBlocked.focusedCount).toBe(1);
        expect(winBlocked.activations).toEqual([
          { sessionId: SESSION, projectId: PROJECT, title: fixTitle, turnId: t1 },
        ]);

        const winFinished = yield* runChannel(
          baseSettings({ language: 'en' }),
          { platform: 'win32', isFocused: () => false },
          {
            sessionId: SESSION,
            projectId: PROJECT,
            turnId: t2,
            cause: 'turnFinished',
            title: 'Fix bug',
            sessionTitle: fixTitle,
          },
        );
        expect(winFinished.shown[0]?.body).toBe('Turn finished');
        expect(winFinished.flashCount).toBe(0);
        expect(winFinished.activations).toEqual([
          { sessionId: SESSION, projectId: PROJECT, title: fixTitle, turnId: t2 },
        ]);

        const esFinished = yield* runChannel(
          baseSettings({ language: 'es' }),
          { platform: 'darwin', isFocused: () => false },
          {
            sessionId: SESSION,
            projectId: PROJECT,
            turnId: t2,
            cause: 'turnFinished',
            title: '',
            sessionTitle: blankTitle,
          },
        );
        expect(esFinished.shown[0]?.title).toBe('Nueva Sesión');
        expect(esFinished.shown[0]?.body).toBe('Turno finalizado');
        expect(esFinished.badges).toEqual([]);

        const macError = yield* runChannel(
          baseSettings({ language: 'es' }),
          { platform: 'darwin', isFocused: () => false },
          {
            sessionId: SESSION,
            projectId: PROJECT,
            cause: 'error',
            title: '',
            sessionTitle: blankTitle,
          },
        );
        expect(macError.shown[0]?.title).toBe('Nueva Sesión');
        expect(macError.shown[0]?.body).toBe('Se detuvo con un error');
        expect(macError.flashCount).toBe(0);
        expect(macError.badges).toEqual([]);

        const macBlocked = yield* runChannel(
          baseSettings({ language: 'en' }),
          { platform: 'darwin', isFocused: () => false },
          {
            sessionId: SESSION,
            projectId: PROJECT,
            cause: 'blocked',
            title: 'Fix bug',
            sessionTitle: fixTitle,
          },
        );
        expect(macBlocked.badges).toEqual(['•']);
      }),
  );

  it.effect('pins notification locale from e2eLocale during e2e runs', () =>
    Effect.gen(function* () {
      const pinnedEs = yield* runChannel(
        baseSettings({ language: 'system' }),
        { systemLanguages: () => ['en-US'] },
        {
          sessionId: SESSION,
          projectId: PROJECT,
          cause: 'blocked',
          title: '',
          sessionTitle: blankTitle,
        },
        { SPENCE_E2E: '1', SPENCE_LOCALE: 'es' },
      );
      expect(pinnedEs.shown[0]?.title).toBe('Nueva Sesión');
      expect(pinnedEs.shown[0]?.body).toBe('Esperando tu respuesta');

      const nonE2e = yield* runChannel(
        baseSettings({ language: 'system' }),
        { systemLanguages: () => ['en-US'] },
        {
          sessionId: SESSION,
          projectId: PROJECT,
          cause: 'blocked',
          title: '',
          sessionTitle: blankTitle,
        },
        { SPENCE_LOCALE: 'es' },
      );
      expect(nonE2e.shown[0]?.title).toBe('New Session');
      expect(nonE2e.shown[0]?.body).toBe('Waiting for your answer');
    }),
  );

  it.effect(
    'clicking OS notifications from Notifier emits TabActivation with { sessionId, projectId, title, turnId } across Projects',
    () =>
      Effect.gen(function* () {
        const bus = yield* PubSub.unbounded<SessionChange>();
        const shownQueue = yield* Queue.unbounded<{
          readonly title: string;
          readonly body: string;
          readonly onClick: () => void;
        }>();
        const s2 = SessionId.make('s2');

        const host: OsNotificationHost = {
          platform: 'win32',
          systemLanguages: () => ['en-US'],
          isFocused: () => false,
          focusWindow: () => undefined,
          flashFrame: () => undefined,
          setDockBadge: () => undefined,
          showNotification: (options) => {
            Queue.offerUnsafe(shownQueue, options);
          },
        };

        const settingsLayer = makeSettingsStub(baseSettings({ language: 'en' }));
        const channelLayer = makeOsNotificationChannel(host).pipe(
          Layer.provideMerge(Layer.mergeAll(settingsLayer, layerTabActivations)),
        );
        const dispatcherLayer = layerNotificationDispatcher.pipe(
          Layer.provideMerge(
            Layer.mergeAll(settingsLayer, layerSessionVisibility, layerWindowFocus, channelLayer),
          ),
        );

        const appLayer = Layer.mergeAll(
          channelLayer,
          dispatcherLayer,
          layerNotifier.pipe(
            Layer.provide(Layer.mergeAll(stubSessions(Stream.fromPubSub(bus)), dispatcherLayer)),
          ),
        );

        yield* Effect.gen(function* () {
          yield* Notifier;
          const tabActivations = yield* TabActivations;
          const received = yield* Queue.unbounded<TabActivation>();
          yield* Stream.runForEach(tabActivations.stream, (item) =>
            Effect.asVoid(Queue.offer(received, item)),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          const title1 = { auto: 'Build app', autoIsPlaceholder: false };
          const title2 = { user: 'Fix API auth', autoIsPlaceholder: false };
          const turn1 = TurnId.make('turn-1');
          const turn2 = TurnId.make('turn-2');
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({ status: 'blocked', runningTurn: turn1, title: title1 }),
          });
          yield* PubSub.publish(bus, {
            sessionId: s2,
            projectId: PROJECT_2,
            state: liveState({
              status: 'error',
              lastTurn: { turnId: turn2, outcome: 'failed' },
              title: title2,
            }),
          });

          const firstShown = yield* Queue.take(shownQueue);
          const secondShown = yield* Queue.take(shownQueue);
          // Click the second Project's notification first, then the first Project's.
          secondShown.onClick();
          firstShown.onClick();
          yield* Effect.yieldNow;

          expect(yield* Queue.take(received)).toEqual({
            sessionId: s2,
            projectId: PROJECT_2,
            title: title2,
            turnId: turn2,
          });
          expect(yield* Queue.take(received)).toEqual({
            sessionId: SESSION,
            projectId: PROJECT,
            title: title1,
            turnId: turn1,
          });
        }).pipe(Effect.provide(appLayer));
      }),
  );
});

describe('InAppNotifications channel routing', () => {
  it.effect(
    'routes solely to InAppNotifications when focused and off-screen, solely to OS when unfocused, and mutes both when visible or disabled',
    () =>
      Effect.gen(function* () {
        const bus = yield* PubSub.unbounded<SessionChange>();
        const settingsLayer = makeSettingsStub(baseSettings({ language: 'en' }));

        let focused = false;
        const shown: Array<{ readonly title: string; readonly body: string }> = [];
        const host: OsNotificationHost = {
          platform: 'win32',
          systemLanguages: () => ['en-US'],
          isFocused: () => focused,
          focusWindow: () => undefined,
          flashFrame: () => undefined,
          setDockBadge: () => undefined,
          showNotification: ({ title, body }) => {
            shown.push({ title, body });
          },
        };

        const osChannelLayer = makeOsNotificationChannel(host).pipe(
          Layer.provideMerge(Layer.mergeAll(settingsLayer, layerTabActivations)),
        );
        const dispatcherLayer = layerNotificationDispatcher.pipe(
          Layer.provideMerge(
            Layer.mergeAll(settingsLayer, layerSessionVisibility, layerWindowFocus, osChannelLayer),
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
        const appLayer = Layer.mergeAll(
          dispatcherLayer,
          inAppLayer,
          layerNotifier.pipe(
            Layer.provide(Layer.mergeAll(stubSessions(Stream.fromPubSub(bus)), dispatcherLayer)),
          ),
        );

        yield* Effect.gen(function* () {
          yield* Notifier;
          const dispatcher = yield* NotificationDispatcher;
          const focus = yield* WindowFocus;
          const visibility = yield* SessionVisibility;
          const inApp = yield* InAppNotifications;

          const received = yield* Queue.unbounded<SessionNotification>();
          yield* Stream.runForEach(inApp.stream, (item) =>
            Effect.asVoid(Queue.offer(received, item)),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          // 1. Focused + Session in background (not visible) -> in-app only, no OS banner.
          focused = true;
          yield* focus.setFocused(true);
          yield* visibility.setWorkspace(
            singleSessionWorkspace({ projectId: PROJECT, sessionId: SESSION }),
            false,
          );
          yield* Effect.yieldNow;
          yield* dispatcher.sync;

          const turn1 = TurnId.make('t1');
          yield* PubSub.publish(bus, {
            sessionId: SESSION_2,
            projectId: PROJECT_2,
            state: liveState({
              status: 'blocked',
              runningTurn: turn1,
              title: { auto: 'Background task', autoIsPlaceholder: false },
            }),
          });

          const inAppBlocked = yield* Queue.take(received);
          expect(inAppBlocked).toMatchObject({
            sessionId: SESSION_2,
            projectId: PROJECT_2,
            turnId: turn1,
            cause: 'blocked',
            title: 'Background task',
          });
          expect(shown).toEqual([]);

          // 2. Focused + Session visible in active Tab -> muted on both channels.
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({
              status: 'error',
              lastTurn: { turnId: TurnId.make('t-vis'), outcome: 'failed' },
            }),
          });
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          expect(shown).toEqual([]);
          expect(yield* Queue.clear(received)).toEqual([]);

          // 3. Unfocused -> OS banner only, nothing on in-app stream.
          focused = false;
          yield* focus.setFocused(false);
          yield* Effect.yieldNow;
          yield* dispatcher.sync;

          const turn2 = TurnId.make('t2');
          yield* PubSub.publish(bus, {
            sessionId: SESSION_2,
            projectId: PROJECT_2,
            state: liveState({
              status: 'idle',
              lastTurn: { turnId: turn2, outcome: 'done' },
              title: { auto: 'Background task', autoIsPlaceholder: false },
            }),
          });
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          expect(shown).toEqual([{ title: 'Background task', body: 'Turn finished' }]);
          expect(yield* Queue.clear(received)).toEqual([]);

          // 4. Settings.notifications = false while focused -> muted on both channels.
          focused = true;
          yield* focus.setFocused(true);
          yield* Settings.use((settings) => settings.update({ notifications: false }));
          yield* Effect.yieldNow;
          yield* dispatcher.sync;

          yield* PubSub.publish(bus, {
            sessionId: SESSION_2,
            projectId: PROJECT_2,
            state: liveState({
              status: 'error',
              lastTurn: { turnId: TurnId.make('t3'), outcome: 'failed' },
            }),
          });
          yield* Effect.yieldNow;
          yield* dispatcher.sync;
          expect(shown).toEqual([{ title: 'Background task', body: 'Turn finished' }]);
          expect(yield* Queue.clear(received)).toEqual([]);
        }).pipe(Effect.provide(appLayer));
      }),
  );
});
