import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Option, Schedule, Stream } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { FolderPicker, Folders } from '../projects/folders';
import { layerProjects, Projects } from '../projects/projects';
import { layerRemembered } from '../settings/remembered';
import { layerSettings, WindowSettings } from '../settings/settings';
import { layerStore, makeStore, Store, type StoreShape } from '../store/store';
import { layerSessionStore, SessionStore } from './session-store';
import { SessionAgent } from './session-agent';
import { layerSessions, Sessions } from './sessions';

/** Spawning node through a shim and a real ACP handshake take longer than the default 5 s on a cold machine. */
const TIMEOUT = 30_000;

const PROJECT_FOLDER = process.cwd();

/** Sessions over a fresh store, one Project on `PROJECT_FOLDER`, and the fake Agent as the Sessions' Agent. */
const withSessions = <A, E>(
  body: (
    project: ProjectId,
  ) => Effect.Effect<A, E, Sessions | Projects | AgentLifetime | AcpClient | SessionStore>,
  wrapStore?: (store: StoreShape) => StoreShape,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sessions-'))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    const install = yield* installFakeAgent;
    const store =
      wrapStore === undefined ? layerStore(root) : Layer.succeed(Store, wrapStore(makeStore(root)));
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
    const layer = layerSessions.pipe(
      Layer.provideMerge(projects),
      Layer.provideMerge(sessionStore),
      Layer.provideMerge(remembered),
      Layer.provide(settings),
      Layer.provideMerge(
        layerAgentLifetime.pipe(Layer.provideMerge(layerAcpClientWithFakeAgent(install))),
      ),
      Layer.provide(Layer.succeed(SessionAgent, fakeEntry())),
    );
    return yield* Effect.gen(function* () {
      const project = yield* Projects.use((p) => p.add);
      if (project === null) return yield* Effect.die('the picker answered nothing');
      return yield* body(project.id);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

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
          yield* agentStatus(id, 'stopped');

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
});
