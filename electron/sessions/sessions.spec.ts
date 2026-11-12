import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Option, Schedule, Stream } from 'effect';
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
import { layerStore } from '../store/store';
import { layerSessionStore } from './session-store';
import { layerSessions, SessionAgent, Sessions } from './sessions';

/** Spawning node through a shim and a real ACP handshake take longer than the default 5 s on a cold machine. */
const TIMEOUT = 30_000;

const PROJECT_FOLDER = process.cwd();

/** Sessions over a fresh store, one Project on `PROJECT_FOLDER`, and the fake Agent as the Sessions' Agent. */
const withSessions = <A, E>(
  body: (
    project: ProjectId,
  ) => Effect.Effect<A, E, Sessions | Projects | AgentLifetime | AcpClient>,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sessions-'))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    const install = yield* installFakeAgent;
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
    const settings = layerSettings.pipe(
      Layer.provide(layerRemembered),
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
      Layer.provide(sessionStore),
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

describe('Sessions with the fake Agent', () => {
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
    'refuses a second prompt Busy while a Turn runs; cancel does nothing when idle',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.cancel(id);
          yield* sessions.prompt(id, text('hold'));

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
