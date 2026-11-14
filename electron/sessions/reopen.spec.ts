import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  MessageId,
  PermissionRequestId,
  SessionId,
  type SessionStreamItem,
  StepId,
  type TranscriptItem,
  TurnId,
} from '../../src/shared/sessions/sessions.rpc';
import { fakeEntry, installFakeAgent } from '../acp/acpFakes';
import { AcpSessionId } from '../acp/acpSession';
import { Projects } from '../projects/projects';
import { activeContextOf, AgentContextId, SessionStore, type SessionMeta } from './session-store';
import { Sessions } from './sessions';
import { layerSessionsWithFakeAgent } from './sessions-fakes';

/** Spawning node through a shim and a real ACP handshake take longer than the default 5 s on a cold machine. */
const TIMEOUT = 30_000;

const PROJECT_FOLDER = process.cwd();
const EARLIER = AcpSessionId.make('earlier');

const text = (value: string) => [{ _tag: 'text' as const, text: value }];

/** One run of the app over the Store in `root`: everything built fresh, as after a restart. */
const run = <A, E>(
  root: string,
  install: { readonly bin: string; readonly logs: string },
  body: Effect.Effect<A, E, Sessions | SessionStore | Projects>,
  args: ReadonlyArray<string> = [],
) =>
  body.pipe(
    Effect.provide(
      layerSessionsWithFakeAgent({ root, install, projectFolder: PROJECT_FOLDER, args }),
    ),
    Effect.scoped,
  );

/** A Store folder and the fake Agent, removed at the end of the test. */
const setup = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-reopen-'))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );
  const install = yield* installFakeAgent;
  return { root, install };
});

/** The Project the tests add (the picker always answers `PROJECT_FOLDER`). */
const addProject = Projects.use((projects) => projects.add).pipe(
  Effect.flatMap((project) =>
    project === null ? Effect.die('the picker answered nothing') : Effect.succeed(project.id),
  ),
);

/** Keeps a Session as an earlier run would have left it: its meta and Transcript on disk. */
const keep = (
  projectId: ProjectId,
  items: ReadonlyArray<TranscriptItem>,
  meta: Partial<SessionMeta> = {},
) =>
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const id = SessionId.make(randomUUID());
    const activeContextId = AgentContextId.make('ctx-1');
    const agentId = meta.agentId ?? fakeEntry().id;
    yield* store.createDraft({
      id,
      projectId,
      cwd: PROJECT_FOLDER,
      agentId,
      autoTitleIsPlaceholder: false,
      createdAt: 1,
      lastActivityAt: 1,
      activeContextId,
      contexts: [
        {
          id: activeContextId,
          agentId,
          acpSessionIds: [EARLIER],
          createdAt: 1,
        },
      ],
      permissionMode: 'ask',
      ...meta,
    });
    yield* store.append(id, items);
    yield* store.flush(id);
    return id;
  });

/** A finished Turn: the user's Message and the Agent's reply. */
const finishedTurn = (said: string): ReadonlyArray<TranscriptItem> => {
  const turnId = TurnId.make(randomUUID());
  return [
    { _tag: 'TurnStarted', turnId, permissionMode: 'ask' },
    { _tag: 'Message', id: MessageId.make(randomUUID()), turnId, role: 'user', parts: text(said) },
    { _tag: 'TurnEnded', turnId, outcome: { _tag: 'done' } },
  ];
};

const events = (id: SessionId, afterSeq?: number) =>
  Stream.unwrap(Sessions.use((s) => Effect.succeed(s.events(id, afterSeq))));

const transcript = (items: ReadonlyArray<SessionStreamItem>): ReadonlyArray<TranscriptItem> =>
  items.flatMap((item) => (item._tag === 'Transcript' ? [item.event.item] : []));

