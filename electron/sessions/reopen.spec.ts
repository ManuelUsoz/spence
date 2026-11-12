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
import { SessionStore, type SessionMeta } from './session-store';
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
    yield* store.createDraft({
      id,
      projectId,
      cwd: PROJECT_FOLDER,
      agentId: fakeEntry().id,
      autoTitleIsPlaceholder: false,
      createdAt: 1,
      lastActivityAt: 1,
      acpSessionIds: [EARLIER],
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
  SessionStore.use((store) => store.get(id)).pipe(Effect.map((meta) => meta.acpSessionIds));

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
    'starts a new ACP session and marks memory lost when resume and load both fail',
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
            expect(agentReply(turn)).toBe('new');
            expect(before.map((item) => item._tag)).toEqual([
              'TurnStarted',
              'Message',
              'TurnEnded',
              'ContextCleared',
            ]);
            const ids = yield* acpSessionIds(id);
            expect(ids).toHaveLength(2);
            expect(ids[0]).toBe(EARLIER);
            expect(ids[1]).not.toBe(EARLIER);
          }),
          ['--fail-resume', '--fail-load'],
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
