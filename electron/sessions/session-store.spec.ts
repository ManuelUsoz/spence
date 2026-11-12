import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import {
  MessageId,
  SessionId,
  TurnId,
  type TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { AcpSessionId } from '../acp/acpSession';
import { layerStore } from '../store/store';
import { BATCH_INTERVAL, layerSessionStore, SessionStore, type SessionMeta } from './session-store';

/** A fresh store root per test, removed afterwards. */
const withRoot = <A, E>(body: (root: string) => Effect.Effect<A, E>) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sessions-'))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ).pipe(Effect.flatMap(body), Effect.scoped);

/** A SessionStore over `root`, as one run of Spence sees it. A second call is a restart. */
const run = <A, E>(root: string, body: Effect.Effect<A, E, SessionStore>) =>
  body.pipe(Effect.provide(layerSessionStore.pipe(Layer.provide(layerStore(root)))), Effect.scoped);

const entries = (dir: string) =>
  Effect.promise(() => readdir(dir).catch((): ReadonlyArray<string> => []));

/** The seqs written to a Session's transcript file, read straight from disk. */
const onDisk = (root: string, id: string) =>
  Effect.promise(() =>
    readFile(path.join(root, 'sessions', id, 'transcript.jsonl'), 'utf8').catch(() => ''),
  ).pipe(
    Effect.map((text) =>
      text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as { seq: number }).seq),
    ),
  );

const projectId = ProjectId.make('project-1');
const turnId = TurnId.make('turn-1');

const meta = (id: string, overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: SessionId.make(id),
  projectId,
  cwd: '/work/project',
  agentId: AgentId.make('claude'),
  autoTitleIsPlaceholder: false,
  createdAt: 1000,
  lastActivityAt: 1000,
  acpSessionIds: [AcpSessionId.make('acp-1')],
  permissionMode: 'auto',
  ...overrides,
});

const say = (text: string): TranscriptItem => ({
  _tag: 'Message',
  id: MessageId.make(`message-${text}`),
  turnId,
  role: 'user',
  parts: [{ _tag: 'text', text }],
});

