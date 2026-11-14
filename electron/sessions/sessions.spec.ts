import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Option, Schedule, Stream } from 'effect';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import type {
  LiveState,
  SessionId,
  SessionStreamItem,
  TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';
import { fakeEntry, installFakeAgent, layerAcpClientWithFakeAgent } from '../acp/acpFakes';
import { AgentLifetime, layerAgentLifetime } from '../acp/acpLifetime';
import { AcpClient } from '../acp/acpSessionManager';
import type { CatalogEntry } from '../agents/catalog';
import { FolderPicker, Folders } from '../projects/folders';
import { layerProjects, Projects } from '../projects/projects';
import { layerRemembered, type Remembered } from '../settings/remembered';
import { layerSettings, Settings, WindowSettings } from '../settings/settings';
import { layerStore, makeStore, Store, type StoreShape } from '../store/store';
import { AGENT_DELETES_FILE, layerDeleteQueue } from './delete-queue';
import { layerSessionStore, SessionStore } from './session-store';
import { AgentCatalog, makeAgentCatalog } from './session-agent';
import { layerSessions, Sessions } from './sessions';

/** Spawning node through a shim and a real ACP handshake take longer than the default 5 s on a cold machine. */
const TIMEOUT = 30_000;

const PROJECT_FOLDER = process.cwd();

/** Sessions over a fresh store, one Project on `PROJECT_FOLDER`, and the fake Agent as the Sessions' Agent. */
const withSessionsCustom = <A, E>(
  options: {
    readonly wrapStore?: (store: StoreShape) => StoreShape;
    readonly agentArgs?: ReadonlyArray<string>;
    readonly catalog?: ReadonlyArray<CatalogEntry>;
    readonly fallbackAgentId?: AgentId;
  },
  body: (
    project: ProjectId,
    install: { readonly bin: string; readonly logs: string },
  ) => Effect.Effect<
    A,
    E,
    Sessions | Projects | AgentLifetime | AcpClient | SessionStore | Store | Settings | Remembered
  >,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sessions-'))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    const install = yield* installFakeAgent;
    const store =
      options.wrapStore === undefined
        ? layerStore(root)
        : Layer.succeed(Store, options.wrapStore(makeStore(root)));
    const sessionStore = layerSessionStore.pipe(Layer.provide(store));
    const projects = layerProjects.pipe(
      Layer.provide(sessionStore),
      Layer.provide(store),
      Layer.provide(
        Layer.succeed(Folders, {
          platform: process.platform,
          realPath: (folder) => Effect.succeed(Option.some(folder)),
          exists: () => Effect.succeed(true),
        }),
      ),
      Layer.provide(
        Layer.succeed(FolderPicker, { pick: Effect.succeed(Option.some(PROJECT_FOLDER)) }),
      ),
    );
    const remembered = layerRemembered.pipe(Layer.provide(store));
    const settings = layerSettings.pipe(
      Layer.provide(remembered),
      Layer.provide(
        Layer.succeed(WindowSettings, {
          applyTheme: () => Effect.void,
          applyLanguage: () => Effect.void,
        }),
      ),
      Layer.provide(store),
    );
    const acpClient = layerAcpClientWithFakeAgent(install);
    const deleteQueue = layerDeleteQueue.pipe(Layer.provide(Layer.mergeAll(store, acpClient)));
    const entries = options.catalog ?? [fakeEntry(options.agentArgs)];
    const fallbackId = options.fallbackAgentId ?? entries[0]?.id ?? fakeEntry().id;
    const layer = layerSessions.pipe(
      Layer.provideMerge(projects),
      Layer.provideMerge(sessionStore),
      Layer.provideMerge(remembered),
      Layer.provideMerge(deleteQueue),
      Layer.provideMerge(store),
      Layer.provideMerge(settings),
      Layer.provideMerge(layerAgentLifetime.pipe(Layer.provideMerge(acpClient))),
      Layer.provide(Layer.succeed(AgentCatalog, makeAgentCatalog(entries, fallbackId))),
    );
    return yield* Effect.gen(function* () {
      const project = yield* Projects.use((p) => p.add);
      if (project === null) return yield* Effect.die('the picker answered nothing');
      return yield* body(project.id, install);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

const withSessions = <A, E>(
  body: (
    project: ProjectId,
  ) => Effect.Effect<A, E, Sessions | Projects | AgentLifetime | AcpClient | SessionStore | Store>,
  wrapStore?: (store: StoreShape) => StoreShape,
) => withSessionsCustom(wrapStore === undefined ? {} : { wrapStore }, (project) => body(project));

const text = (value: string) => [{ _tag: 'text' as const, text: value }];

const isTurnEnd = (item: SessionStreamItem) =>
  item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded';

/** The Transcript items of a stream, up to and including the first Turn end. */
const untilTurnEnd = <E, R>(events: Stream.Stream<SessionStreamItem, E, R>) =>
  events.pipe(
    Stream.takeUntil(isTurnEnd),
    Stream.runCollect,
    Effect.map((items) => [...items]),
  );

const transcript = (items: ReadonlyArray<SessionStreamItem>): ReadonlyArray<TranscriptItem> =>
  items.flatMap((item) => (item._tag === 'Transcript' ? [item.event.item] : []));

/** The agent's reply text in a list of Transcript items. */
const agentReply = (items: ReadonlyArray<TranscriptItem>) =>
  items
    .map((item) => {
      if (item._tag === 'MessageDelta') return item.text;
      if (item._tag === 'Message' && item.role === 'agent') {
        return item.parts.map((part) => (part._tag === 'text' ? part.text : '')).join('');
      }
      return '';
    })
    .join('');

const events = (id: SessionId, afterSeq?: number) =>
  Stream.unwrap(Sessions.use((s) => Effect.succeed(s.events(id, afterSeq))));

const seqs = (items: ReadonlyArray<SessionStreamItem>) =>
  items.flatMap((item) => (item._tag === 'Transcript' ? [item.event.seq] : []));

/** Waits until the Agent's reply has started. */
const agentAnswering = (id: SessionId) =>
  events(id).pipe(
    Stream.filter(
      (item) =>
        item._tag === 'Transcript' &&
        item.event.item._tag === 'Message' &&
        item.event.item.role === 'agent',
    ),
    Stream.runHead,
  );

/** Waits until the Session's Agent status is `status`. */
const agentStatus = (id: SessionId, status: LiveState['agentStatus']) =>
  events(id).pipe(
    Stream.filter((item) => item._tag === 'Live' && item.state.agentStatus === status),
    Stream.runHead,
  );

/** The first live state that satisfies `ready`. */
const liveState = (id: SessionId, ready: (state: LiveState) => boolean) =>
  events(id).pipe(
    Stream.flatMap((item) =>
      item._tag === 'Live' && ready(item.state) ? Stream.make(item.state) : Stream.empty,
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

describe('Sessions with the fake Agent', () => {
  it.live(
    'records an image-only first Message as an image title',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, [{ _tag: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]);
          yield* untilTurnEnd(events(id));
          expect(yield* store.get(id)).toMatchObject({
            autoTitleImageCount: 1,
            autoTitleIsPlaceholder: true,
          });

          const second = yield* sessions.create(project);
          yield* sessions.prompt(second, [
            { _tag: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
            { _tag: 'image', mimeType: 'image/png', data: 'd29ybGQ=' },
          ]);
          yield* untilTurnEnd(events(second));
          expect(yield* store.get(second)).toMatchObject({
            autoTitleImageCount: 2,
            autoTitleIsPlaceholder: true,
          });
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'marks every Session as needing login when a prompt requires authentication',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const first = yield* sessions.create(project);
          const second = yield* sessions.create(project);
          yield* agentStatus(first, 'ready');
          yield* agentStatus(second, 'ready');
          yield* sessions.prompt(first, text('login'));
          const end = yield* untilTurnEnd(events(first));
          expect(transcript(end)).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: expect.objectContaining({ _tag: 'failed', reason: 'needsLogin' }),
            }),
          );
          yield* agentStatus(first, 'needsLogin');
          yield* agentStatus(second, 'needsLogin');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'keeps the user title while the Agent replaces its automatic title',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.rename(id, 'Mine');
          yield* sessions.prompt(id, text('title:Agent title'));
          yield* untilTurnEnd(events(id));
          expect(yield* store.get(id)).toMatchObject({
            userTitle: 'Mine',
            autoTitle: 'Agent title',
            autoTitleIsPlaceholder: false,
          });
          yield* sessions.rename(id, '');
          expect((yield* liveState(id, (state) => state.title.user === undefined)).title.auto).toBe(
            'Agent title',
          );
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'renames a Session and restores its automatic title when cleared',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('echo:Hello'));
          yield* untilTurnEnd(events(id));
          yield* sessions.rename(id, 'Mine');
          expect((yield* store.get(id)).userTitle).toBe('Mine');
          yield* sessions.rename(id, '');
          expect((yield* store.get(id)).userTitle).toBeUndefined();
          expect((yield* store.get(id)).autoTitle).toBe('echo:Hello');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'uses the first Message as the automatic title after the first Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('echo:Hello   there\nsecond line'));
          yield* untilTurnEnd(events(id));
          expect((yield* store.get(id)).autoTitle).toBe('echo:Hello there');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'replaces the automatic title on session_info_update after Clear without adding Transcript items',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('echo:Initial prompt'));
          const first = yield* untilTurnEnd(events(id));
          expect((yield* store.get(id)).autoTitle).toBe('echo:Initial prompt');

          yield* sessions.clearContext(id);
          yield* sessions.prompt(id, text('title:After clear'));
          const second = yield* untilTurnEnd(events(id, seqs(first).at(-1)));
          expect(yield* store.get(id)).toMatchObject({
            autoTitle: 'After clear',
            autoTitleIsPlaceholder: false,
          });

          const countBeforeRename = second.filter((item) => item._tag === 'Transcript').length;
          yield* sessions.rename(id, 'User title');
          yield* sessions.rename(id, '');
          const afterRename = yield* untilTurnEnd(events(id, seqs(first).at(-1)));
          expect(afterRename.filter((item) => item._tag === 'Transcript')).toHaveLength(
            countBeforeRename,
          );
          expect((yield* store.get(id)).autoTitle).toBe('After clear');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'creates a Session while tab state is being saved',
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let pause = false;
        let readingState = false;
        let paused = false;
        yield* withSessions(
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              pause = true;
              const creating = yield* Effect.forkChild(sessions.create(project));
              yield* Deferred.await(reading);
              const saving = yield* Effect.forkChild(sessions.setTabs([], undefined));
              yield* Effect.sleep('50 millis');
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(saving);
              const id = yield* Fiber.join(creating);
              expect(id).toBeDefined();
            }),
          (store) => ({
            ...store,
            readVersioned: (spec) =>
              Effect.suspend(() =>
                spec.file !== 'state.json' || !pause || paused
                  ? store.readVersioned(spec)
                  : Effect.gen(function* () {
                      paused = true;
                      readingState = true;
                      yield* Deferred.succeed(reading, undefined);
                      yield* Deferred.await(release);
                      const value = yield* store.readVersioned(spec);
                      readingState = false;
                      return value;
                    }),
              ),
            writeVersioned: (spec, value) =>
              spec.file === 'state.json' && readingState
                ? Effect.die('Windows cannot replace state.json during a read')
                : store.writeVersioned(spec, value),
          }),
        );
      }),
    TIMEOUT,
  );

  it.live(
    'streams a prompt as Message deltas and ends the Turn done',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const turnId = yield* sessions.prompt(id, text('echo:Hello there'));
          const items = yield* untilTurnEnd(events(id));

          expect(items[0]?._tag).toBe('Live');
          const kept = transcript(items);
          expect(kept[0]).toMatchObject({ _tag: 'TurnStarted', turnId });
          expect(kept[1]).toMatchObject({
            _tag: 'Message',
            role: 'user',
            parts: text('echo:Hello there'),
          });
          expect(kept.filter((item) => item._tag === 'MessageDelta').length).toBeGreaterThan(0);
          expect(agentReply(kept)).toBe('Hello there');
          expect(kept.at(-1)).toEqual({ _tag: 'TurnEnded', turnId, outcome: { _tag: 'done' } });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'cancel asks the Agent to stop, and the Turn ends cancelled',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const turnId = yield* sessions.prompt(id, text('hold'));
          yield* agentAnswering(id);
          const working = AgentLifetime.use((lifetime) => lifetime.working);
          expect(yield* working).toBe(1);

          yield* sessions.cancel(id);

          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept.at(-1)).toEqual({
            _tag: 'TurnEnded',
            turnId,
            outcome: { _tag: 'cancelled' },
          });
          // The Turn no longer holds the ACP session open.
          expect(yield* working).toBe(0);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a stopped Turn ends its running Step cancelled, with files relative to the Project',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          // `busy` leaves a command running until the cancel.
          yield* sessions.prompt(id, text('busy'));
          yield* events(id).pipe(
            Stream.filter(
              (item) =>
                item._tag === 'Transcript' &&
                item.event.item._tag === 'Step' &&
                item.event.item.kind === 'execute',
            ),
            Stream.runHead,
          );

          yield* sessions.cancel(id);

          const kept = transcript(yield* untilTurnEnd(events(id)));
          const steps = kept.flatMap((item) => (item._tag === 'Step' ? [item] : []));
          expect(steps.at(-1)).toMatchObject({ kind: 'execute', status: 'cancelled' });
          expect(steps[0]).toMatchObject({ kind: 'read', files: ['src/view.ts'] });
          expect(kept.at(-1)).toMatchObject({ _tag: 'TurnEnded', outcome: { _tag: 'cancelled' } });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'refuses a second prompt Busy while a Turn runs; cancel does nothing when idle',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.cancel(id);
          const runningTurn = yield* sessions.prompt(id, text('hold'));
          const snapshot = yield* events(id).pipe(Stream.runHead);
          expect(Option.getOrUndefined(snapshot)).toMatchObject({ state: { runningTurn } });

          const second = yield* sessions.prompt(id, text('echo:again')).pipe(Effect.flip);
          expect(second.reason).toBe('Busy');

          yield* agentAnswering(id);
          yield* sessions.cancel(id);
          const lastSeq = seqs(yield* untilTurnEnd(events(id))).at(-1);
          // The Turn is over: the next prompt runs.
          yield* sessions.prompt(id, text('echo:again'));
          expect(agentReply(transcript(yield* untilTurnEnd(events(id, lastSeq))))).toBe('again');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a resubscription with afterSeq continues where the last one stopped, with no event twice',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('echo:first'));
          const before = yield* untilTurnEnd(events(id));

          // The renderer reloads: its stream is gone, and the new one asks for what came after.
          yield* sessions.prompt(id, text('echo:second'));
          const after = yield* untilTurnEnd(events(id, seqs(before).at(-1)));

          expect(after[0]?._tag).toBe('Live');
          const all = [...seqs(before), ...seqs(after)];
          expect(all).toEqual(all.map((_, index) => index + 1));
          expect(agentReply(transcript(after))).toBe('second');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'follows a new Session from the start, before its Agent is up, through its first Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          // The renderer subscribes as soon as the Tab shows, while the Agent is still starting.
          const following = yield* untilTurnEnd(events(id)).pipe(Effect.forkChild);
          yield* sessions.prompt(id, text('echo:early'));

          const items = yield* Fiber.join(following);
          expect(items[0]).toMatchObject({ _tag: 'Live', state: { agentStatus: 'starting' } });
          expect(agentReply(transcript(items))).toBe('early');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a Stop while the Agent is still starting ends the Turn cancelled',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          // `hold` never ends on its own: only a cancel the Agent sees ends it.
          const prompting = yield* sessions.prompt(id, text('hold')).pipe(Effect.forkChild);
          const working = AgentLifetime.use((lifetime) => lifetime.working);
          yield* working.pipe(
            Effect.repeat({ until: (count) => count === 1, schedule: Schedule.spaced('5 millis') }),
          );
          const live = yield* events(id).pipe(Stream.runHead);
          expect(Option.getOrUndefined(live)).toMatchObject({ state: { agentStatus: 'starting' } });

          yield* sessions.cancel(id);

          const turnId = yield* Fiber.join(prompting);
          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept.at(-1)).toEqual({
            _tag: 'TurnEnded',
            turnId,
            outcome: { _tag: 'cancelled' },
          });
          expect(yield* working).toBe(0);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a draft whose Agent restarted before its first prompt keeps nothing but that prompt',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* agentStatus(id, 'ready');
          yield* AcpClient.use((client) => client.disconnect(fakeEntry().id));
          const afterDisconnect = yield* liveState(id, (state) => state.agentStatus === 'ready');
          expect(afterDisconnect.agentStatus).toBe('ready');

          const turnId = yield* sessions.prompt(id, text('echo:first'));

          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept[0]).toMatchObject({ _tag: 'TurnStarted', turnId });
          expect(kept.some((item) => item._tag === 'ContextCleared')).toBe(false);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'shows the Agent Model, Effort and Commands, and a set option is what the next Turn runs with',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const ready = yield* liveState(
            id,
            (state) => state.agentStatus === 'ready' && state.commands.length > 0,
          );
          expect(ready.options.model).toEqual({
            value: 'small',
            choices: [
              { id: 'small', name: 'Small' },
              { id: 'large', name: 'Large' },
            ],
          });
          // The fake Agent has no `max`: the level is not offered.
          expect(ready.options.effort).toEqual({
            value: 'medium',
            choices: ['low', 'medium', 'high'],
          });
          // Spence's Clear replaces the Agent's `/clear`.
          expect(ready.commands.map((command) => command.name)).toEqual(['compact', 'review']);

          yield* sessions.setOption({ sessionId: id, option: 'effort', value: 'high' });
          yield* sessions.setOption({ sessionId: id, option: 'model', value: 'large' });
          const set = yield* liveState(id, (state) => state.options.model?.value === 'large');
          expect(set.options.effort?.value).toBe('high');

          const turnId = yield* sessions.prompt(id, text('echo:hi'));
          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept[0]).toEqual({
            _tag: 'TurnStarted',
            turnId,
            model: 'large',
            effort: 'high',
            permissionMode: 'auto',
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a new Session starts on the options last used with the Agent',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const first = yield* sessions.create(project);
          yield* liveState(first, (state) => state.agentStatus === 'ready');
          yield* sessions.setOption({ sessionId: first, option: 'model', value: 'large' });
          yield* sessions.setOption({ sessionId: first, option: 'effort', value: 'low' });

          const second = yield* sessions.create(project);
          const ready = yield* liveState(second, (state) => state.agentStatus === 'ready');
          expect(ready.options.model?.value).toBe('large');
          expect(ready.options.effort?.value).toBe('low');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'Clear starts a fresh ACP session with the same options and marks it in the Transcript',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');
          yield* sessions.setOption({ sessionId: id, option: 'effort', value: 'high' });
          yield* sessions.prompt(id, text('echo:before'));
          const lastSeq = seqs(yield* untilTurnEnd(events(id))).at(-1);

          yield* sessions.clearContext(id);

          const meta = yield* SessionStore.use((store) => store.meta(id));
          expect(meta.acpSessionIds).toHaveLength(2);
          expect(meta.acpSessionIds[1]).not.toBe(meta.acpSessionIds[0]);
          const after = yield* events(id, lastSeq).pipe(Stream.take(2), Stream.runCollect);
          expect(transcript([...after])).toEqual([{ _tag: 'ContextCleared', reason: 'cleared' }]);
          const live = [...after][0];
          expect(live?._tag === 'Live' && live.state.options.effort?.value).toBe('high');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'refuses Clear Busy while a Turn runs',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('hold'));
          yield* agentAnswering(id);
          const error = yield* sessions.clearContext(id).pipe(Effect.flip);
          expect(error.reason).toBe('Busy');
          yield* sessions.cancel(id);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'does not create a Session in an unknown Project',
    () =>
      withSessions(() =>
        Effect.gen(function* () {
          const error = yield* Sessions.use((s) => s.create(ProjectId.make('nope'))).pipe(
            Effect.flip,
          );
          expect(error.reason).toBe('NotFound');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'fails only running Sessions with agentStopped and stderr tail on crash; idle Sessions stay ready and resume on next prompt',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const crashing = yield* sessions.create(project);
          const idle = yield* sessions.create(project);
          yield* agentStatus(crashing, 'ready');
          yield* agentStatus(idle, 'ready');
          // Give `idle` a prior Turn so its next prompt after the crash resumes cleanly.
          yield* sessions.prompt(idle, text('echo:before'));
          const beforeEnd = yield* untilTurnEnd(events(idle));
          const afterSeq = seqs(beforeEnd).at(-1);

          const crashTurn = yield* sessions.prompt(crashing, text('crash'));
          const crashedEnd = yield* untilTurnEnd(events(crashing));
          const crashedOutcome = transcript(crashedEnd).find(
            (item): item is Extract<TranscriptItem, { _tag: 'TurnEnded' }> =>
              item._tag === 'TurnEnded' && item.turnId === crashTurn,
          )?.outcome;
          expect(crashedOutcome).toMatchObject({ _tag: 'failed', reason: 'agentStopped' });
          if (crashedOutcome?._tag === 'failed') {
            expect(crashedOutcome.detail).toContain('exit code 3');
            expect(crashedOutcome.detail).toMatch(/fake agent \d+ up/);
          }
          yield* agentStatus(crashing, 'stopped');

          // The idle Session never transitions to `stopped` and handles the next prompt cleanly.
          const idleLive = yield* events(idle, afterSeq).pipe(Stream.runHead);
          expect(Option.getOrUndefined(idleLive)).toMatchObject({
            _tag: 'Live',
            state: { agentStatus: 'ready' },
          });
          yield* sessions.prompt(idle, text('echo:after'));
          const resumed = transcript(yield* untilTurnEnd(events(idle, afterSeq)));
          expect(agentReply(resumed)).toBe('after');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'publishes agentId, agentPackage and terminal authMethods in LiveState',
    () =>
      withSessionsCustom({ agentArgs: ['--extra-auth'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const ready = yield* liveState(id, (state) => state.agentStatus === 'ready');
          expect(ready.agentId).toBe(fakeEntry().id);
          expect(ready.agentPackage).toBe(fakeEntry().package);
          expect(ready.cantStartReason).toBeUndefined();
          expect(ready.authMethods).toEqual([
            {
              id: 'login',
              name: 'Log in with Browser',
              description: 'Open browser to log in',
              command: 'fake-agent --extra-auth --login-mode',
            },
            {
              id: 'api-key',
              name: 'API Key',
              description: 'Use an API key',
              command: 'fake-agent --extra-auth --login-key',
            },
          ]);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'marks cantStart with cantStartReason protocolVersion when the Agent speaks ACP 2',
    () =>
      withSessionsCustom({ agentArgs: ['--protocol=2'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const state = yield* liveState(id, (next) => next.agentStatus === 'cantStart');
          expect(state.cantStartReason).toBe('protocolVersion');
          expect(state.agentPackage).toBe(fakeEntry().package);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'marks cantStart with cantStartReason spawn when the Agent exits during initialize',
    () =>
      withSessionsCustom({ agentArgs: ['--fail-init'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const state = yield* liveState(id, (next) => next.agentStatus === 'cantStart');
          expect(state.cantStartReason).toBe('spawn');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'marks notInstalled when the Agent binary vanishes from PATH before spawn',
    () =>
      withSessionsCustom({}, (project, install) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          yield* Effect.promise(() => rm(install.bin, { recursive: true, force: true }));
          const id = yield* sessions.create(project);
          const state = yield* liveState(id, (next) => next.agentStatus === 'notInstalled');
          expect(state.agentId).toBe(fakeEntry().id);
          expect(state.agentPackage).toBe(fakeEntry().package);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'surfaces -32603 as failed agentError with verbatim detail and keeps agentStatus ready',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* agentStatus(id, 'ready');
          const turnId = yield* sessions.prompt(id, text('error'));
          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept.at(-1)).toEqual({
            _tag: 'TurnEnded',
            turnId,
            outcome: { _tag: 'failed', reason: 'agentError', detail: 'API Error: overloaded' },
          });
          const live = yield* events(id).pipe(Stream.runHead);
          expect(Option.getOrUndefined(live)).toMatchObject({
            _tag: 'Live',
            state: { agentStatus: 'ready' },
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'loginAgent runs the first authMethod, disconnects the Agent, and restores every open Session to ready without sending anything',
    () =>
      withSessionsCustom({ agentArgs: ['--extra-auth'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const first = yield* sessions.create(project);
          const second = yield* sessions.create(project);
          yield* agentStatus(first, 'ready');
          yield* agentStatus(second, 'ready');

          yield* sessions.prompt(first, text('login'));
          const loginEnd = yield* untilTurnEnd(events(first));
          const afterSeqFirst = seqs(loginEnd).at(-1);
          yield* agentStatus(first, 'needsLogin');
          yield* agentStatus(second, 'needsLogin');
          // A Session opened while the Agent needs login also starts in needsLogin.
          const late = yield* sessions.create(project);
          yield* agentStatus(late, 'needsLogin');

          yield* sessions.loginAgent(first);

          yield* agentStatus(first, 'ready');
          yield* agentStatus(second, 'ready');
          yield* agentStatus(late, 'ready');
          // Nothing was sent automatically after login completed.
          const after = yield* events(first, afterSeqFirst).pipe(Stream.take(1), Stream.runCollect);
          expect(transcript([...after])).toEqual([]);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'interrupting loginAgent kills the login process and leaves the Session in needsLogin',
    () =>
      withSessionsCustom({ agentArgs: ['--extra-auth', '--login-hold'] }, (project, install) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* agentStatus(id, 'ready');
          yield* sessions.prompt(id, text('login'));
          yield* untilTurnEnd(events(id));
          yield* agentStatus(id, 'needsLogin');

          const fiber = yield* Effect.forkChild(sessions.loginAgent(id));
          // Wait until the login child process writes to stderr (recorded in fake.log).
          yield* Effect.promise(async () => {
            const logPath = path.join(install.logs, 'fake.log');
            for (let i = 0; i < 50; i++) {
              const content = await readFile(logPath, 'utf8').catch(() => '');
              if (content.includes('login waiting')) return;
              await new Promise((r) => setTimeout(r, 50));
            }
          });
          yield* Fiber.interrupt(fiber);

          const live = yield* events(id).pipe(Stream.runHead);
          expect(Option.getOrUndefined(live)).toMatchObject({
            _tag: 'Live',
            state: { agentStatus: 'needsLogin' },
          });
        }),
      ),
    TIMEOUT,
  );
});

/** Waits for the Session's first Permission request in `state`. */
const permissionRequest = (id: SessionId, state: 'pending' | 'answered' | 'cancelled') =>
  events(id).pipe(
    Stream.map((item) =>
      item._tag === 'Transcript' &&
      item.event.item._tag === 'PermissionRequest' &&
      item.event.item.state._tag === state
        ? item.event.item
        : undefined,
    ),
    Stream.filter((request) => request !== undefined),
    Stream.runHead,
    Effect.flatMap((head) =>
      Option.match(head, {
        onNone: () => Effect.die('the stream ended before the request'),
        onSome: Effect.succeed,
      }),
    ),
  );

const permissionRequests = (items: ReadonlyArray<TranscriptItem>) =>
  items.filter((item) => item._tag === 'PermissionRequest');

describe('Permission requests and the Permission mode', () => {
  it.live(
    'a failed Turn calls for attention until the next Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('crash'));
          yield* untilTurnEnd(events(id));
          expect((yield* liveState(id, () => true)).attention).toBe('error');
          expect(
            (yield* sessions.list(project)).find((session) => session.id === id)?.attention,
          ).toBe('error');
          yield* sessions.prompt(id, text('echo:recovered'));
          yield* untilTurnEnd(events(id));
          expect((yield* liveState(id, () => true)).attention).toBeUndefined();
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'a pending Permission request calls for attention until answered',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          const change = yield* sessions.changes.pipe(
            Stream.filter(
              (item) => item.sessionId === id && item.state.attention === 'needsAnswer',
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* sessions.prompt(id, text('permit'));
          const pending = yield* permissionRequest(id, 'pending');
          expect((yield* liveState(id, () => true)).attention).toBe('needsAnswer');
          expect(Option.getOrUndefined(yield* Fiber.join(change))).toMatchObject({
            projectId: project,
            sessionId: id,
          });
          expect(
            (yield* sessions.list(project)).find((session) => session.id === id),
          ).toMatchObject({
            attention: 'needsAnswer',
            running: true,
          });
          const cleared = yield* Effect.forkChild(
            liveState(id, (state) => state.attention === undefined),
          );
          yield* sessions.answerPermission(id, pending.id, 'allow');
          expect((yield* liveState(id, () => true)).attention).toBeUndefined();
          expect((yield* Fiber.join(cleared)).attention).toBeUndefined();
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'in Ask a request waits for the user, whose answer reaches the Agent and is recorded by user',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(id, text('permit'));
          const pending = yield* permissionRequest(id, 'pending');
          expect(pending.options.map((option) => option.kind)).toEqual([
            'rejectOnce',
            'allowAlways',
            'allowOnce',
          ]);

          yield* sessions.answerPermission(id, pending.id, 'always');

          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept).toContainEqual(
            expect.objectContaining({ _tag: 'Step', id: pending.stepId, title: 'ls -la' }),
          );
          expect(permissionRequests(kept).at(-1)).toEqual({
            ...pending,
            state: { _tag: 'answered', optionId: 'always', by: 'user' },
          });
          expect(agentReply(kept)).toBe('permission always');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'an answer to a request no longer pending does nothing',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(id, text('permit'));
          const pending = yield* permissionRequest(id, 'pending');

          yield* sessions.answerPermission(id, pending.id, 'allow');
          yield* sessions.answerPermission(id, pending.id, 'reject');

          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(permissionRequests(kept).map((request) => request.state)).toEqual([
            { _tag: 'pending' },
            { _tag: 'answered', optionId: 'allow', by: 'user' },
          ]);
          expect(agentReply(kept)).toBe('permission allow');
          // After the Turn, too.
          yield* sessions.answerPermission(id, pending.id, 'reject');
          expect(permissionRequests(transcript(yield* untilTurnEnd(events(id))))).toHaveLength(2);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'cancelling the Turn answers its pending request cancelled, toward the Agent and in the Transcript',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          const turnId = yield* sessions.prompt(id, text('ask'));
          const pending = yield* permissionRequest(id, 'pending');

          yield* sessions.cancel(id);

          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(permissionRequests(kept).at(-1)).toEqual({
            ...pending,
            state: { _tag: 'cancelled' },
          });
          expect(agentReply(kept)).toBe('permission cancelled');
          expect(kept.at(-1)).toEqual({
            _tag: 'TurnEnded',
            turnId,
            outcome: { _tag: 'cancelled' },
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'in Auto, for an Agent without its own auto mode, main answers allow once, recorded by policy',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          // Settings start new Sessions in Auto.
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('permit'));

          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(permissionRequests(kept).map((request) => request.state)).toEqual([
            { _tag: 'answered', optionId: 'allow', by: 'policy' },
          ]);
          expect(agentReply(kept)).toBe('permission allow');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'the Permission mode is set on the Agent and carried by the live state',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('mode'));
          const first = yield* untilTurnEnd(events(id));
          expect(agentReply(transcript(first))).toBe('acceptEdits');

          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          const live = yield* events(id).pipe(Stream.runHead);
          expect(Option.getOrUndefined(live)).toMatchObject({
            state: { options: { permissionMode: 'ask' } },
          });

          yield* sessions.prompt(id, text('mode'));
          const second = transcript(yield* untilTurnEnd(events(id, seqs(first).at(-1))));
          expect(second[0]).toMatchObject({ _tag: 'TurnStarted', permissionMode: 'ask' });
          expect(agentReply(second)).toBe('default');
        }),
      ),
    TIMEOUT,
  );

  describe('Archive and Delete', () => {
    it.live(
      'archive cancels a running Turn (pending Permission becomes cancelled), sets archivedAt, closes its Tab, and prompt unarchives it',
      () =>
        withSessions((project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const store = yield* SessionStore;
            const id = yield* sessions.create(project);
            yield* sessions.setTabs([id], id);
            yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });

            const collecting = yield* untilTurnEnd(events(id)).pipe(Effect.forkChild);
            const turnId = yield* sessions.prompt(id, text('ask'));
            const pending = yield* permissionRequest(id, 'pending');

            yield* sessions.archive(id);

            const firstItems = yield* Fiber.join(collecting);
            const kept = transcript(firstItems);
            expect(permissionRequests(kept).at(-1)).toEqual({
              ...pending,
              state: { _tag: 'cancelled' },
            });
            expect(kept.at(-1)).toEqual({
              _tag: 'TurnEnded',
              turnId,
              outcome: { _tag: 'cancelled' },
            });

            const listed = yield* store.list(project);
            expect(listed.find((s) => s.id === id)?.archivedAt).toBeTypeOf('number');
            expect((yield* sessions.restoreTabs).tabs.some((tab) => tab.id === id)).toBe(false);

            // Unarchive explicitly clears archivedAt.
            yield* sessions.unarchive(id);
            expect(
              (yield* store.list(project)).find((s) => s.id === id)?.archivedAt,
            ).toBeUndefined();

            // Re-archive, then sending a prompt unarchives it automatically.
            yield* sessions.archive(id);
            expect((yield* store.list(project)).find((s) => s.id === id)?.archivedAt).toBeTypeOf(
              'number',
            );
            yield* sessions.prompt(id, text('echo:back'));
            yield* untilTurnEnd(events(id, seqs(firstItems).at(-1)));
            expect(
              (yield* store.list(project)).find((s) => s.id === id)?.archivedAt,
            ).toBeUndefined();
          }),
        ),
      TIMEOUT,
    );

    it.live(
      'delete removes a kept Session (cancelling a running Turn) and queues ACP deletes when offline, draining on next initialize',
      () =>
        withSessions((project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const storeService = yield* SessionStore;
            const store = yield* Store;

            // 1. Delete while Agent is running & a Turn is running.
            const s1 = yield* sessions.create(project);
            yield* sessions.setTabs([s1], s1);
            yield* sessions.prompt(s1, text('hold'));
            const working = AgentLifetime.use((lifetime) => lifetime.working);
            yield* working.pipe(
              Effect.repeat({
                until: (count) => count === 1,
                schedule: Schedule.spaced('5 millis'),
              }),
            );

            yield* sessions.remove(s1);
            expect(yield* working).toBe(0);
            expect(yield* storeService.list(project)).toEqual([]);
            expect(yield* store.listDir('sessions')).toEqual([]);
            expect(yield* store.listDir('')).not.toContain(AGENT_DELETES_FILE);

            // 2. Delete while Agent is disconnected -> queued in agent-deletes.json, then drained on next initialize.
            const s2 = yield* sessions.create(project);
            yield* sessions.prompt(s2, text('echo:hi'));
            yield* untilTurnEnd(events(s2));
            const s2AcpIds = (yield* storeService.get(s2)).acpSessionIds;
            expect(s2AcpIds.length).toBeGreaterThan(0);

            yield* AcpClient.use((client) => client.disconnect(fakeEntry().id));
            yield* sessions.remove(s2);

            expect(yield* storeService.list(project)).toEqual([]);
            expect(yield* store.listDir('sessions')).toEqual([]);
            expect(yield* store.listDir('')).toContain(AGENT_DELETES_FILE);

            // Reconnect Agent by starting another Session -> DeleteQueue drains in background.
            const s3 = yield* sessions.create(project);
            yield* sessions.prompt(s3, text('echo:wake'));
            yield* untilTurnEnd(events(s3));
            // Give background drain fiber a moment to finish writing empty agent-deletes.json.
            yield* Effect.gen(function* () {
              for (let i = 0; i < 40; i += 1) {
                const raw = yield* Effect.tryPromise(() =>
                  import('node:fs/promises').then((fs) =>
                    fs.readFile(path.join(store.root, AGENT_DELETES_FILE), 'utf8'),
                  ),
                );
                const parsed = JSON.parse(raw) as { items: Array<unknown> };
                if (parsed.items.length === 0) return;
                yield* Effect.sleep('25 millis');
              }
            });
            const rawAfter = yield* Effect.tryPromise(() =>
              import('node:fs/promises').then((fs) =>
                fs.readFile(path.join(store.root, AGENT_DELETES_FILE), 'utf8'),
              ),
            );
            expect((JSON.parse(rawAfter) as { items: Array<unknown> }).items).toEqual([]);
          }),
        ),
      TIMEOUT,
    );
  });

  it.live(
    'cancelProject cancels running Turns only in the given Project',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('hold'));
          yield* agentAnswering(id);

          // Cancelling a different Project leaves this Turn running.
          yield* sessions.cancelProject(ProjectId.make('other'));
          const listedBefore = yield* sessions.list(project);
          expect(listedBefore.find((s) => s.id === id)?.running).toBe(true);

          yield* sessions.cancelProject(project);
          const ended = transcript(yield* untilTurnEnd(events(id)));
          expect(ended.at(-1)).toMatchObject({
            _tag: 'TurnEnded',
            outcome: { _tag: 'cancelled' },
          });
          const listedAfter = yield* sessions.list(project);
          expect(listedAfter.find((s) => s.id === id)?.running).toBeUndefined();
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'restoreTabs preserves attention on kept Tabs and marks unprompted in-memory drafts',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const kept = yield* sessions.create(project);
          yield* sessions.prompt(kept, text('crash'));
          yield* untilTurnEnd(events(kept));

          const draft = yield* sessions.create(project);
          yield* sessions.setTabs([kept, draft], draft);

          const restored = yield* sessions.restoreTabs;
          expect(restored.active).toBe(draft);
          expect(restored.tabs).toMatchObject([
            {
              id: kept,
              projectId: project,
              attention: 'error',
            },
            {
              id: draft,
              projectId: project,
              draft: true,
            },
          ]);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'getComposer / setComposer stores unsent text and images until the Tab closes',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.setTabs([id], id);

          expect(yield* sessions.getComposer(id)).toEqual({ text: '', images: [] });

          const draft = {
            text: 'unsent note',
            images: [{ name: 'pic.png', mimeType: 'image/png', data: 'AQID' }],
          };
          yield* sessions.setComposer(id, draft);
          expect(yield* sessions.getComposer(id)).toEqual(draft);

          // Closing the Tab drops its remembered Composer draft.
          yield* sessions.setTabs([], undefined);
          expect(yield* sessions.getComposer(id)).toEqual({ text: '', images: [] });
        }),
      ),
    TIMEOUT,
  );

  describe('Multi-Agent admission, qualification, capabilities, and draft selection', () => {
    const claudeFake = fakeEntry([], { id: AgentId.make('claude'), name: 'Claude' });
    const codexFake = fakeEntry([], {
      id: AgentId.make('codex'),
      name: 'Codex',
      package: '@agentclientprotocol/codex-acp',
      binary: 'fake-agent',
    });
    const agyFake = fakeEntry(['--no-ask', '--ineligible-models'], {
      id: AgentId.make('antigravity'),
      name: 'Antigravity',
      installKind: 'native',
      package: '',
      binary: 'fake-agent',
      installInstructions: 'Install Antigravity from https://antigravity.google/download',
      permissionModes: {
        auto: { agentMode: 'acceptEdits', autoAllow: true },
      },
      capabilities: {
        models: true,
        effort: false,
        images: true,
        askMode: false,
        resume: true,
        contextUsage: true,
        supportsCompaction: false,
        supportsIsolatedSummary: false,
        modelChangePreservesContext: true,
      },
      filterModels: (models) => {
        const eligible = models.filter(
          (model) => !model.id.startsWith('claude-') && !model.id.startsWith('gpt-'),
        );
        return {
          models: eligible,
          ...(eligible.length < models.length
            ? { excludedNote: 'Third-party models require an eligible subscription.' }
            : {}),
        };
      },
    });

    it.live(
      'resolves Default Agent (pinned, lastUsed from state.json, and draft Session.setAgent)',
      () =>
        withSessionsCustom(
          { catalog: [claudeFake, codexFake, agyFake], fallbackAgentId: claudeFake.id },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const settingsService = yield* Settings;

              // Default is claude; unsent draft starts as draft with claude.
              const first = yield* sessions.create(project);
              const firstState = yield* liveState(first, (next) => next.agentStatus === 'ready');
              expect(firstState.agentId).toBe(claudeFake.id);
              expect(firstState.isDraft).toBe(true);

              // Draft Session.setAgent switches to codex without leaving a draft behind.
              yield* sessions.setAgent(first, codexFake.id);
              const switched = yield* liveState(
                first,
                (next) => next.agentId === codexFake.id && next.agentStatus === 'ready',
              );
              expect(switched.agentName).toBe('Codex');
              expect(switched.isDraft).toBe(true);

              // Sending a Turn marks the session kept (isDraft false), remembers codex, and blocks setAgent.
              yield* sessions.prompt(first, text('echo:hi'));
              yield* untilTurnEnd(events(first));
              const keptState = yield* liveState(first, (next) => next.isDraft === false);
              expect(keptState.isDraft).toBe(false);
              const setErr = yield* sessions.setAgent(first, claudeFake.id).pipe(Effect.flip);
              expect(setErr.reason).toBe('Busy');

              // Default Agent 'lastUsed' resolves to codex from state.json.
              yield* settingsService.update({ defaultAgent: 'lastUsed' });
              const fromLastUsed = yield* sessions.create(project);
              const lastUsedState = yield* liveState(
                fromLastUsed,
                (next) => next.agentStatus === 'ready',
              );
              expect(lastUsedState.agentId).toBe(codexFake.id);

              // Pinned Default Agent overrides lastUsed.
              yield* settingsService.update({ defaultAgent: agyFake.id });
              const pinned = yield* sessions.create(project);
              const pinnedState = yield* liveState(pinned, (next) => next.agentStatus === 'ready');
              expect(pinnedState.agentId).toBe(agyFake.id);
            }),
        ),
      TIMEOUT,
    );

    it.live(
      'surfaces unverified versions with upgrade notice while still running, and unsupported admission gates as cantStart',
      () =>
        withSessionsCustom(
          {
            catalog: [
              fakeEntry(['--version=0.9.0'], {
                id: AgentId.make('claude'),
                name: 'Claude',
                upgradeCommand: 'npm install -g @zed-industries/claude-agent-acp@1.0.0',
              }),
              fakeEntry(['--no-auto'], {
                id: AgentId.make('codex'),
                name: 'Codex',
              }),
            ],
            fallbackAgentId: AgentId.make('claude'),
          },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const unverified = yield* sessions.create(project);
              const ready = yield* liveState(unverified, (next) => next.agentStatus === 'ready');
              expect(ready.installedVersion).toBe('0.9.0');
              expect(ready.versionQualification).toBe('unverified');
              expect(ready.upgradeCommand).toBe(
                'npm install -g @zed-industries/claude-agent-acp@1.0.0',
              );

              // Unverified Agent still runs Prompts normally.
              yield* sessions.prompt(unverified, text('echo:works'));
              const ended = transcript(yield* untilTurnEnd(events(unverified)));
              expect(agentReply(ended)).toBe('works');

              // Agent missing Auto admission gate fails with cantStartReason 'unsupported'.
              const blocked = yield* sessions.create(project, AgentId.make('codex'));
              const cantStart = yield* liveState(
                blocked,
                (next) => next.agentStatus === 'cantStart',
              );
              expect(cantStart.cantStartReason).toBe('unsupported');
              expect(cantStart.cantStartDetail).toContain('Auto');
            }),
        ),
      TIMEOUT,
    );

    it.live(
      'degrades capabilities (askMode false forces Auto, autoAllow leaves non-allowOnce to user, filters ineligible models without substituting pin)',
      () =>
        withSessionsCustom(
          { catalog: [agyFake, claudeFake], fallbackAgentId: agyFake.id },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const settingsService = yield* Settings;
              yield* settingsService.update({
                defaultAgent: agyFake.id,
                defaultPermissionMode: 'ask',
                agents: { [agyFake.id]: { model: 'claude-sonnet-4' } },
              });

              const id = yield* sessions.create(project);
              const state = yield* liveState(id, (next) => next.agentStatus === 'ready');
              expect(state.capabilities?.askMode).toBe(false);
              expect(state.capabilities?.effort).toBe(false);
              expect(state.options.permissionMode).toBe('auto');
              expect(state.options.model?.choices.map((c) => c.id)).toEqual(['gemini-pro']);
              expect(state.modelsLimitation).toContain('Third-party models');

              // Pinned ineligible model in Settings was NOT silently replaced.
              const storedSettings = yield* settingsService.get;
              expect(storedSettings.agents[agyFake.id]?.model).toBe('claude-sonnet-4');

              // Permission request WITHOUT allowOnce must reach the user Dock even under autoAllow: true.
              yield* sessions.prompt(id, text('permit-no-allow-once'));
              const askEvent = yield* events(id).pipe(
                Stream.filter(
                  (item): item is Extract<SessionStreamItem, { _tag: 'Transcript' }> =>
                    item._tag === 'Transcript' &&
                    item.event.item._tag === 'PermissionRequest' &&
                    item.event.item.state._tag === 'pending',
                ),
                Stream.runHead,
              );
              expect(Option.isSome(askEvent)).toBe(true);
              if (
                Option.isSome(askEvent) &&
                askEvent.value.event.item._tag === 'PermissionRequest'
              ) {
                yield* sessions.answerPermission(id, askEvent.value.event.item.id, 'always');
              }
              const ended = transcript(yield* untilTurnEnd(events(id)));
              expect(agentReply(ended)).toBe('permission always');
            }),
        ),
      TIMEOUT,
    );

    it.live(
      'isolates needsLogin per Agent without marking other Agents needsLogin',
      () =>
        withSessionsCustom(
          { catalog: [claudeFake, codexFake], fallbackAgentId: claudeFake.id },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const onClaude = yield* sessions.create(project, claudeFake.id);
              const onCodex = yield* sessions.create(project, codexFake.id);
              yield* agentStatus(onClaude, 'ready');
              yield* agentStatus(onCodex, 'ready');

              yield* sessions.prompt(onClaude, text('login'));
              yield* untilTurnEnd(events(onClaude));
              yield* agentStatus(onClaude, 'needsLogin');

              const codexState = yield* events(onCodex).pipe(Stream.runHead);
              const live = Option.getOrUndefined(codexState);
              expect(live?._tag === 'Live' && live.state.agentStatus).toBe('ready');
            }),
        ),
      TIMEOUT,
    );
  });
});