/** Prompts, and collects the whole Transcript up to the end of that Turn. */
const promptAndWait = (id: SessionId, said: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const prompted = yield* Deferred.make<TurnId>();
    const following = yield* events(id).pipe(
      Stream.takeUntilEffect((item) =>
        item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded'
          ? Effect.map(Deferred.await(prompted), (turnId) =>
              item.event.item._tag === 'TurnEnded' ? item.event.item.turnId === turnId : false,
            )
          : Effect.succeed(false),
      ),
      Stream.runCollect,
      Effect.forkChild,
    );
    const turnId = yield* sessions.prompt(id, text(said));
    yield* Deferred.succeed(prompted, turnId);
    const items = transcript([...(yield* Fiber.join(following))]);
    const started = items.findIndex(
      (item) => item._tag === 'TurnStarted' && item.turnId === turnId,
    );
    return { before: items.slice(0, started), turn: items.slice(started) };
  });

/** The Agent's reply text in a list of Transcript items. */
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

/** Shows the Session in the only Tab, as the window does after a restart. */
const showInTab = (id: SessionId) => Sessions.use((s) => s.setTabs([id], id));

const acpSessionIds = (id: SessionId) =>
  SessionStore.use((store) => store.get(id)).pipe(
    Effect.map((meta) => activeContextOf(meta)?.acpSessionIds ?? []),
  );