describe('SessionStore', () => {
  it.effect('never writes a draft Session that has no events', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        yield* run(
          root,
          SessionStore.use((store) => store.createDraft(meta('draft'))),
        );
        expect(yield* entries(path.join(root, 'sessions'))).toEqual([]);
      }),
    ),
  );

  it.effect(
    'numbers appended events by seq and replays those after afterSeq, across restarts',
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const id = SessionId.make('s1');
          yield* run(
            root,
            Effect.gen(function* () {
              const store = yield* SessionStore;
              yield* store.createDraft(meta('s1'));
              const events = yield* store.append(id, [say('a'), say('b')]);
              expect(events.map((event) => event.seq)).toEqual([1, 2]);
              yield* store.flush(id);
            }),
          );
          yield* run(
            root,
            Effect.gen(function* () {
              const store = yield* SessionStore;
              const events = yield* store.append(id, [say('c')]);
              expect(events.map((event) => event.seq)).toEqual([3]);
              const all = yield* store.replay(id);
              expect(all.map((event) => [event.seq, event.item])).toEqual([
                [1, say('a')],
                [2, say('b')],
                [3, say('c')],
              ]);
              const after = yield* store.replay(id, 2);
              expect(after.map((event) => event.seq)).toEqual([3]);
            }),
          );
        }),
      ),
  );

  it.effect('keeps image, audio and blob bytes once in blobs/ and inlines them on replay', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const id = SessionId.make('s1');
        const png = Buffer.from('not really a png').toString('base64');
        const wav = Buffer.from('not really a wav').toString('base64');
        const message: TranscriptItem = {
          _tag: 'Message',
          id: MessageId.make('m1'),
          turnId,
          role: 'user',
          parts: [
            { _tag: 'image', mimeType: 'image/png', data: png },
            { _tag: 'image', mimeType: 'image/png', data: png },
            { _tag: 'audio', mimeType: 'audio/wav', data: wav },
            {
              _tag: 'resource',
              uri: 'file:///x.bin',
              contents: { _tag: 'blob', blob: png },
            },
            { _tag: 'text', text: 'two pictures' },
          ],
        };
        yield* run(
          root,
          Effect.gen(function* () {
            const store = yield* SessionStore;
            yield* store.createDraft(meta('s1'));
            yield* store.append(id, [message]);
          }),
        );

        const blobs = yield* entries(path.join(root, 'sessions', 's1', 'blobs'));
        expect(blobs).toHaveLength(2);
        const transcript = yield* Effect.promise(() =>
          readFile(path.join(root, 'sessions', 's1', 'transcript.jsonl'), 'utf8'),
        );
        expect(transcript).not.toContain(png);
        expect(transcript).not.toContain(wav);

        const replayed = yield* run(
          root,
          SessionStore.use((store) => store.replay(id)),
        );
        expect(replayed.map((event) => event.item)).toEqual([message]);
      }),
    ),
  );

  it.effect('writes a batch every 250 ms without being asked', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const id = SessionId.make('s1');
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          layerSessionStore.pipe(Layer.provide(layerStore(root))),
          scope,
        );
        const store = Context.get(context, SessionStore);
        yield* store.createDraft(meta('s1'));
        yield* store.append(id, [say('a')]);
        expect(yield* onDisk(root, id)).toEqual([]);

        yield* TestClock.adjust(BATCH_INTERVAL);
        // The batch runs under the store's lock; any call on the store waits for it.
        yield* store.replay(id);
        expect(yield* onDisk(root, id)).toEqual([1]);
        // A crash: the scope is never closed, so nothing else is flushed.
      }),
    ),
  );

  it.effect('loses at most the unwritten tail in a crash', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const id = SessionId.make('s1');
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          layerSessionStore.pipe(Layer.provide(layerStore(root))),
          scope,
        );
        const store = Context.get(context, SessionStore);
        yield* store.createDraft(meta('s1'));
        yield* store.append(id, [say('a'), say('b')]);
        yield* store.flush(id);
        yield* store.append(id, [say('c')]);
        // Crash: the scope is never closed.

        expect(yield* onDisk(root, id)).toEqual([1, 2]);
        const seqs = yield* run(
          root,
          Effect.gen(function* () {
            const restarted = yield* SessionStore;
            return (yield* restarted.append(id, [say('d')])).map((event) => event.seq);
          }),
        );
        expect(seqs).toEqual([3]);
      }),
    ),
  );

  it.effect("lists a Project's kept Sessions, most recent activity first", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        yield* run(
          root,
          Effect.gen(function* () {
            const store = yield* SessionStore;
            yield* store.createDraft(
              meta('old', { userTitle: 'Old one', autoTitle: 'Auto', archivedAt: 5 }),
            );
            yield* store.createDraft(meta('new'));
            yield* store.createDraft(meta('other', { projectId: ProjectId.make('project-2') }));
            yield* store.createDraft(meta('draft'));
            yield* TestClock.setTime(10);
            yield* store.append(SessionId.make('old'), [say('a')]);
            yield* store.append(SessionId.make('other'), [say('a')]);
            yield* TestClock.setTime(20);
            yield* store.append(SessionId.make('new'), [say('a')]);
            // Listed before and after they are written.
            const unwritten = yield* store.list(projectId);
            yield* store.flush(SessionId.make('new'));
            expect(yield* store.list(projectId)).toEqual(unwritten);
          }),
        );

        const listed = yield* run(
          root,
          SessionStore.use((store) => store.list(projectId)),
        );
        expect(listed).toEqual([
          {
            id: 'new',
            agentId: 'claude',
            title: { autoIsPlaceholder: false },
            lastActivityAt: 20,
          },
          {
            id: 'old',
            agentId: 'claude',
            title: { user: 'Old one', auto: 'Auto', autoIsPlaceholder: false },
            lastActivityAt: 10,
            archivedAt: 5,
          },
        ]);
      }),
    ),
  );

  it.effect('fails NotFound for a Session it does not know', () =>
    withRoot((root) =>
      run(
        root,
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const error = yield* Effect.flip(store.replay(SessionId.make('nope')));
          expect(error.reason).toBe('NotFound');
          const appendError = yield* Effect.flip(store.append(SessionId.make('nope'), []));
          expect(appendError.reason).toBe('NotFound');
        }),
      ),
    ),
  );

  describe('relocate', () => {
    const sessionFile = (root: string, id: string) =>
      path.join(root, 'sessions', id, 'session.json');
    const readMeta = (root: string, id: string) =>
      Effect.promise(() => readFile(sessionFile(root, id), 'utf8')).pipe(
        Effect.map((text) => JSON.parse(text) as Record<string, unknown>),
      );
    const fromOld = (cwd: string) => cwd === '/work/project';

    it.effect('points the Sessions in the old folder at the new one, and only those', () =>
      withRoot((root) =>
        Effect.gen(function* () {
          yield* run(
            root,
            Effect.gen(function* () {
              const store = yield* SessionStore;
              yield* store.createDraft(meta('s1'));
              yield* store.createDraft(meta('s2', { cwd: '/elsewhere' }));
              yield* store.append(SessionId.make('s1'), [say('one')]);
              yield* store.append(SessionId.make('s2'), [say('two')]);
            }),
          );
          yield* run(
            root,
            SessionStore.use((store) => store.relocate(fromOld, '/moved/project')),
          );
          expect(yield* readMeta(root, 's1')).toMatchObject({
            version: 1,
            id: 's1',
            cwd: '/moved/project',
            agentId: 'claude',
          });
          expect((yield* readMeta(root, 's2'))['cwd']).toBe('/elsewhere');
        }),
      ),
    );

    it.effect('keeps the new folder when a Session it has in memory is appended to again', () =>
      withRoot((root) =>
        Effect.gen(function* () {
          yield* run(
            root,
            Effect.gen(function* () {
              const store = yield* SessionStore;
              const id = SessionId.make('s1');
              yield* store.createDraft(meta('s1'));
              yield* store.append(id, [say('one')]);
              yield* store.flush(id);
              yield* store.relocate(fromOld, '/moved/project');
              yield* store.append(id, [say('two')]);
              yield* store.flush(id);
            }),
          );
          expect((yield* readMeta(root, 's1'))['cwd']).toBe('/moved/project');
        }),
      ),
    );

    it.effect('relocates a draft too, so it is first written in the new folder', () =>
      withRoot((root) =>
        Effect.gen(function* () {
          yield* run(
            root,
            Effect.gen(function* () {
              const store = yield* SessionStore;
              yield* store.createDraft(meta('draft'));
              yield* store.relocate(fromOld, '/moved/project');
              yield* store.append(SessionId.make('draft'), [say('one')]);
            }),
          );
          expect((yield* readMeta(root, 'draft'))['cwd']).toBe('/moved/project');
        }),
      ),
    );

    it.effect('leaves a session.json from a newer Spence untouched', () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const newer = `${JSON.stringify({ version: 99, id: 'future', cwd: '/work/project' })}\n`;
          yield* Effect.promise(async () => {
            await mkdir(path.dirname(sessionFile(root, 'future')), { recursive: true });
            await writeFile(sessionFile(root, 'future'), newer);
          });
          yield* run(
            root,
            SessionStore.use((store) => store.relocate(fromOld, '/moved/project')),
          );
          expect(yield* Effect.promise(() => readFile(sessionFile(root, 'future'), 'utf8'))).toBe(
            newer,
          );
        }),
      ),
    );
  });
});