describe('ContextUsage lifecycle in Sessions', () => {
  const runOnRoot = <A, E>(
    root: string,
    install: { readonly bin: string; readonly logs: string },
    agentArgs: ReadonlyArray<string> | undefined,
    body: (
      project: ProjectId,
    ) => Effect.Effect<
      A,
      E,
      Sessions | Projects | AgentLifetime | AcpClient | SessionStore | Store
    >,
  ) =>
    Effect.gen(function* () {
      const store = layerStore(root);
      const sessionStore = layerSessionStore.pipe(Layer.provide(store));
      const projects = layerProjects.pipe(
        Layer.provide(sessionStore),
        Layer.provide(store),
        Layer.provide(
          Layer.succeed(Folders, {
            platform: process.platform,
            realPath: (folder) => Effect.succeed(Option.some(folder)),
            exists: () => Effect.succeed(true),
          }),
        ),
        Layer.provide(
          Layer.succeed(FolderPicker, { pick: Effect.succeed(Option.some(PROJECT_FOLDER)) }),
        ),
      );
      const remembered = layerRemembered.pipe(Layer.provide(store));
      const settings = layerSettings.pipe(
        Layer.provide(remembered),
        Layer.provide(
          Layer.succeed(WindowSettings, {
            applyTheme: () => Effect.void,
            applyLanguage: () => Effect.void,
          }),
        ),
        Layer.provide(store),
      );
      const acpClient = layerAcpClientWithFakeAgent(install);
      const deleteQueue = layerDeleteQueue.pipe(Layer.provide(Layer.mergeAll(store, acpClient)));
      const layer = layerSessions.pipe(
        Layer.provideMerge(projects),
        Layer.provideMerge(sessionStore),
        Layer.provideMerge(remembered),
        Layer.provideMerge(deleteQueue),
        Layer.provideMerge(store),
        Layer.provide(settings),
        Layer.provideMerge(layerAgentLifetime.pipe(Layer.provideMerge(acpClient))),
        Layer.provide(Layer.succeed(AgentCatalog, makeAgentCatalog([fakeEntry(agentArgs)]))),
      );
      return yield* Effect.gen(function* () {
        const list = yield* Projects.use((p) => p.list);
        const existing = list[0];
        const project = existing ?? (yield* Projects.use((p) => p.add));
        if (project === null) return yield* Effect.die('the picker answered nothing');
        return yield* body(project.id);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped);

  const sendAndEnd = (id: SessionId, message: string, afterSeq: number) =>
    Effect.gen(function* () {
      yield* yieldTurn(id, message);
      const items = yield* untilTurnEnd(events(id, afterSeq));
      return seqs(items).at(-1) ?? afterSeq;
    });

  const yieldTurn = (id: SessionId, message: string) =>
    Sessions.use((sessions) => sessions.prompt(id, text(message)));

  it.live(
    'maps reported, over-capacity, and countOnly usage_update and ignores cumulative Usage',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const initial = yield* liveState(id, (state) => state.agentStatus === 'ready');
          expect(initial.contextUsage).toEqual({ _tag: 'unavailable' });

          // Cumulative PromptResponse.usage must never populate ContextUsage.
          let seq = yield* sendAndEnd(id, 'cumulative-only', 0);
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({ _tag: 'unavailable' });

          seq = yield* sendAndEnd(id, 'usage:24000/200000', seq);
          const reported = yield* liveState(id, (state) => state.contextUsage?._tag === 'reported');
          expect(reported.contextUsage).toEqual({
            _tag: 'reported',
            used: 24_000,
            capacity: 200_000,
          });

          // Over-capacity (>100%) is preserved without clamping.
          seq = yield* sendAndEnd(id, 'usage:210000/200000', seq);
          const over = yield* liveState(
            id,
            (state) =>
              state.contextUsage?._tag === 'reported' && state.contextUsage.used === 210_000,
          );
          expect(over.contextUsage).toEqual({
            _tag: 'reported',
            used: 210_000,
            capacity: 200_000,
          });

          // Missing / zero capacity yields countOnly.
          yield* sendAndEnd(id, 'usage:12000/0', seq);
          const countOnly = yield* liveState(
            id,
            (state) => state.contextUsage?._tag === 'countOnly',
          );
          expect(countOnly.contextUsage).toEqual({ _tag: 'countOnly', used: 12_000 });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'invalidates ContextUsage immediately on Clear and Model change, but preserves it on Effort/Permission change',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');

          let seq = yield* sendAndEnd(id, 'usage:24000/200000', 0);
          yield* liveState(id, (state) => state.contextUsage?._tag === 'reported');

          // Effort and permissionMode changes keep the current reading.
          yield* sessions.setOption({ sessionId: id, option: 'effort', value: 'high' });
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({
            _tag: 'reported',
            used: 24_000,
            capacity: 200_000,
          });

          // Model change invalidates immediately.
          yield* sessions.setOption({ sessionId: id, option: 'model', value: 'large' });
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({ _tag: 'unavailable' });

          yield* sendAndEnd(id, 'usage:15000/200000', seq);
          yield* liveState(id, (state) => state.contextUsage?._tag === 'reported');

          // Clear invalidates immediately.
          yield* sessions.clearContext(id);
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({ _tag: 'unavailable' });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'transitions through waiting during compaction and reverts to historical on failure or cancellation',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');

          let seq = yield* sendAndEnd(id, 'usage:50000/200000', 0);
          yield* liveState(id, (state) => state.contextUsage?._tag === 'reported');

          // Failed compaction leaves prior reading historical.
          seq = yield* sendAndEnd(id, 'compact-fail', seq);
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({
            _tag: 'historical',
            used: 50_000,
            capacity: 200_000,
          });

          // Successful compaction without usage_update stays waiting until a report arrives.
          seq = yield* sendAndEnd(id, 'compact-ok', seq);
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({
            _tag: 'waiting',
            prior: { used: 50_000, capacity: 200_000 },
          });

          // Cancelled compaction restores historical reading.
          yield* sessions.prompt(id, text('compact-cancel'));
          yield* liveState(id, (state) => state.runningTurn !== undefined);
          yield* sessions.cancel(id);
          const cancelledItems = yield* untilTurnEnd(events(id, seq));
          seq = seqs(cancelledItems).at(-1) ?? seq;
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({
            _tag: 'historical',
            used: 50_000,
            capacity: 200_000,
          });

          // Compaction followed by usage_update updates to the new reported reading.
          yield* sendAndEnd(id, 'compact-ok:12000/200000', seq);
          const updated = yield* liveState(
            id,
            (state) =>
              state.contextUsage?._tag === 'reported' && state.contextUsage.used === 12_000,
          );
          expect(updated.contextUsage).toEqual({
            _tag: 'reported',
            used: 12_000,
            capacity: 200_000,
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'restores saved ContextUsage as historical on reopen, ignores invalid payloads, and invalidates on lost memory',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-context-reopen-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const install = yield* installFakeAgent;
        let sessionId!: SessionId;

        yield* runOnRoot(root, install, undefined, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            sessionId = yield* sessions.create(project);
            yield* liveState(sessionId, (state) => state.agentStatus === 'ready');
            yield* sessions.prompt(sessionId, text('usage:24000/200000'));
            yield* liveState(sessionId, (state) => state.contextUsage?._tag === 'reported');
            yield* untilTurnEnd(events(sessionId));
          }),
        );

        // Second run: reopen succeeds (resume), saved reading starts historical; invalid usage_update never overwrites it.
        yield* runOnRoot(root, install, undefined, () =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const beforeTab = yield* liveState(sessionId, () => true);
            expect(beforeTab.contextUsage).toEqual({
              _tag: 'historical',
              used: 24_000,
              capacity: 200_000,
            });
            yield* sessions.setTabs([sessionId], sessionId);
            const afterResume = yield* liveState(
              sessionId,
              (state) => state.agentStatus === 'ready',
            );
            expect(afterResume.contextUsage).toEqual({
              _tag: 'historical',
              used: 24_000,
              capacity: 200_000,
            });

            // Invalid payload (-1) must not overwrite the historical reading.
            yield* sessions.prompt(sessionId, text('usage:-1/200000'));
            yield* untilTurnEnd(events(sessionId));
            expect((yield* liveState(sessionId, () => true)).contextUsage).toEqual({
              _tag: 'historical',
              used: 24_000,
              capacity: 200_000,
            });
          }),
        );

        // Third run: resume and load both fail -> memory lost -> historical reading invalidated to unavailable.
        yield* runOnRoot(root, install, ['--fail-resume', '--fail-load'], () =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            yield* sessions.setTabs([sessionId], sessionId);
            const afterLost = yield* liveState(sessionId, (state) => state.agentStatus === 'ready');
            expect(afterLost.contextUsage).toEqual({ _tag: 'unavailable' });
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'streams user-triggered Session.compact, transitions ContextUsage, and blocks Busy while a Turn or PermissionRequest runs',
    () =>
      withSessionsCustom({ agentArgs: ['--compact-usage=12000/200000'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const ready = yield* liveState(id, (state) => state.agentStatus === 'ready');
          expect(ready.capabilities?.supportsCompaction).toBe(true);

          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          let seq = yield* sendAndEnd(id, 'usage:50000/200000', 0);
          yield* liveState(id, (state) => state.contextUsage?._tag === 'reported');

          // Refuses Busy while a Turn (including pending PermissionRequest) is running.
          yield* sessions.prompt(id, text('permit'));
          yield* liveState(id, (state) => state.attention === 'needsAnswer');
          const busyDuringTurn = yield* sessions.compact(id).pipe(Effect.flip);
          expect(busyDuringTurn.reason).toBe('Busy');
          yield* sessions.cancel(id);
          const cancelledTurn = yield* untilTurnEnd(events(id, seq));
          seq = seqs(cancelledTurn).at(-1) ?? seq;

          // Standalone Session.compact streams Compaction and updates ContextUsage.
          yield* sessions.compact(id);
          const afterCompact = yield* liveState(
            id,
            (state) =>
              state.compacting !== true &&
              state.contextUsage?._tag === 'reported' &&
              state.contextUsage.used === 12_000,
          );
          expect(afterCompact.compacting).toBeUndefined();
          const compactItems = yield* events(id, seq).pipe(
            Stream.takeUntil(
              (event) =>
                event._tag === 'Transcript' &&
                event.event.item._tag === 'Compaction' &&
                event.event.item.status === 'done',
            ),
            Stream.runCollect,
          );
          const compactions = [...compactItems]
            .filter(
              (event): event is Extract<SessionStreamItem, { _tag: 'Transcript' }> =>
                event._tag === 'Transcript',
            )
            .map((event) => event.event.item)
            .filter(
              (item): item is Extract<TranscriptItem, { _tag: 'Compaction' }> =>
                item._tag === 'Compaction',
            );
          expect(compactions.at(0)?.status).toBe('running');
          expect(compactions.at(-1)).toMatchObject({
            _tag: 'Compaction',
            status: 'done',
            summary: 'Compacted summary',
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'supports Session.cancel and failure fallback on standalone Session.compact, and refuses Unsupported',
    () =>
      Effect.gen(function* () {
        yield* withSessionsCustom({ agentArgs: ['--compact-hold'] }, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const id = yield* sessions.create(project);
            yield* liveState(id, (state) => state.agentStatus === 'ready');
            const seq = yield* sendAndEnd(id, 'usage:40000/200000', 0);

            yield* sessions.compact(id);
            yield* liveState(id, (state) => state.compacting === true);

            const [promptBusy, clearBusy, compactBusy] = yield* Effect.all([
              sessions.prompt(id, text('hi')).pipe(Effect.flip),
              sessions.clearContext(id).pipe(Effect.flip),
              sessions.compact(id).pipe(Effect.flip),
            ]);
            expect([promptBusy.reason, clearBusy.reason, compactBusy.reason]).toEqual([
              'Busy',
              'Busy',
              'Busy',
            ]);

            yield* sessions.cancel(id);
            const settled = yield* liveState(id, (state) => state.compacting !== true);
            expect(settled.contextUsage).toEqual({
              _tag: 'historical',
              used: 40_000,
              capacity: 200_000,
            });
            const tail = yield* events(id, seq).pipe(
              Stream.takeUntil(
                (event) =>
                  event._tag === 'Transcript' &&
                  event.event.item._tag === 'Compaction' &&
                  event.event.item.status === 'cancelled',
              ),
              Stream.runCollect,
            );
            expect(
              [...tail].some(
                (event) =>
                  event._tag === 'Transcript' &&
                  event.event.item._tag === 'Compaction' &&
                  event.event.item.status === 'cancelled',
              ),
            ).toBe(true);
          }),
        );

        yield* withSessionsCustom({ agentArgs: ['--compact-fail'] }, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const id = yield* sessions.create(project);
            yield* liveState(id, (state) => state.agentStatus === 'ready');
            const seq = yield* sendAndEnd(id, 'usage:30000/200000', 0);

            yield* sessions.compact(id);
            const settled = yield* liveState(
              id,
              (state) => state.compacting !== true && state.contextUsage?._tag === 'historical',
            );
            expect(settled.contextUsage).toEqual({
              _tag: 'historical',
              used: 30_000,
              capacity: 200_000,
            });
            const tail = yield* events(id, seq).pipe(
              Stream.takeUntil(
                (event) =>
                  event._tag === 'Transcript' &&
                  event.event.item._tag === 'Compaction' &&
                  event.event.item.status === 'failed',
              ),
              Stream.runCollect,
            );
            expect(
              [...tail].some(
                (event) =>
                  event._tag === 'Transcript' &&
                  event.event.item._tag === 'Compaction' &&
                  event.event.item.status === 'failed',
              ),
            ).toBe(true);
          }),
        );

        yield* withSessionsCustom({ agentArgs: ['--no-compaction'] }, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const id = yield* sessions.create(project);
            const ready = yield* liveState(id, (state) => state.agentStatus === 'ready');
            expect(ready.capabilities?.supportsCompaction).toBe(false);
            const unsupported = yield* sessions.compact(id).pipe(Effect.flip);
            expect(unsupported.reason).toBe('Unsupported');
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
