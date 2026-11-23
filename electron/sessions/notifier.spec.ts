import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, PubSub, Queue, Stream } from 'effect';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  SessionId,
  TurnId,
  type LiveState,
  type SessionChange,
} from '../../src/shared/sessions/sessions.rpc';
import type { Settings as SettingsValue } from '../../src/shared/settings/settings.rpc';
import type { TabActivation } from '../../src/shared/tabs/tabs.rpc';
import { Settings } from '../settings/settings';
import {
  layerNotifier,
  makeOsNotificationChannel,
  NotificationChannel,
  Notifier,
  type AttentionNotification,
  type OsNotificationHost,
} from './notifier';
import { Sessions, type SessionsShape } from './sessions';
import { layerTabActivations, TabActivations } from './tab-activations';

const PROJECT = ProjectId.make('p1');
const SESSION = SessionId.make('s1');

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

describe('Notifier', () => {
  it.effect(
    'emits once when a Session gains Attention, ignores duplicates, and re-emits after clear or cause switch',
    () =>
      Effect.gen(function* () {
        const bus = yield* PubSub.unbounded<SessionChange>();
        const emitted = yield* Queue.unbounded<AttentionNotification>();

        const layer = layerNotifier.pipe(
          Layer.provide(
            Layer.mergeAll(
              stubSessions(Stream.fromPubSub(bus)),
              Layer.succeed(
                NotificationChannel,
                NotificationChannel.of({
                  notify: (notification) => Effect.asVoid(Queue.offer(emitted, notification)),
                }),
              ),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          yield* Notifier;
          yield* Effect.yieldNow;

          // First transition into blocked emits once.
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
          expect(yield* Queue.take(emitted)).toEqual({
            sessionId: SESSION,
            projectId: PROJECT,
            cause: 'blocked',
            title: 'Fix login bug',
            sessionTitle: firstTitle,
          });

          // Repeated change with same cause does not re-emit.
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
          expect(yield* Queue.clear(emitted)).toEqual([]);

          // Switching directly from blocked to error emits error.
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({ status: 'error', title: firstTitle }),
          });
          expect(yield* Queue.take(emitted)).toEqual({
            sessionId: SESSION,
            projectId: PROJECT,
            cause: 'error',
            title: 'Fix login bug',
            sessionTitle: firstTitle,
          });

          // Clearing to working or idle does not emit, and gaining error again re-emits.
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({ status: 'working' }),
          });
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({ status: 'idle' }),
          });
          yield* Effect.yieldNow;
          expect(yield* Queue.clear(emitted)).toEqual([]);

          const placeholderTitle = { auto: '', autoIsPlaceholder: true };
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({ status: 'error', title: placeholderTitle }),
          });
          expect(yield* Queue.take(emitted)).toEqual({
            sessionId: SESSION,
            projectId: PROJECT,
            cause: 'error',
            title: '',
            sessionTitle: placeholderTitle,
          });
        }).pipe(Effect.provide(layer));
      }),
  );
});

describe('makeOsNotificationChannel', () => {
  const runChannel = (
    settings: SettingsValue,
    hostOverrides: Partial<OsNotificationHost>,
    notification: AttentionNotification,
    env?: Readonly<Record<string, string | undefined>>,
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
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(
              Settings,
              Settings.of({ get: Effect.succeed(settings), update: () => Effect.die('unused') }),
            ),
            layerTabActivations,
          ),
        ),
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

        yield* channel.notify(notification);
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

      const focused = yield* runChannel(
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
      expect(focused.shown).toEqual([]);
      expect(focused.flashCount).toBe(0);
    }),
  );

  it.effect(
    'shows notification, flashes/badges only on blocked, and activates Session on click',
    () =>
      Effect.gen(function* () {
        const winNeedsAnswer = yield* runChannel(
          baseSettings({ language: 'en' }),
          { platform: 'win32', isFocused: () => false },
          {
            sessionId: SESSION,
            projectId: PROJECT,
            cause: 'blocked',
            title: 'Fix bug',
            sessionTitle: fixTitle,
          },
        );
        expect(winNeedsAnswer.shown).toHaveLength(1);
        expect(winNeedsAnswer.shown[0]?.title).toBe('Fix bug');
        expect(winNeedsAnswer.shown[0]?.body).toBe('Waiting for your answer');
        expect(winNeedsAnswer.flashCount).toBe(1);
        expect(winNeedsAnswer.badges).toEqual([]);
        expect(winNeedsAnswer.focusedCount).toBe(1);
        expect(winNeedsAnswer.activations).toEqual([
          { sessionId: SESSION, projectId: PROJECT, title: fixTitle },
        ]);

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

        const macNeedsAnswer = yield* runChannel(
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
        expect(macNeedsAnswer.badges).toEqual(['•']);
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
    'clicking OS notifications from Notifier emits TabActivation with { sessionId, projectId, title } across Projects',
    () =>
      Effect.gen(function* () {
        const bus = yield* PubSub.unbounded<SessionChange>();
        const shown: Array<{
          readonly title: string;
          readonly body: string;
          readonly onClick: () => void;
        }> = [];
        const p2 = ProjectId.make('p2');
        const s2 = SessionId.make('s2');

        const host: OsNotificationHost = {
          platform: 'win32',
          systemLanguages: () => ['en-US'],
          isFocused: () => false,
          focusWindow: () => undefined,
          flashFrame: () => undefined,
          setDockBadge: () => undefined,
          showNotification: (options) => {
            shown.push(options);
          },
        };

        const channelLayer = makeOsNotificationChannel(host).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(
                Settings,
                Settings.of({
                  get: Effect.succeed(baseSettings({ language: 'en' })),
                  update: () => Effect.die('unused'),
                }),
              ),
              layerTabActivations,
            ),
          ),
        );

        const appLayer = Layer.mergeAll(
          channelLayer,
          layerNotifier.pipe(
            Layer.provide(Layer.mergeAll(stubSessions(Stream.fromPubSub(bus)), channelLayer)),
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
          yield* PubSub.publish(bus, {
            sessionId: SESSION,
            projectId: PROJECT,
            state: liveState({ status: 'blocked', title: title1 }),
          });
          yield* PubSub.publish(bus, {
            sessionId: s2,
            projectId: p2,
            state: liveState({ status: 'error', title: title2 }),
          });
          yield* Effect.yieldNow;

          expect(shown).toHaveLength(2);
          // Click the second Project's notification first, then the first Project's.
          shown[1]?.onClick();
          shown[0]?.onClick();
          yield* Effect.yieldNow;

          expect(yield* Queue.take(received)).toEqual({
            sessionId: s2,
            projectId: p2,
            title: title2,
          });
          expect(yield* Queue.take(received)).toEqual({
            sessionId: SESSION,
            projectId: PROJECT,
            title: title1,
          });
        }).pipe(Effect.provide(appLayer));
      }),
  );
});
