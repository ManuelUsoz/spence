import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Option, Schedule, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  SessionId,
  type LiveState,
  type QueuedMessage,
  type SessionStreamItem,
  type TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';
import { layerAgentLogs } from '../acp/acpAgentLog';
import { fakeEntry, installFakeAgent, layerAcpClientWithFakeAgent } from '../acp/acpFakes';
import { AgentLifetime, layerAgentLifetime } from '../acp/acpLifetime';
import { AcpClient, layerAcpClient } from '../acp/acpSessionManager';
import { layerAgents } from '../agents/agents';
import type { CatalogEntry } from '../agents/catalog';
import { antigravity as antigravityCatalog } from '../agents/antigravity/antigravity';
import { codex as codexCatalog } from '../agents/codex/codex';
import { layerPathSources, MergedPath, PathSources } from '../agents/merged-path';
import { FolderPicker, Folders } from '../projects/folders';
import { layerProjects, Projects } from '../projects/projects';
import { layerRemembered, type Remembered } from '../settings/remembered';
import { layerSettings, Settings, WindowSettings } from '../settings/settings';
import { layerStore, makeStore, Store, type StoreShape } from '../store/store';
import { AGENT_DELETES_FILE, layerDeleteQueue } from './delete-queue';
import { activeContextOf, AgentContextId, layerSessionStore, SessionStore } from './session-store';
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
    readonly realAgentBin?: string;
    readonly pathSources?: (root: string) => Layer.Layer<PathSources>;
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
    const agentPath =
      options.realAgentBin === undefined
        ? install.bin
        : `${options.realAgentBin}${path.delimiter}${process.env['PATH'] ?? ''}`;
    const acpClient =
      options.pathSources === undefined && options.realAgentBin === undefined
        ? layerAcpClientWithFakeAgent(install)
        : layerAcpClient.pipe(
            Layer.provide(layerAgentLogs(install.logs)),
            Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(agentPath) })),
            Layer.provide(
              options.pathSources === undefined ? layerPathSources : options.pathSources(root),
            ),
          );
    const agentsLayer = layerAgents.pipe(
      Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(agentPath) })),
      Layer.provide(
        options.pathSources === undefined ? layerPathSources : options.pathSources(root),
      ),
    );
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
      Layer.provideMerge(agentsLayer),
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

// Opt-in: runs real authenticated provider turns; never used by CI.
const realAgentBin = process.env['SPENCE_CODEX_ACP_BIN'];

describe.skipIf(realAgentBin === undefined)('Sessions with real Codex ACP', () => {
  it.live(
    'discovers delegation, returns a Worker result, and accepts a Worker follow-up',
    () =>
      withSessionsCustom({ realAgentBin, catalog: [codexCatalog] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(
            parent,
            text(
              'Use the Spence delegate MCP tool exactly once. Ask the Worker to invent an eight-digit number and reply only WORKER_RESULT_ followed by that number. Return the Worker result verbatim. Do not use native subagents.',
            ),
          );
          const parentItems = transcript(yield* untilTurnEnd(events(parent)));
          const children = (yield* store.listAll).filter(
            (meta) => meta.parentSessionId === parent && meta.workerKind === 'owned',
          );
          expect(children).toHaveLength(1);
          const child = children[0];
          if (child === undefined) return yield* Effect.die('Owned Worker missing');
          const childItems = yield* store.replay(child.id);
          const workerResult = /WORKER_RESULT_\d{8}/.exec(
            agentReply(childItems.map((event) => event.item)),
          )?.[0];
          expect(workerResult).toBeDefined();
          if (workerResult === undefined) return yield* Effect.die('Worker result missing');
          expect(agentReply(parentItems)).toContain(workerResult);
          const lastSeq = childItems.at(-1)?.seq;
          yield* sessions.prompt(child.id, text('Reply with the exact text WORKER_FOLLOWUP_728.'));
          expect(agentReply(transcript(yield* untilTurnEnd(events(child.id, lastSeq))))).toContain(
            'WORKER_FOLLOWUP_728',
          );
        }),
      ),
    240_000,
  );
});

// Opt-in: runs real authenticated provider turns; never used by CI.
const antigravityBin = process.env['SPENCE_ANTIGRAVITY_ACP_BIN'];

describe.skipIf(antigravityBin === undefined)('Sessions with real Antigravity ACP', () => {
  it.live(
    'discovers delegation, returns a Worker result, and accepts a Worker follow-up',
    () =>
      withSessionsCustom(
        { realAgentBin: antigravityBin, catalog: [antigravityCatalog] },
        (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const store = yield* SessionStore;
            const parent = yield* sessions.create(project);
            yield* sessions.prompt(
              parent,
              text(
                'Use the Spence delegate MCP tool exactly once. Ask the Worker to invent an eight-digit number and reply only WORKER_RESULT_ followed by that number. Return the Worker result verbatim. Do not use native subagents.',
              ),
            );
            const parentItems = transcript(yield* untilTurnEnd(events(parent)));
            const children = (yield* store.listAll).filter(
              (meta) => meta.parentSessionId === parent && meta.workerKind === 'owned',
            );
            expect(children).toHaveLength(1);
            const child = children[0];
            if (child === undefined) return yield* Effect.die('Owned Worker missing');
            const childItems = yield* store.replay(child.id);
            const workerResult = /WORKER_RESULT_\d{8}/.exec(
              agentReply(childItems.map((event) => event.item)),
            )?.[0];
            expect(workerResult).toBeDefined();
            if (workerResult === undefined) return yield* Effect.die('Worker result missing');
            expect(agentReply(parentItems)).toContain(workerResult);
            const lastSeq = childItems.at(-1)?.seq;
            yield* sessions.prompt(
              child.id,
              text('Reply with the exact text WORKER_FOLLOWUP_728.'),
            );
            expect(
              agentReply(transcript(yield* untilTurnEnd(events(child.id, lastSeq)))),
            ).toContain('WORKER_FOLLOWUP_728');
          }),
      ),
    240_000,
  );
});