describe('Reopening a Session after a restart', () => {
  it.live(
    'resumes the last ACP session when its Tab is shown',
    () =>
      Effect.gen(function* () {
        const { root, install } = yield* setup;
        const id = yield* run(
          root,
          install,
          Effect.gen(function* () {
            return yield* keep(yield* addProject, finishedTurn('echo:before'));
          }),
        );

        yield* run(
          root,
          install,
          Effect.gen(function* () {
            yield* showInTab(id);
            const { before, turn } = yield* promptAndWait(id, 'how');
            expect(agentReply(turn)).toBe('resumed');
            expect(before.map((item) => item._tag)).toEqual([
              'TurnStarted',
              'Message',
              'TurnEnded',
            ]);
            expect(yield* acpSessionIds(id)).toEqual([EARLIER]);
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'replaces the automatic title on session_info_update after resuming a Session',
    () =>
      Effect.gen(function* () {
        const { root, install } = yield* setup;
        const id = yield* run(
          root,
          install,
          Effect.gen(function* () {
            return yield* keep(yield* addProject, finishedTurn('echo:before'), {
              autoTitle: 'echo:before',
              autoTitleIsPlaceholder: true,
            });
          }),
        );

        yield* run(
          root,
          install,
          Effect.gen(function* () {
            yield* showInTab(id);
            yield* promptAndWait(id, 'title:Resumed title');
            const meta = yield* SessionStore.use((store) => store.get(id));
            expect(meta.autoTitle).toBe('Resumed title');
            expect(meta.autoTitleIsPlaceholder).toBe(false);
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'loads the last ACP session when resume is unsupported',
    () =>
      Effect.gen(function* () {
        const { root, install } = yield* setup;
        const id = yield* run(
          root,
          install,
          Effect.gen(function* () {
            return yield* keep(yield* addProject, finishedTurn('echo:before'));
          }),
        );

        yield* run(
          root,
          install,
          Effect.gen(function* () {
            yield* showInTab(id);
            const { before, turn } = yield* promptAndWait(id, 'how');
            expect(agentReply(turn)).toBe('loaded');
            expect(before.map((item) => item._tag)).toEqual([
              'TurnStarted',
              'Message',
              'TurnEnded',
            ]);
            expect(yield* acpSessionIds(id)).toEqual([EARLIER]);
          }),
          ['--no-resume'],
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'loads the last ACP session when resume fails',
    () =>
      Effect.gen(function* () {
        const { root, install } = yield* setup;
        const id = yield* run(
          root,
          install,
          Effect.gen(function* () {
            return yield* keep(yield* addProject, finishedTurn('echo:before'));
          }),
        );

        yield* run(
          root,
          install,
          Effect.gen(function* () {
            yield* showInTab(id);
            const { before, turn } = yield* promptAndWait(id, 'how');
            expect(agentReply(turn)).toBe('loaded');
            expect(before.map((item) => item._tag)).toEqual([
              'TurnStarted',
              'Message',
              'TurnEnded',
            ]);
            expect(yield* acpSessionIds(id)).toEqual([EARLIER]);
          }),
          ['--fail-resume'],
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'starts a new ACP session, appends ContextCleared + Notice, and gates Send on memoryLost until resolved',
    () =>
      Effect.gen(function* () {
        const { root, install } = yield* setup;
        const id = yield* run(
          root,
          install,
          Effect.gen(function* () {
            return yield* keep(yield* addProject, finishedTurn('echo:before'));
          }),
        );

        // First restart: resume and load fail -> memoryLost persists and gates prompt.
        yield* run(
          root,
          install,
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            yield* showInTab(id);
            const items = yield* events(id).pipe(
              Stream.takeUntil((item) => item._tag === 'Live' && item.state.memoryLost === true),
              Stream.runCollect,
            );
            const live = [...items].reverse().find((item) => item._tag === 'Live');
            expect(live?._tag === 'Live' ? live.state.memoryLost : undefined).toBe(true);
            const promptError = yield* Effect.flip(sessions.prompt(id, text('blocked')));
            expect(promptError.reason).toBe('MemoryLost');
          }),
          ['--fail-resume', '--fail-load'],
        );

        // Second restart without resolving: memoryLost is still persisted and still gates prompt.
        yield* run(
          root,
          install,
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            yield* showInTab(id);
            const firstLive = yield* events(id).pipe(Stream.take(1), Stream.runCollect);
            const state = [...firstLive][0];
            expect(state?._tag === 'Live' ? state.state.memoryLost : undefined).toBe(true);
            const promptError = yield* Effect.flip(sessions.prompt(id, text('still-blocked')));
            expect(promptError.reason).toBe('MemoryLost');

            // Resolve with startEmptyContext -> gate clears and prompt succeeds.
            yield* sessions.startEmptyContext(id);
            const { before, turn } = yield* promptAndWait(id, 'how');
            expect(agentReply(turn)).toBe('new');
            expect(before.map((item) => item._tag)).toEqual([
              'TurnStarted',
              'Message',
              'TurnEnded',
              'ContextCleared',
              'Notice',
            ]);
            const notice = before.find((item) => item._tag === 'Notice');
            expect(notice).toMatchObject({ _tag: 'Notice', severity: 'info' });
            const meta = yield* SessionStore.use((store) => store.get(id));
            expect(meta.memoryLost).toBeUndefined();
            expect(meta.contexts).toHaveLength(2);
            expect(meta.contexts[0]?.acpSessionIds).toEqual([EARLIER]);
            expect(meta.contexts[0]?.retiredAt).toBeTypeOf('number');
            expect(activeContextOf(meta)?.acpSessionIds.length).toBeGreaterThanOrEqual(1);
            expect(activeContextOf(meta)?.acpSessionIds).not.toContain(EARLIER);
          }),
          ['--fail-resume', '--fail-load'],
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'records per-Turn agentId, requested model, and actualModel, and never resurrects retired contexts after Clear',
    () =>
      Effect.gen(function* () {
        const { root, install } = yield* setup;
        const id = yield* run(
          root,
          install,
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const created = yield* sessions.create(yield* addProject);
            yield* showInTab(created);
            const { turn } = yield* promptAndWait(created, 'echo:one');
            const started = turn.find((item) => item._tag === 'TurnStarted');
            const ended = turn.find((item) => item._tag === 'TurnEnded');
            expect(started).toMatchObject({
              _tag: 'TurnStarted',
              agentId: fakeEntry().id,
              model: 'small',
            });
            expect(ended).toMatchObject({
              _tag: 'TurnEnded',
              actualModel: 'small',
            });
            yield* sessions.clearContext(created);
            return created;
          }),
        );

        // After restart, active context has a fresh ACP session (or none), never the pre-Clear one.
        yield* run(
          root,
          install,
          Effect.gen(function* () {
            const meta = yield* SessionStore.use((store) => store.get(id));
            expect(meta.contexts).toHaveLength(2);
            expect(meta.contexts[0]?.retiredAt).toBeTypeOf('number');
            expect(meta.contexts[1]?.id).toBe(meta.activeContextId);
            expect(meta.contexts[1]?.acpSessionIds).not.toEqual(meta.contexts[0]?.acpSessionIds);
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'Archive preserves Agent, Transcript, boundaries, and context; only sending a Message unarchives',
    () =>
      Effect.gen(function* () {
        const { root, install } = yield* setup;
        const id = yield* run(
          root,
          install,
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const created = yield* sessions.create(yield* addProject);
            yield* showInTab(created);
            yield* promptAndWait(created, 'echo:one');
            yield* sessions.clearContext(created);
            yield* sessions.archive(created);
            return created;
          }),
        );

        yield* run(
          root,
          install,
          Effect.gen(function* () {
            const beforeReopen = yield* SessionStore.use((store) => store.get(id));
            expect(beforeReopen.archivedAt).toBeTypeOf('number');

            // Reopening / reading does not unarchive.
            yield* showInTab(id);
            const items = yield* events(id).pipe(
              Stream.takeUntil(
                (item) => item._tag === 'Live' && item.state.agentStatus === 'ready',
              ),
              Stream.runCollect,
            );
            expect(transcript([...items]).some((item) => item._tag === 'ContextCleared')).toBe(
              true,
            );
            const afterRead = yield* SessionStore.use((store) => store.get(id));
            expect(afterRead.archivedAt).toBe(beforeReopen.archivedAt);
            expect(afterRead.agentId).toBe(beforeReopen.agentId);
            expect(afterRead.activeContextId).toBe(beforeReopen.activeContextId);

            // Sending a Message unarchives.
            yield* promptAndWait(id, 'echo:two');
            const afterPrompt = yield* SessionStore.use((store) => store.get(id));
            expect(afterPrompt.archivedAt).toBeUndefined();
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'closes an interrupted Turn as failed and cancels its pending Permission request',
    () =>
      Effect.gen(function* () {
        const { root, install } = yield* setup;
        const turnId = TurnId.make(randomUUID());
        const requestId = PermissionRequestId.make('req-1');
        const stepId = StepId.make('step-1');
        const id = yield* run(
          root,
          install,
          Effect.gen(function* () {
            return yield* keep(yield* addProject, [
              { _tag: 'TurnStarted', turnId, permissionMode: 'ask' },
              {
                _tag: 'Message',
                id: MessageId.make(randomUUID()),
                turnId,
                role: 'user',
                parts: text('echo:hello'),
              },
              {
                _tag: 'PermissionRequest',
                id: requestId,
                turnId,
                stepId,
                options: [
                  { id: 'allow', label: 'Allow', kind: 'allowOnce' },
                  { id: 'reject', label: 'Reject', kind: 'rejectOnce' },
                ],
                state: { _tag: 'pending' },
              },
            ]);
          }),
        );

        yield* run(
          root,
          install,
          Effect.gen(function* () {
            const items = transcript(
              yield* events(id).pipe(
                Stream.takeUntil(
                  (item) =>
                    item._tag === 'Transcript' &&
                    item.event.item._tag === 'TurnEnded' &&
                    item.event.item.turnId === turnId,
                ),
                Stream.runCollect,
              ),
            );
            const cancelled = [...items]
              .reverse()
              .find(
                (item): item is Extract<typeof item, { _tag: 'PermissionRequest' }> =>
                  item._tag === 'PermissionRequest' && item.id === requestId,
              );
            expect(cancelled?.state._tag).toBe('cancelled');
            const ended = items.find((item) => item._tag === 'TurnEnded' && item.turnId === turnId);
            expect(ended).toMatchObject({
              _tag: 'TurnEnded',
              turnId,
              outcome: { _tag: 'failed', reason: 'interrupted' },
            });
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