describe('Sessions with the fake Agent', () => {
  it.live('includes Worker preference in Agent guidance', () =>
    withSessions((project) =>
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const parent = yield* sessions.create(project);
        yield* sessions.prompt(parent, text('report-guidance'));
        const reply = agentReply(transcript(yield* untilTurnEnd(events(parent))));
        expect(reply).toContain('Prefer the Spence delegate tool');
        expect(reply).toContain('Native delegation remains available');
      }),
    ),
  );
  it.live(
    'delivers a delegated Worker reply to its Parent Session',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('delegate:echo:worker result'));
          expect(agentReply(transcript(yield* untilTurnEnd(events(parent))))).toBe('worker result');
          const children = (yield* store.listAll).filter((meta) => meta.parentSessionId === parent);
          expect(children).toHaveLength(1);
          const child = children[0];
          if (child === undefined) return yield* Effect.die('Worker missing');
          expect(child.workerKind).toBe('owned');
          const lastSeq = (yield* store.replay(child.id)).at(-1)?.seq;
          yield* sessions.prompt(child.id, text('echo:follow up'));
          expect(agentReply(transcript(yield* untilTurnEnd(events(child.id, lastSeq))))).toBe(
            'follow up',
          );
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'revokes the old delegation capability when a Session clears its context',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('report-mcp-servers'));
          const report = agentReply(transcript(yield* untilTurnEnd(events(parent))));
          const servers: ReadonlyArray<{
            url: string;
            headers: ReadonlyArray<{ name: string; value: string }>;
          }> = JSON.parse(report);
          const server = servers[0];
          if (server === undefined) return yield* Effect.die('Delegation server missing');
          yield* sessions.clearContext(parent);
          const status = yield* Effect.promise(() =>
            fetch(server.url, {
              method: 'POST',
              headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
            }).then((response) => response.status),
          );
          expect(status).toBe(403);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'deduplicates concurrent delegation retries in the same context',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('report-mcp-servers'));
          const report = agentReply(transcript(yield* untilTurnEnd(events(parent))));
          const servers: ReadonlyArray<{
            url: string;
            headers: ReadonlyArray<{ name: string; value: string }>;
          }> = JSON.parse(report);
          const server = servers[0];
          if (server === undefined) return yield* Effect.die('Delegation server missing');
          // A capability is only usable while its parent Turn is live. Keep one open across the calls.
          yield* sessions.prompt(parent, text('hold'));
          const call = () =>
            fetch(server.url, {
              method: 'POST',
              headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'delegate', arguments: { task: 'echo:once', requestId: 'retry' } },
              }),
            }).then((response) => response.json());
          const [first, second] = yield* Effect.promise(() => Promise.all([call(), call()]));
          expect(first.result.content[0].text).toBe('once');
          expect(second).toEqual(first);
          expect(
            (yield* store.listAll).filter((meta) => meta.parentSessionId === parent),
          ).toHaveLength(1);
          yield* sessions.cancel(parent);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'rejects a delegated Worker call once the parent Turn has ended',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('report-mcp-servers'));
          const report = agentReply(transcript(yield* untilTurnEnd(events(parent))));
          const servers: ReadonlyArray<{
            url: string;
            headers: ReadonlyArray<{ name: string; value: string }>;
          }> = JSON.parse(report);
          const server = servers[0];
          if (server === undefined) return yield* Effect.die('Delegation server missing');
          const response = yield* Effect.promise(() =>
            fetch(server.url, {
              method: 'POST',
              headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'delegate',
                  arguments: { task: 'echo:stale', requestId: 'after-turn' },
                },
              }),
            }),
          );
          expect(response.status).not.toBe(200);
          expect(
            (yield* store.listAll).filter((meta) => meta.parentSessionId === parent),
          ).toHaveLength(0);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'shows an owned Worker waiting for permission',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: parent, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(parent, text('delegate:ask'));
          const waiting = yield* liveState(
            parent,
            (state) => state.workers?.some((worker) => worker.state === 'requiresAction') === true,
          );
          const worker = waiting.workers?.find((item) => item.state === 'requiresAction');
          if (worker === undefined) return yield* Effect.die('Waiting Worker missing');
          yield* sessions.cancel(worker.sessionId);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'tracks an owned Worker through completion and a later Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('delegate:busy'));
          const running = yield* liveState(
            parent,
            (state) => state.workers?.some((worker) => worker.state === 'running') === true,
          );
          const worker = running.workers?.find((item) => item.state === 'running');
          if (worker === undefined) return yield* Effect.die('Owned Worker missing');
          yield* sessions.cancel(worker.sessionId);
          yield* liveState(
            parent,
            (state) =>
              state.workers?.some(
                (item) => item.sessionId === worker.sessionId && item.state === 'idle',
              ) === true,
          );
          yield* sessions.prompt(worker.sessionId, text('busy'));
          yield* liveState(
            parent,
            (state) =>
              state.workers?.some(
                (item) => item.sessionId === worker.sessionId && item.state === 'running',
              ) === true,
          );
          yield* sessions.cancel(worker.sessionId);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'opens an owned Worker as its own writable Session',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          const parentMeta = yield* store.get(parent);
          const child = SessionId.make('owned-child');
          const context = AgentContextId.make('owned-context');
          yield* store.createDraft({
            ...parentMeta,
            id: child,
            parentSessionId: parent,
            workerKind: 'owned',
            activeContextId: context,
            contexts: [
              {
                id: context,
                agentId: parentMeta.agentId,
                acpSessionIds: [],
                createdAt: parentMeta.createdAt,
              },
            ],
          });
          yield* sessions.prompt(child, text('echo:child reply'));
          expect(agentReply(transcript(yield* untilTurnEnd(events(child))))).toBe('child reply');
          const state = yield* liveState(child, (current) => current.parentSessionId !== undefined);
          expect(state.workerKind).toBe('owned');
          expect(state.parentSessionId).toBe(parent);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'discovers an announced Worker and routes its transcript through Sessions',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('spawn-worker'));
          const state = yield* liveState(parent, (current) => (current.workers?.length ?? 0) > 0);
          const worker = state.workers?.[0];
          expect(worker?.title).toBe('Research');
          if (worker === undefined) return yield* Effect.die('Worker missing');
          const reply = yield* events(worker.sessionId).pipe(
            Stream.filter(
              (item) => item._tag === 'Transcript' && item.event.item._tag === 'Message',
            ),
            Stream.runHead,
          );
          expect(agentReply(transcript(Option.toArray(reply)))).toBe('child output');
          const finished = yield* untilTurnEnd(events(worker.sessionId));
          expect(agentReply(transcript(finished))).toBe('child output');
          const idle = yield* liveState(
            parent,
            (current) => current.workers?.[0]?.state === 'idle',
          );
          expect(idle.workers?.map((item) => item.sessionId)).toEqual([worker.sessionId]);
          const error = yield* sessions.prompt(worker.sessionId, text('hello')).pipe(Effect.flip);
          expect(error.reason).toBe('Unsupported');
          const workerState = yield* liveState(
            worker.sessionId,
            (current) => current.parentSessionId !== undefined,
          );
          expect(workerState.parentSessionId).toBe(parent);
          expect(workerState.workerKind).toBe('native');
          expect((yield* sessions.list(project)).some((item) => item.id === worker.sessionId)).toBe(
            false,
          );
        }),
      ),
    TIMEOUT,
  );

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
          expect(kept.at(-1)).toMatchObject({
            _tag: 'TurnEnded',
            turnId,
            outcome: { _tag: 'done' },
          });
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
          expect(kept.at(-1)).toMatchObject({
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
          expect(kept.at(-1)).toMatchObject({
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
          // The Agent's own clear is advertised; the renderer reserves `/clear` for Spence.
          expect(ready.commands.map((command) => command.name)).toEqual([
            'clear',
            'compact',
            'review',
          ]);
          expect(ready.commands[0]).toMatchObject({
            owner: { kind: 'agent', name: fakeEntry().name },
            kind: 'command',
            invocation: '/clear',
          });
          expect(ready.commandsLoaded).toBe(true);

          yield* sessions.setOption({ sessionId: id, option: 'effort', value: 'high' });
          yield* sessions.setOption({ sessionId: id, option: 'model', value: 'large' });
          const set = yield* liveState(id, (state) => state.options.model?.value === 'large');
          expect(set.options.effort?.value).toBe('high');

          const turnId = yield* sessions.prompt(id, text('echo:hi'));
          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept[0]).toEqual({
            _tag: 'TurnStarted',
            turnId,
            agentId: fakeEntry().id,
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
          expect(meta.contexts).toHaveLength(2);
          expect(meta.contexts[0]?.retiredAt).toBeTypeOf('number');
          expect(meta.contexts[1]?.id).toBe(meta.activeContextId);
          expect(meta.contexts[1]?.acpSessionIds[0]).not.toBe(meta.contexts[0]?.acpSessionIds[0]);
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
          expect(kept.at(-1)).toMatchObject({
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
          expect(kept.at(-1)).toMatchObject({
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
            expect(kept.at(-1)).toMatchObject({
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
            const s2AcpIds = activeContextOf(yield* storeService.get(s2))?.acpSessionIds ?? [];
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

  it.effect(
    'clears 5s cancel grace cleanly when the Turn settles before 5 seconds',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.setTabs([id], id);
          yield* agentStatus(id, 'ready');

          const observed: Array<LiveState> = [];
          const collect = yield* events(id).pipe(
            Stream.tap((item) =>
              Effect.sync(() => {
                if (item._tag === 'Live') observed.push(item.state);
              }),
            ),
            Stream.runDrain,
            Effect.forkChild,
          );

          yield* sessions.prompt(id, text('hold'));
          yield* agentAnswering(id);
          yield* sessions.cancel(id);
          yield* untilTurnEnd(events(id));

          yield* TestClock.adjust('6 seconds');
          yield* Effect.yieldNow;

          expect(observed.some((state) => state.cancelGrace?.phase === 'ready')).toBe(false);
          const latest = yield* liveState(id, () => true);
          expect(latest.cancelGrace).toBeUndefined();

          yield* Fiber.interrupt(collect);
          yield* AcpClient.use((c) => c.kill(fakeEntry().id));
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    'transitions cancel grace to ready after 5s and tracks live otherWorkingCount',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const a = yield* sessions.create(project);
          const b = yield* sessions.create(project);
          yield* sessions.setTabs([a, b], a);
          yield* agentStatus(a, 'ready');
          yield* agentStatus(b, 'ready');

          yield* sessions.prompt(a, text('stall'));
          yield* agentAnswering(a);
          yield* sessions.cancel(a);

          const waiting0 = yield* liveState(a, (s) => s.cancelGrace?.phase === 'waiting');
          expect(waiting0.cancelGrace).toEqual({ phase: 'waiting', otherWorkingCount: 0 });

          // Another Session starting work on the same Agent updates otherWorkingCount live.
          yield* sessions.prompt(b, text('hold'));
          yield* agentAnswering(b);
          const waiting1 = yield* liveState(a, (s) => s.cancelGrace?.otherWorkingCount === 1);
          expect(waiting1.cancelGrace).toEqual({ phase: 'waiting', otherWorkingCount: 1 });

          yield* TestClock.adjust('5 seconds');
          yield* Effect.yieldNow;

          const ready1 = yield* liveState(a, (s) => s.cancelGrace?.phase === 'ready');
          expect(ready1.cancelGrace).toEqual({ phase: 'ready', otherWorkingCount: 1 });

          // Settling the other Session drops otherWorkingCount back to 0.
          yield* sessions.cancel(b);
          yield* untilTurnEnd(events(b));
          const ready0 = yield* liveState(
            a,
            (s) => s.cancelGrace?.phase === 'ready' && s.cancelGrace.otherWorkingCount === 0,
          );
          expect(ready0.cancelGrace).toEqual({ phase: 'ready', otherWorkingCount: 0 });

          yield* sessions.stopAgent(a, true);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'stopAgent kills immediately when no other Session is working, interrupts the Turn, keeps Transcript, and lets idle Sessions reconnect',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const acp = yield* AcpClient;
          const store = yield* SessionStore;
          const active = yield* sessions.create(project);
          const idle = yield* sessions.create(project);
          yield* sessions.setTabs([active, idle], active);
          yield* agentStatus(active, 'ready');
          yield* agentStatus(idle, 'ready');

          // Give the idle Session an open ACP session and a saved message first.
          yield* sessions.prompt(idle, text('hello'));
          yield* untilTurnEnd(events(idle));
          const firstPid = (yield* acp.connected(fakeEntry().id))?.pid;

          yield* sessions.prompt(active, text('stall'));
          yield* agentAnswering(active);
          yield* sessions.cancel(active);

          const turnEndFiber = yield* untilTurnEnd(events(active)).pipe(Effect.forkChild);
          yield* Effect.yieldNow;

          const result = yield* sessions.stopAgent(active);
          expect(result).toEqual({ _tag: 'stopped', pid: firstPid });

          const endedItems = yield* Fiber.join(turnEndFiber);
          expect(transcript(endedItems)).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: expect.objectContaining({ _tag: 'failed', reason: 'interrupted' }),
            }),
          );
          // Recorded Transcript items are intact.
          const replayed = yield* store.replay(active);
          expect(agentReply(replayed.map((event) => event.item))).toContain('working');
          const latestActive = yield* liveState(active, () => true);
          expect(latestActive.cancelGrace).toBeUndefined();

          // Active Session and idle open ACP session both reconnect cleanly on a fresh process.
          const lastSeq = replayed.at(-1)?.seq;
          yield* sessions.prompt(active, text('echo:recovered'));
          const recoveredEvents = yield* untilTurnEnd(events(active, lastSeq));
          expect(agentReply(transcript(recoveredEvents))).toContain('recovered');

          yield* sessions.prompt(idle, text('hello again'));
          yield* untilTurnEnd(events(idle));
          const secondPid = (yield* acp.connected(fakeEntry().id))?.pid;
          expect(secondPid).toBeDefined();
          expect(secondPid).not.toBe(firstPid);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'stopAgent asks confirmation when other Sessions have active Turns and interrupts all on force',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const a = yield* sessions.create(project);
          const b = yield* sessions.create(project);
          yield* sessions.setTabs([a, b], a);
          yield* agentStatus(a, 'ready');
          yield* agentStatus(b, 'ready');

          yield* sessions.prompt(a, text('stall'));
          yield* agentAnswering(a);
          yield* sessions.prompt(b, text('stall'));
          yield* agentAnswering(b);

          const confirm = yield* sessions.stopAgent(a);
          expect(confirm).toEqual({
            _tag: 'confirmRequired',
            otherWorkingCount: 1,
            agentName: 'Fake',
          });

          const endA = yield* untilTurnEnd(events(a)).pipe(Effect.forkChild);
          const endB = yield* untilTurnEnd(events(b)).pipe(Effect.forkChild);
          yield* Effect.yieldNow;

          const forced = yield* sessions.stopAgent(a, true);
          expect(forced._tag).toBe('stopped');

          const itemsA = transcript(yield* Fiber.join(endA));
          const itemsB = transcript(yield* Fiber.join(endB));
          expect(itemsA).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: expect.objectContaining({ _tag: 'failed', reason: 'interrupted' }),
            }),
          );
          expect(itemsB).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: expect.objectContaining({ _tag: 'failed', reason: 'interrupted' }),
            }),
          );
        }),
      ),
    TIMEOUT,
  );

  describe.runIf(process.platform === 'win32')('observed process exit gate', () => {
    it.effect(
      'blocks retry, clearContext, prompt, and checkExitGate with ExitUnconfirmed until exit confirms',
      () =>
        withSessionsCustom(
          {
            agentArgs: ['--delay-exit=800'],
            pathSources: (root) =>
              Layer.succeed(PathSources, {
                platform: 'win32',
                env: {
                  ...Object.fromEntries(
                    Object.entries(process.env).filter(
                      (entry): entry is [string, string] => entry[1] !== undefined,
                    ),
                  ),
                  ComSpec:
                    process.env['ComSpec'] ??
                    process.env['COMSPEC'] ??
                    'C:\\Windows\\System32\\cmd.exe',
                  SystemRoot: path.join(root, 'no-windows'),
                },
                readRegistryPath: () => Effect.succeed(Option.none()),
                readLoginShellPath: Effect.succeed(Option.none()),
              }),
          },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const a = yield* sessions.create(project);
              yield* sessions.setTabs([a], a);
              yield* agentStatus(a, 'ready');

              yield* sessions.prompt(a, text('stall'));
              yield* agentAnswering(a);
              yield* sessions.cancel(a);

              let stopDone = false;
              const stopFiber = yield* sessions.stopAgent(a).pipe(
                Effect.flip,
                Effect.ensuring(
                  Effect.sync(() => {
                    stopDone = true;
                  }),
                ),
                Effect.forkChild,
              );
              while (!stopDone) {
                yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
                yield* TestClock.adjust('5 seconds');
              }
              const stopError = yield* Fiber.join(stopFiber);
              expect(stopError._tag).toBe('SessionError');
              expect(stopError.reason).toBe('ExitUnconfirmed');
              expect(stopError.detail).toContain('killTimedOut');

              const gated = yield* liveState(a, (s) => s.unconfirmedExit !== undefined);
              expect(gated.unconfirmedExit?.state).toBe('killTimedOut');
              expect(gated.unconfirmedExit?.pid).toBeTypeOf('number');

              const gateErr = yield* sessions.checkExitGate(a).pipe(Effect.flip);
              expect(gateErr.reason).toBe('ExitUnconfirmed');
              const retryErr = yield* sessions.retryAgent(a).pipe(Effect.flip);
              expect(retryErr.reason).toBe('ExitUnconfirmed');
              const clearErr = yield* sessions.clearContext(a).pipe(Effect.flip);
              expect(clearErr.reason).toBe('ExitUnconfirmed');
              const promptErr = yield* sessions.prompt(a, text('blocked')).pipe(Effect.flip);
              expect(promptErr.reason).toBe('ExitUnconfirmed');

              // Wait for the real 800ms delayed process exit to clear the gate.
              const cleared = yield* liveState(a, (s) => s.unconfirmedExit === undefined);
              expect(cleared.unconfirmedExit).toBeUndefined();
              yield* sessions.checkExitGate(a);

              // Retry succeeds once exit has been confirmed.
              yield* sessions.retryAgent(a);
              yield* agentStatus(a, 'ready');
              let cleanupDone = false;
              const cleanup = yield* AcpClient.use((c) => c.kill(AgentId.make('fake'))).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    cleanupDone = true;
                  }),
                ),
                Effect.forkChild,
              );
              while (!cleanupDone) {
                yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
                yield* TestClock.adjust('5 seconds');
              }
              yield* Fiber.join(cleanup);
              yield* liveState(a, (s) => s.unconfirmedExit === undefined);
            }),
        ),
      TIMEOUT,
    );
  });

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
      loginInstructions:
        'Sign in with your Google account in Google Antigravity, then click Log in or try again.',
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
      'falls back to native --version (cached per binary path and mtime) when initialize.agentInfo.version is absent',
      () => {
        const previousCliVersion = process.env['FAKE_CLI_VERSION'];
        process.env['FAKE_CLI_VERSION'] = '1.2.0';
        const agyNoInitVersion = fakeEntry(['--no-agent-info-version'], {
          id: AgentId.make('antigravity'),
          name: 'Antigravity',
          installKind: 'native',
          package: '',
          qualification: { kind: 'min', version: '1.2.0' },
        });
        return withSessionsCustom(
          { catalog: [agyNoInitVersion], fallbackAgentId: agyNoInitVersion.id },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const id = yield* sessions.create(project);
              const ready = yield* liveState(id, (next) => next.agentStatus === 'ready');
              expect(ready.installedVersion).toBe('1.2.0');
              expect(ready.versionQualification).toBe('qualified');
            }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousCliVersion === undefined) delete process.env['FAKE_CLI_VERSION'];
              else process.env['FAKE_CLI_VERSION'] = previousCliVersion;
            }),
          ),
        );
      },
      TIMEOUT,
    );

    it.live(
      'maps -32000 for Antigravity to needsLogin with Google account login instructions and surfaces missing acp subcommand as cantStart',
      () =>
        withSessionsCustom(
          {
            catalog: [
              agyFake,
              fakeEntry(['--no-acp'], {
                id: AgentId.make('codex'),
                name: 'Antigravity (no acp)',
                installKind: 'native',
                package: '',
              }),
            ],
            fallbackAgentId: agyFake.id,
          },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const id = yield* sessions.create(project);
              const ready = yield* liveState(id, (next) => next.agentStatus === 'ready');
              expect(ready.loginInstructions).toContain('Google account');

              yield* sessions.prompt(id, text('login'));
              const ended = transcript(yield* untilTurnEnd(events(id)));
              expect(ended.at(-1)).toMatchObject({
                _tag: 'TurnEnded',
                outcome: { _tag: 'failed', reason: 'needsLogin' },
              });
              const needsLogin = yield* liveState(id, (next) => next.agentStatus === 'needsLogin');
              expect(needsLogin.loginInstructions).toContain('Google account');

              // Missing `acp` subcommand surfaces cantStart ('spawn') with stderr detail.
              const noAcpId = yield* sessions.create(project, AgentId.make('codex'));
              const cantStart = yield* liveState(
                noAcpId,
                (next) => next.agentStatus === 'cantStart',
              );
              expect(cantStart.cantStartReason).toBe('spawn');
              expect(cantStart.cantStartDetail).toContain('missing acp subcommand');
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
      'keeps model value unset instead of silently substituting when filterModels excludes the active model',
      () =>
        withSessionsCustom(
          {
            catalog: [
              {
                ...agyFake,
                filterModels: (models) => ({
                  models: models.filter((model) => model.id !== 'gemini-pro'),
                  excludedNote: 'Default model is ineligible for this client.',
                }),
              },
            ],
            fallbackAgentId: agyFake.id,
          },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const id = yield* sessions.create(project);
              const state = yield* liveState(id, (next) => next.agentStatus === 'ready');
              expect(state.options.model?.choices.map((c) => c.id)).toEqual([
                'claude-sonnet-4',
                'gpt-5',
              ]);
              expect(state.options.model?.value).toBeUndefined();
              expect(state.modelsLimitation).toContain('Third-party models');
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

    it.live(
      'maps Codex -32000 to needsLogin with ChatGPT external login instructions',
      () =>
        withSessionsCustom(
          {
            catalog: [
              {
                ...codexCatalog,
                binary: 'fake-agent',
                args: [],
              },
            ],
            fallbackAgentId: codexCatalog.id,
          },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const id = yield* sessions.create(project, codexCatalog.id);
              yield* agentStatus(id, 'ready');
              yield* sessions.prompt(id, text('login'));
              yield* untilTurnEnd(events(id));
              const state = yield* liveState(id, (next) => next.agentStatus === 'needsLogin');
              expect(state.loginInstructions).toContain('ChatGPT');
            }),
        ),
      TIMEOUT,
    );

    it.live(
      'runs unverified codex-acp with upgrade notice on protocolVersion 1 and fails incompatible versions as cantStart',
      () =>
        withSessionsCustom(
          {
            catalog: [
              {
                ...codexCatalog,
                binary: 'fake-agent',
                args: ['--version=2.5.0', '--codex-fixture'],
              },
              {
                ...codexCatalog,
                id: AgentId.make('codex-bad'),
                binary: 'fake-agent',
                args: ['--protocol=2', '--version=2.6.0'],
              },
            ],
            fallbackAgentId: codexCatalog.id,
          },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const unverifiedId = yield* sessions.create(project, codexCatalog.id);
              const unverified = yield* liveState(
                unverifiedId,
                (next) => next.agentStatus === 'ready',
              );
              expect(unverified.versionQualification).toBe('unverified');
              expect(unverified.installedVersion).toBe('2.5.0');
              expect(unverified.upgradeCommand).toBe(
                'npm install -g @agentclientprotocol/codex-acp@2.6.0',
              );
              yield* sessions.prompt(unverifiedId, text('echo:codex-ok'));
              yield* untilTurnEnd(events(unverifiedId));

              const badId = yield* sessions.create(project, AgentId.make('codex-bad'));
              const bad = yield* liveState(badId, (next) => next.agentStatus === 'cantStart');
              expect(bad.cantStartReason).toBe('protocolVersion');
            }),
        ),
      TIMEOUT,
    );

    it.live(
      'verifies Codex models, effort, Auto/Ask permission modes, exceptional Dock confirmations, images, and usage_update',
      () =>
        withSessionsCustom(
          {
            catalog: [
              {
                ...codexCatalog,
                binary: 'fake-agent',
                args: ['--version=2.6.0', '--codex-fixture'],
              },
              {
                ...codexCatalog,
                id: AgentId.make('codex-no-images'),
                binary: 'fake-agent',
                args: ['--version=2.6.0', '--codex-fixture', '--no-images'],
              },
            ],
            fallbackAgentId: codexCatalog.id,
          },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const id = yield* sessions.create(project, codexCatalog.id);
              const ready = yield* liveState(id, (next) => next.agentStatus === 'ready');
              expect(ready.versionQualification).toBe('qualified');
              expect(ready.canAttachImages).toBe(true);
              expect(ready.options.model?.choices.map((m) => m.id)).toEqual([
                'gpt-5.3-codex',
                'gpt-5.4-codex',
              ]);
              expect(ready.options.effort?.choices).toEqual(['low', 'medium', 'high', 'max']);

              yield* sessions.setOption({ sessionId: id, option: 'model', value: 'gpt-5.4-codex' });
              yield* sessions.setOption({ sessionId: id, option: 'effort', value: 'high' });
              const updated = yield* liveState(
                id,
                (next) =>
                  next.options.model?.value === 'gpt-5.4-codex' &&
                  next.options.effort?.value === 'high',
              );
              expect(updated.options.permissionMode).toBe('auto');

              // Auto mode maps to Codex `auto`, auto-allows `allow_once` by policy,
              // and still surfaces exceptional confirmations without `allow_once` in the Dock.
              yield* sessions.prompt(id, text('mode'));
              const modeReplay = yield* untilTurnEnd(events(id));
              expect(agentReply(transcript(modeReplay))).toBe('auto');

              yield* sessions.prompt(id, text('permit'));
              const policyTurn = yield* untilTurnEnd(events(id, seqs(modeReplay).at(-1)));
              expect(agentReply(transcript(policyTurn))).toBe('permission allow');
              expect(
                transcript(policyTurn).some(
                  (item) =>
                    item._tag === 'PermissionRequest' &&
                    item.state._tag === 'answered' &&
                    item.state.by === 'policy',
                ),
              ).toBe(true);

              yield* sessions.prompt(id, text('permit-no-allow-once'));
              const req = yield* permissionRequest(id, 'pending');
              expect(req.options.some((o) => o.kind === 'allowOnce')).toBe(false);
              const alwaysOpt = req.options.find((o) => o.kind === 'allowAlways');
              expect(alwaysOpt).toBeDefined();
              if (alwaysOpt !== undefined) {
                yield* sessions.answerPermission(id, req.id, alwaysOpt.id);
              }
              const afterExceptional = yield* untilTurnEnd(events(id, seqs(policyTurn).at(-1)));

              // Ask mode maps to Codex `read-only` and routes `permit` to the user Dock.
              yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
              yield* sessions.prompt(id, text('mode'));
              const askModeReplay = yield* untilTurnEnd(events(id, seqs(afterExceptional).at(-1)));
              expect(agentReply(transcript(askModeReplay))).toBe('read-only');

              yield* sessions.prompt(id, text('permit'));
              const askReq = yield* events(id, seqs(askModeReplay).at(-1)).pipe(
                Stream.flatMap((item) =>
                  item._tag === 'Transcript' &&
                  item.event.item._tag === 'PermissionRequest' &&
                  item.event.item.state._tag === 'pending'
                    ? Stream.make(item.event.item)
                    : Stream.empty,
                ),
                Stream.runHead,
                Effect.map(Option.getOrThrow),
              );
              const allowOnceOpt = askReq.options.find((o) => o.kind === 'allowOnce');
              expect(allowOnceOpt).toBeDefined();
              if (allowOnceOpt !== undefined) {
                yield* sessions.answerPermission(id, askReq.id, allowOnceOpt.id);
              }
              yield* untilTurnEnd(events(id, seqs(askModeReplay).at(-1)));

              // usage_update populates ContextUsage while cumulative Usage does not.
              yield* sessions.prompt(id, text('cumulative-only'));
              yield* untilTurnEnd(events(id));
              const beforeUsage = yield* liveState(
                id,
                (next) => next.contextUsage?._tag === 'unavailable',
              );
              expect(beforeUsage.contextUsage).toEqual({ _tag: 'unavailable' });

              yield* sessions.prompt(id, text('usage:24000/200000'));
              yield* untilTurnEnd(events(id));
              const reported = yield* liveState(
                id,
                (next) => next.contextUsage?._tag === 'reported',
              );
              expect(reported.contextUsage).toEqual({
                _tag: 'reported',
                used: 24000,
                capacity: 200000,
              });

              // Images gating disables attachments when promptCapabilities.image is false.
              const noImgId = yield* sessions.create(project, AgentId.make('codex-no-images'));
              const noImgState = yield* liveState(noImgId, (next) => next.agentStatus === 'ready');
              expect(noImgState.canAttachImages).toBe(false);
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
      const agentsLayer = layerAgents.pipe(
        Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(install.bin) })),
        Layer.provide(layerPathSources),
      );
      const deleteQueue = layerDeleteQueue.pipe(Layer.provide(Layer.mergeAll(store, acpClient)));
      const layer = layerSessions.pipe(
        Layer.provideMerge(projects),
        Layer.provideMerge(sessionStore),
        Layer.provideMerge(remembered),
        Layer.provideMerge(deleteQueue),
        Layer.provideMerge(store),
        Layer.provide(settings),
        Layer.provide(agentsLayer),
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

  it.effect(
    'surfaces cancelGrace for stalled Compaction and settles active Compaction on stopAgent',
    () =>
      withSessionsCustom({ agentArgs: ['--compact-hold', '--stall-cancel'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const a = yield* sessions.create(project);
          const b = yield* sessions.create(project);
          yield* sessions.setTabs([a, b], a);
          yield* liveState(a, (state) => state.agentStatus === 'ready');
          yield* liveState(b, (state) => state.agentStatus === 'ready');

          const seq = yield* sendAndEnd(a, 'usage:40000/200000', 0);
          yield* sessions.compact(a);
          yield* liveState(a, (state) => state.compacting === true);

          yield* sessions.cancel(a);
          const waiting = yield* liveState(a, (state) => state.cancelGrace?.phase === 'waiting');
          expect(waiting.cancelGrace).toEqual({ phase: 'waiting', otherWorkingCount: 0 });

          yield* TestClock.adjust('5 seconds');
          yield* Effect.yieldNow;
          const ready = yield* liveState(a, (state) => state.cancelGrace?.phase === 'ready');
          expect(ready.cancelGrace).toEqual({ phase: 'ready', otherWorkingCount: 0 });

          // Another Session compacting on the same Agent counts as otherWorking.
          yield* sessions.compact(b);
          yield* liveState(b, (state) => state.compacting === true);
          const confirm = yield* sessions.stopAgent(a);
          expect(confirm).toEqual({
            _tag: 'confirmRequired',
            otherWorkingCount: 1,
            agentName: 'Fake',
          });

          const stopped = yield* sessions.stopAgent(a, true);
          expect(stopped._tag).toBe('stopped');

          const settledA = yield* liveState(
            a,
            (state) => state.compacting !== true && state.cancelGrace === undefined,
          );
          expect(settledA.contextUsage).toEqual({
            _tag: 'historical',
            used: 40_000,
            capacity: 200_000,
          });
          const settledB = yield* liveState(b, (state) => state.compacting !== true);
          expect(settledB.compacting).toBeUndefined();

          const tail = yield* events(a, seq).pipe(
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
      ),
    TIMEOUT,
  );
});

const messageText = (item: TranscriptItem): string =>
  item._tag === 'Message'
    ? item.parts.map((part) => (part._tag === 'text' ? part.text : '')).join('')
    : '';

const userTexts = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
  items.flatMap((item) =>
    item._tag === 'Message' && item.role === 'user' ? [messageText(item)] : [],
  );

const steeredTexts = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
  items.flatMap((item) =>
    item._tag === 'Message' && item.role === 'user' && item.steer === true
      ? [messageText(item)]
      : [],
  );

const until = <E, R>(
  stream: Stream.Stream<SessionStreamItem, E, R>,
  predicate: (item: SessionStreamItem) => boolean,
) =>
  stream.pipe(
    Stream.takeUntil(predicate),
    Stream.runCollect,
    Effect.map((items) => [...items]),
  );

const isSteerMessage = (text: string) => (item: SessionStreamItem) =>
  item._tag === 'Transcript' &&
  item.event.item._tag === 'Message' &&
  item.event.item.role === 'user' &&
  item.event.item.steer === true &&
  messageText(item.event.item) === text;

const isPendingPermission = (item: SessionStreamItem) =>
  item._tag === 'Transcript' &&
  item.event.item._tag === 'PermissionRequest' &&
  item.event.item.state._tag === 'pending';

describe('Queue and Steer', () => {
  it.live(
    'steers a running Turn in place, preserving its Thought and output, in arrival order',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const ready = yield* liveState(
            id,
            (state) => state.agentStatus === 'ready' && state.steeringSupported === true,
          );
          expect(ready.steeringSupported).toBe(true);

          yield* sessions.prompt(id, text('steer-hold'));
          const running = yield* liveState(id, (state) => state.runningTurn !== undefined);

          yield* sessions.steer(id, text('first'));
          yield* sessions.steer(id, text('second'));

          yield* sessions.cancel(id);
          const items = transcript(yield* untilTurnEnd(events(id)));
          const turnId = running.runningTurn;
          expect(turnId).toBeDefined();
          expect(steeredTexts(items)).toEqual(['first', 'second']);
          for (const message of items) {
            if (message._tag === 'Message' && message.steer === true) {
              expect(message.turnId).toBe(turnId);
            }
          }
          expect(items.filter((item) => item._tag === 'TurnStarted')).toHaveLength(1);
          expect(
            items.flatMap((item) => (item._tag === 'Thought' ? [item.text] : [])).join(''),
          ).toContain('Planning the Turn.');
          expect(agentReply(items)).toContain('working');
          expect(agentReply(items)).toContain('steered:first');
          expect(agentReply(items)).toContain('steered:second');
          expect(items).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              turnId,
              outcome: { _tag: 'cancelled' },
            }),
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'steer supersedes a pending Permission request, answering it cancelled',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(id, text('ask'));

          const pending = yield* until(events(id), isPendingPermission);
          const seq = seqs(pending).at(-1) ?? 0;
          yield* sessions.steer(id, text('redirect'));

          const tail = transcript(yield* until(events(id, seq), isSteerMessage('redirect')));
          expect(tail).toContainEqual(
            expect.objectContaining({
              _tag: 'PermissionRequest',
              state: { _tag: 'cancelled' },
            }),
          );
          expect(steeredTexts(tail)).toEqual(['redirect']);

          yield* sessions.cancel(id);
          yield* untilTurnEnd(events(id));
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'refuses Steer when no Turn runs or when the Agent cannot steer',
    () =>
      withSessionsCustom({ agentArgs: ['--no-steering'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');

          const idle = yield* sessions.steer(id, text('too early')).pipe(Effect.flip);
          expect(idle.reason).toBe('NotRunning');

          yield* sessions.prompt(id, text('hold'));
          yield* liveState(id, (state) => state.runningTurn !== undefined);
          const unsupported = yield* sessions.steer(id, text('nope')).pipe(Effect.flip);
          expect(unsupported.reason).toBe('Unsupported');

          yield* sessions.cancel(id);
          yield* untilTurnEnd(events(id));
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'steers a native-Steering Agent with a mid-Turn prompt',
    () =>
      withSessionsCustom({ catalog: [fakeEntry([], { nativeSteering: true })] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const ready = yield* liveState(id, (state) => state.agentStatus === 'ready');
          expect(ready.steeringSupported).toBe(true);
          yield* sessions.prompt(id, text('hold'));
          const running = yield* liveState(id, (state) => state.runningTurn !== undefined);

          yield* sessions.steer(id, text('echo:native'));
          const tail = transcript(yield* until(events(id), isSteerMessage('echo:native')));
          expect(steeredTexts(tail)).toEqual(['echo:native']);
          // Wait for the native prompt's reply to finish streaming before the Turn ends.
          yield* until(
            events(id),
            (item) =>
              item._tag === 'Transcript' &&
              item.event.item._tag === 'MessageDelta' &&
              item.event.item.text === 've',
          );

          yield* sessions.cancel(id);
          const end = transcript(yield* untilTurnEnd(events(id)));
          expect(agentReply(end)).toContain('native');
          expect(end).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              turnId: running.runningTurn,
              outcome: { _tag: 'cancelled' },
            }),
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'queues FIFO, replaces the Queue whole, and drains one Message per settled Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');
          yield* sessions.prompt(id, text('hold'));
          yield* liveState(id, (state) => state.runningTurn !== undefined);

          yield* sessions.enqueue(id, text('echo:first'));
          yield* sessions.enqueue(id, text('echo:second'));
          const queued = yield* liveState(id, (state) => state.queue.length === 2);
          const [first, second] = queued.queue;
          if (first === undefined || second === undefined) {
            return yield* Effect.die('the Queue lost a Message');
          }

          // Reorder matters: the Queue sends the order the user sees.
          yield* sessions.setQueue(id, [second, first]);
          yield* liveState(id, (state) => state.queue[0]?.id === second.id);

          // Edit in place: the same Message, new text.
          const edited: QueuedMessage = {
            ...first,
            parts: [{ _tag: 'text', text: 'echo:edited' }],
          };
          yield* sessions.setQueue(id, [second, edited]);
          const replaced = yield* liveState(
            id,
            (state) => state.queue[1]?.parts[0]?._tag === 'text',
          );
          expect(
            replaced.queue[1]?.parts.map((part) => (part._tag === 'text' ? part.text : '')),
          ).toEqual(['echo:edited']);

          // Remove one, then clear all; what is enqueued again is what drains.
          yield* sessions.setQueue(id, [edited]);
          yield* liveState(id, (state) => state.queue.length === 1);
          yield* sessions.clearQueue(id);
          yield* liveState(id, (state) => state.queue.length === 0);
          yield* sessions.enqueue(id, text('echo:first'));
          yield* sessions.enqueue(id, [
            { _tag: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
            { _tag: 'text', text: 'echo:second' },
          ]);

          // Cancel never clears the Queue: both Messages become their own Turns.
          yield* sessions.cancel(id);
          const firstEnd = transcript(yield* untilTurnEnd(events(id)));
          expect(firstEnd).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: { _tag: 'cancelled' },
            }),
          );
          let seq = seqs(yield* untilTurnEnd(events(id))).at(-1) ?? 0;
          const secondTurn = transcript(yield* untilTurnEnd(events(id, seq)));
          expect(userTexts(secondTurn)).toEqual(['echo:first']);
          seq = seqs(yield* untilTurnEnd(events(id, seq))).at(-1) ?? seq;
          const thirdTurn = transcript(yield* untilTurnEnd(events(id, seq)));
          expect(userTexts(thirdTurn)).toEqual(['echo:second']);
          const queuedUser = thirdTurn.find(
            (item) => item._tag === 'Message' && item.role === 'user',
          );
          expect(queuedUser).toMatchObject({
            parts: expect.arrayContaining([
              { _tag: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
            ]),
          });
          yield* liveState(id, (state) => state.queue.length === 0);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'halts the Queue on a failed Turn and keeps its Messages until a later Turn settles',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');
          yield* sessions.prompt(id, text('hold'));
          yield* liveState(id, (state) => state.runningTurn !== undefined);
          yield* sessions.enqueue(id, text('echo:queued'));

          yield* sessions.stopAgent(id, true);
          const failed = transcript(yield* untilTurnEnd(events(id)));
          expect(failed).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: expect.objectContaining({ _tag: 'failed', reason: 'interrupted' }),
            }),
          );
          const held = yield* liveState(id, (state) => state.queue.length === 1);
          expect(held.queue).toHaveLength(1);

          yield* sessions.prompt(id, text('echo:recovered'));
          let seq = seqs(yield* untilTurnEnd(events(id))).at(-1) ?? 0;
          const recovered = transcript(yield* untilTurnEnd(events(id, seq)));
          expect(userTexts(recovered)).toEqual(['echo:recovered']);
          seq = seqs(yield* untilTurnEnd(events(id, seq))).at(-1) ?? seq;
          const drained = transcript(yield* untilTurnEnd(events(id, seq)));
          expect(userTexts(drained)).toEqual(['echo:queued']);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'sends the Queue immediately when idle, survives resubscription, and is lost with its Tab',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');

          yield* sessions.enqueue(id, text('echo:idle'));
          const idle = transcript(yield* untilTurnEnd(events(id)));
          expect(userTexts(idle)).toEqual(['echo:idle']);

          yield* sessions.prompt(id, text('hold'));
          yield* liveState(id, (state) => state.runningTurn !== undefined);
          yield* sessions.enqueue(id, text('echo:kept'));
          // A new subscription is a window reload: the Queue is still in main.
          const reloaded = yield* liveState(id, (state) => state.queue.length === 1);
          expect(reloaded.queue).toHaveLength(1);

          yield* sessions.setTabs([id], id);
          yield* sessions.setTabs([], undefined);
          yield* liveState(id, (state) => state.queue.length === 0);

          yield* sessions.cancel(id);
          yield* untilTurnEnd(events(id));
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'drains on refused and cutShort Turns',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const refused = yield* sessions.create(project);
          yield* liveState(refused, (state) => state.agentStatus === 'ready');
          yield* sessions.prompt(refused, text('hold'));
          yield* liveState(refused, (state) => state.runningTurn !== undefined);
          yield* sessions.enqueue(refused, text('refuse'));
          yield* sessions.enqueue(refused, text('echo:after-refuse'));
          yield* sessions.cancel(refused);

          let seq = seqs(yield* untilTurnEnd(events(refused))).at(-1) ?? 0;
          const refusedTurn = transcript(yield* untilTurnEnd(events(refused, seq)));
          expect(userTexts(refusedTurn)).toEqual(['refuse']);
          expect(refusedTurn).toContainEqual(
            expect.objectContaining({ _tag: 'TurnEnded', outcome: { _tag: 'refused' } }),
          );
          seq = seqs(yield* untilTurnEnd(events(refused, seq))).at(-1) ?? seq;
          const afterRefuse = transcript(yield* untilTurnEnd(events(refused, seq)));
          expect(userTexts(afterRefuse)).toEqual(['echo:after-refuse']);

          const cut = yield* sessions.create(project);
          yield* liveState(cut, (state) => state.agentStatus === 'ready');
          yield* sessions.prompt(cut, text('hold'));
          yield* liveState(cut, (state) => state.runningTurn !== undefined);
          yield* sessions.enqueue(cut, text('max-tokens'));
          yield* sessions.enqueue(cut, text('echo:after-cut'));
          yield* sessions.cancel(cut);

          let cutSeq = seqs(yield* untilTurnEnd(events(cut))).at(-1) ?? 0;
          const cutTurn = transcript(yield* untilTurnEnd(events(cut, cutSeq)));
          expect(userTexts(cutTurn)).toEqual(['max-tokens']);
          expect(cutTurn).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: expect.objectContaining({ _tag: 'cutShort' }),
            }),
          );
          cutSeq = seqs(yield* untilTurnEnd(events(cut, cutSeq))).at(-1) ?? cutSeq;
          const afterCut = transcript(yield* untilTurnEnd(events(cut, cutSeq)));
          expect(userTexts(afterCut)).toEqual(['echo:after-cut']);
        }),
      ),
    TIMEOUT,
  );
});
