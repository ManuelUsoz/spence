import { layerHistoryStore } from '../history/history-store';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option, Stream } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import type { ProjectId } from '../../src/shared/projects/projects.rpc';
import type {
  LiveState,
  SessionId,
  SessionStreamItem,
} from '../../src/shared/sessions/sessions.rpc';
import type { AcpClient } from '../acp/acpSessionManager';
import { fakeEntry, installFakeAgent, layerAcpClientWithFakeAgent } from '../acp/acpFakes';
import { layerAgentLifetime } from '../acp/acpLifetime';
import type { CatalogEntry } from '../agents/catalog';
import { layerPathSources, MergedPath } from '../agents/merged-path';
import { layerAgents } from '../agents/agents';
import { FolderPicker, Folders } from '../projects/folders';
import { layerProjects, Projects } from '../projects/projects';
import { layerRemembered } from '../settings/remembered';
import { layerSettings, WindowSettings } from '../settings/settings';
import { layerStore } from '../store/store';
import { layerReservationCoordinator } from '../source-control/reservation-coordinator';
import { layerWorktreesStub } from '../worktrees/worktrees';
import { layerDeleteQueue } from './delete-queue';
import { AgentCatalog, makeAgentCatalog } from './session-agent';
import { layerSessionStore, SessionStore } from './session-store';
import { layerSessions, Sessions } from './sessions';

const TIMEOUT = 30_000;

const makeEntry = (
  id: string,
  name: string,
  args: ReadonlyArray<string>,
  overrides: Partial<CatalogEntry['capabilities']> = {},
): CatalogEntry =>
  fakeEntry(args, {
    id: AgentId.make(id),
    name,
    capabilities: { ...fakeEntry().capabilities, ...overrides },
  });

const withCatalog = <A, E>(
  buildCatalog: () => ReadonlyArray<CatalogEntry>,
  body: (project: ProjectId) => Effect.Effect<A, E, Sessions | Projects | AcpClient | SessionStore>,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-handoff-'))),
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
        Layer.succeed(FolderPicker, { pick: Effect.succeed(Option.some(process.cwd())) }),
      ),
      Layer.provide(layerWorktreesStub),
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
    const agents = layerAgents.pipe(
      Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(install.bin) })),
      Layer.provide(layerPathSources),
    );
    const lifetime = layerAgentLifetime.pipe(Layer.provide(acpClient), Layer.provide(agents));
    const catalogEntries = buildCatalog();
    const catalog = Layer.succeed(
      AgentCatalog,
      makeAgentCatalog(catalogEntries, catalogEntries[0]!.id),
    );
    const deleteQueue = layerDeleteQueue.pipe(
      Layer.provide(store),
      Layer.provide(acpClient),
      Layer.provide(catalog),
    );
    const sessions = layerSessions.pipe(
      Layer.provide(layerHistoryStore.pipe(Layer.provide(store))),
      Layer.provide(sessionStore),
      Layer.provide(deleteQueue),
      Layer.provide(lifetime),
      Layer.provide(acpClient),
      Layer.provide(catalog),
      Layer.provide(agents),
      Layer.provide(projects),
      Layer.provide(settings),
      Layer.provide(remembered),
      Layer.provide(layerWorktreesStub),
      Layer.provide(layerReservationCoordinator),
    );

    const layer = Layer.mergeAll(
      sessions,
      projects,
      acpClient,
      sessionStore,
      settings,
      remembered,
      catalog,
    );

    return yield* Effect.gen(function* () {
      const project = yield* Projects.use((p) => p.add);
      if (project === null) return yield* Effect.die('the picker answered nothing');
      return yield* body(project.id);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

const liveState = (id: SessionId, predicate: (state: LiveState) => boolean) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const last = yield* sessions.events(id).pipe(
      Stream.filter(
        (item): item is Extract<SessionStreamItem, { _tag: 'Live' }> => item._tag === 'Live',
      ),
      Stream.takeUntil((item) => predicate(item.state)),
      Stream.runLast,
    );
    if (last._tag !== 'Some') return yield* Effect.die('stream ended without matching LiveState');
    return last.value.state;
  });

const sendAndEnd = (id: SessionId, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const turnId = yield* sessions.prompt(id, [{ _tag: 'text', text }]);
    yield* sessions.events(id).pipe(
      Stream.takeUntil(
        (item) =>
          item._tag === 'Transcript' &&
          item.event.item._tag === 'TurnEnded' &&
          item.event.item.turnId === turnId,
      ),
      Stream.runDrain,
    );
    return turnId;
  });

describe('Sessions Summary handoff', () => {
  it.live(
    'prepares isolated tool-disabled summary when supported, falls back otherwise, and commits switch only on clean acknowledgement',
    () =>
      withCatalog(
        () => [
          makeEntry('claude', 'Claude', ['--isolated'], { supportsIsolatedSummary: true }),
          makeEntry('codex', 'Codex', ['--codex'], { supportsIsolatedSummary: false }),
        ],
        (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const store = yield* SessionStore;
            const id = yield* sessions.create(project, AgentId.make('claude'));
            yield* sessions.setTabs([id], id);
            yield* liveState(id, (s) => s.agentStatus === 'ready');
            const turn1 = yield* sendAndEnd(id, 'echo:Build login page');

            // 1. Isolated summary uses tool-disabled ACP session when supportsIsolatedSummary is true
            const prep = yield* sessions.prepareHandoff({
              sessionId: id,
              kind: 'switch',
              targetAgentId: AgentId.make('codex'),
            });
            expect(prep.draftSource).toBe('isolatedSummary');
            expect(prep.summary).toContain('tools-disabled');
            expect(prep.endpoint.turnId).toBe(turn1);
            expect(prep.endpoint.turnNumber).toBe(1);

            // 2. Endpoint advancement is detected on revalidate and blocked on execute unless allowed
            yield* sendAndEnd(id, 'echo:Add logout button');
            const reval = yield* sessions.revalidateHandoff({
              sessionId: id,
              endpoint: prep.endpoint,
              targetAgentId: AgentId.make('codex'),
              summary: prep.summary,
              selectedImageIds: [],
            });
            expect(reval.endpointAdvanced).toBe(true);
            expect(reval.currentEndpoint.turnNumber).toBe(2);

            const blocked = yield* sessions
              .executeHandoff({
                sessionId: id,
                kind: 'switch',
                endpoint: prep.endpoint,
                targetAgentId: AgentId.make('codex'),
                summary: prep.summary,
                selectedImageIds: [],
              })
              .pipe(Effect.flip);
            expect(blocked.reason).toBe('Busy');

            // 3. Explicit review against new endpoint commits the switch
            const result = yield* sessions.executeHandoff({
              sessionId: id,
              kind: 'switch',
              endpoint: reval.currentEndpoint,
              targetAgentId: AgentId.make('codex'),
              summary: prep.summary,
              selectedImageIds: [],
            });
            expect(result._tag).toBe('committed');

            const switched = yield* liveState(id, (s) => s.agentId === AgentId.make('codex'));
            expect(switched.agentId).toBe(AgentId.make('codex'));
            expect(switched.contextUsage?._tag).toBe('unavailable');

            const meta = yield* store.get(id);
            expect(meta.agentId).toBe(AgentId.make('codex'));
            expect(meta.contexts).toHaveLength(2);

            const transcript = yield* store.replay(id);
            expect(transcript.some((e) => e.item._tag === 'HandoffBoundary')).toBe(true);

            // 4. Outgoing Agent with supportsIsolatedSummary: false falls back to Transcript extract
            const fallbackPrep = yield* sessions.prepareHandoff({
              sessionId: id,
              kind: 'switch',
              targetAgentId: AgentId.make('claude'),
            });
            expect(fallbackPrep.draftSource).toBe('transcriptExtract');
            expect(fallbackPrep.summary).toContain('Goal:');
          }),
      ),
    TIMEOUT,
  );

  it.live(
    'fails handoff on unexpected destination tool call or crash, preserves HandoffAttempt on source, and gates retry on exit confirmation',
    () =>
      withCatalog(
        () => [
          makeEntry('claude', 'Claude', []),
          makeEntry('bad-tool', 'BadTool', ['--handoff-unexpected-tool']),
          makeEntry('crasher', 'Crasher', ['--handoff-crash']),
        ],
        (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const id = yield* sessions.create(project, AgentId.make('claude'));
            yield* sessions.setTabs([id], id);
            yield* liveState(id, (s) => s.agentStatus === 'ready');
            yield* sendAndEnd(id, 'echo:Initial task');

            const prep = yield* sessions.prepareHandoff({
              sessionId: id,
              kind: 'switch',
              targetAgentId: AgentId.make('bad-tool'),
            });

            // Unexpected tool call fails handoff and persists HandoffAttempt without mutating source
            const toolResult = yield* sessions.executeHandoff({
              sessionId: id,
              kind: 'switch',
              endpoint: prep.endpoint,
              targetAgentId: AgentId.make('bad-tool'),
              summary: prep.summary,
              selectedImageIds: [],
            });
            expect(toolResult._tag).toBe('failed');
            if (toolResult._tag === 'failed') {
              expect(toolResult.attempt.status).toBe('failed');
              expect(toolResult.attempt.steps.length).toBeGreaterThan(0);
              expect(toolResult.attempt.diskStateNote).toBeDefined();
            }

            const stillClaude = yield* liveState(id, (s) => s.agentId === AgentId.make('claude'));
            expect(stillClaude.agentId).toBe(AgentId.make('claude'));

            // Crasher crashes during handoff acknowledgement -> interrupted HandoffAttempt
            const crashResult = yield* sessions.executeHandoff({
              sessionId: id,
              kind: 'switch',
              endpoint: prep.endpoint,
              targetAgentId: AgentId.make('crasher'),
              summary: prep.summary,
              selectedImageIds: [],
            });
            expect(crashResult._tag).toBe('failed');
            if (crashResult._tag === 'failed') {
              expect(crashResult.attempt.status).toBe('interrupted');
            }

            const attempts = yield* sessions.listHandoffAttempts(id);
            expect(attempts).toHaveLength(2);
          }),
      ),
    TIMEOUT,
  );

  it.live(
    'gates Model change on non-draft Session behind reviewed Summary handoff when modelChangePreservesContext is false',
    () =>
      withCatalog(
        () => [
          makeEntry('agy', 'Antigravity', [], {
            modelChangePreservesContext: false,
            supportsIsolatedSummary: false,
          }),
        ],
        (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const id = yield* sessions.create(project, AgentId.make('agy'));
            yield* sessions.setTabs([id], id);
            yield* liveState(id, (s) => s.agentStatus === 'ready');
            yield* sendAndEnd(id, 'echo:Start work');

            const rejected = yield* sessions
              .setOption({ sessionId: id, option: 'model', value: 'large' })
              .pipe(Effect.flip);
            expect(rejected.reason).toBe('Unsupported');

            const prep = yield* sessions.prepareHandoff({
              sessionId: id,
              kind: 'modelChange',
              targetAgentId: AgentId.make('agy'),
              targetModel: 'large',
            });
            expect(prep.kind).toBe('modelChange');
            expect(prep.requestedModel).toBe('large');

            const res = yield* sessions.executeHandoff({
              sessionId: id,
              kind: 'modelChange',
              endpoint: prep.endpoint,
              targetAgentId: AgentId.make('agy'),
              targetModel: 'large',
              summary: prep.summary,
              selectedImageIds: [],
            });
            expect(res._tag).toBe('committed');

            const updated = yield* liveState(id, (s) => s.options.model?.value === 'large');
            expect(updated.options.model?.value).toBe('large');
          }),
      ),
    TIMEOUT,
  );

  it.live(
    'commits Fork as a new permanent Session with ForkLineage and reciprocal marker while leaving source intact, and failed Fork leaves no permanent Session',
    () =>
      withCatalog(
        () => [
          makeEntry('claude', 'Claude', [], { supportsIsolatedSummary: true }),
          makeEntry('codex', 'Codex', [], { supportsIsolatedSummary: false }),
          makeEntry('bad-tool', 'BadTool', ['--handoff-unexpected-tool']),
        ],
        (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const store = yield* SessionStore;
            const id = yield* sessions.create(project, AgentId.make('claude'));
            yield* sessions.setTabs([id], id);
            yield* liveState(id, (s) => s.agentStatus === 'ready');
            yield* sendAndEnd(id, 'echo:Source turn 1');

            const prep = yield* sessions.prepareHandoff({
              sessionId: id,
              kind: 'fork',
              targetAgentId: AgentId.make('codex'),
            });
            expect(prep.kind).toBe('fork');
            expect(prep.endpoint.turnId).toBeDefined();
            expect(prep.endpoint.turnNumber).toBe(1);

            // Failed Fork attempt leaves NO permanent destination Session and records HandoffAttempt on source
            const failedFork = yield* sessions.executeHandoff({
              sessionId: id,
              kind: 'fork',
              endpoint: prep.endpoint,
              targetAgentId: AgentId.make('bad-tool'),
              summary: prep.summary,
              selectedImageIds: [],
            });
            expect(failedFork._tag).toBe('failed');
            const afterFailList = yield* sessions.list(project);
            expect(afterFailList).toHaveLength(1);
            expect(yield* sessions.listHandoffAttempts(id)).toHaveLength(1);

            // Clean Fork commits a new permanent Session in the same Project
            const committed = yield* sessions.executeHandoff({
              sessionId: id,
              kind: 'fork',
              endpoint: prep.endpoint,
              targetAgentId: AgentId.make('codex'),
              summary: 'Reviewed fork summary',
              selectedImageIds: [],
            });
            expect(committed._tag).toBe('committed');
            if (committed._tag !== 'committed') return;
            expect(committed.forkSessionId).toBeDefined();
            const forkId = committed.forkSessionId!;

            // Both source and Fork appear in flat Project list
            const list = yield* sessions.list(project);
            expect(list.map((s) => s.id)).toContain(id);
            expect(list.map((s) => s.id)).toContain(forkId);

            // Source stays intact (same agentId, same activeContextId, reciprocal ForkTarget recorded)
            const sourceMeta = yield* store.get(id);
            expect(sourceMeta.agentId).toBe(AgentId.make('claude'));
            expect(sourceMeta.contexts).toHaveLength(1);
            expect(sourceMeta.forks).toHaveLength(1);
            expect(sourceMeta.forks?.[0]?.forkSessionId).toBe(forkId);
            expect(sourceMeta.forks?.[0]?.sourceTurnId).toBe(prep.endpoint.turnId);

            // Fork has same cwd, new Agent, ForkLineage, HandoffBoundary(fork), and setup Turn
            const forkMeta = yield* store.get(forkId);
            expect(forkMeta.projectId).toBe(project);
            expect(forkMeta.cwd).toBe(sourceMeta.cwd);
            expect(forkMeta.agentId).toBe(AgentId.make('codex'));
            expect(forkMeta.forkLineage).toEqual({
              sourceSessionId: id,
              sourceTurnId: prep.endpoint.turnId,
              sourceTurnNumber: 1,
              sourceTitle: sourceMeta.autoTitle ?? 'Untitled session',
            });

            const forkTranscript = yield* store.replay(forkId);
            expect(
              forkTranscript.some(
                (e) =>
                  e.item._tag === 'HandoffBoundary' &&
                  e.item.kind === 'fork' &&
                  e.item.summary === 'Reviewed fork summary',
              ),
            ).toBe(true);
            expect(forkTranscript.some((e) => e.item._tag === 'TurnStarted')).toBe(true);
          }),
      ),
    TIMEOUT,
  );

  it.live(
    'preserves surviving Forks with sourceDeleted on source deletion, and removes reciprocal ForkTarget on Fork deletion',
    () =>
      withCatalog(
        () => [
          makeEntry('claude', 'Claude', [], { supportsIsolatedSummary: false }),
          makeEntry('codex', 'Codex', [], { supportsIsolatedSummary: false }),
        ],
        (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const store = yield* SessionStore;
            const sourceId = yield* sessions.create(project, AgentId.make('claude'));
            yield* sessions.setTabs([sourceId], sourceId);
            yield* liveState(sourceId, (s) => s.agentStatus === 'ready');
            yield* sendAndEnd(sourceId, 'echo:Original work');

            const prep = yield* sessions.prepareHandoff({
              sessionId: sourceId,
              kind: 'fork',
              targetAgentId: AgentId.make('codex'),
            });

            // Create two Forks from the source
            const forkA = yield* sessions.executeHandoff({
              sessionId: sourceId,
              kind: 'fork',
              endpoint: prep.endpoint,
              targetAgentId: AgentId.make('codex'),
              summary: 'Fork A summary',
              selectedImageIds: [],
            });
            const forkB = yield* sessions.executeHandoff({
              sessionId: sourceId,
              kind: 'fork',
              endpoint: prep.endpoint,
              targetAgentId: AgentId.make('codex'),
              summary: 'Fork B summary',
              selectedImageIds: [],
            });
            expect(forkA._tag).toBe('committed');
            expect(forkB._tag).toBe('committed');
            if (forkA._tag !== 'committed' || forkB._tag !== 'committed') return;
            const forkAId = forkA.forkSessionId!;
            const forkBId = forkB.forkSessionId!;

            // Delete Fork A -> source loses Fork A's reciprocal marker, keeps Fork B
            yield* sessions.remove(forkAId);
            const sourceAfterDeleteA = yield* store.get(sourceId);
            expect(sourceAfterDeleteA.forks?.map((f) => f.forkSessionId)).toEqual([forkBId]);
            const sourceLiveAfterDeleteA = yield* liveState(
              sourceId,
              (s) => (s.forks?.length ?? 0) === 1,
            );
            expect(sourceLiveAfterDeleteA.forks?.map((f) => f.forkSessionId)).toEqual([forkBId]);

            // Open Fork B, then delete the source -> Fork B stays intact with sourceDeleted: true
            yield* sessions.setTabs([sourceId, forkBId], forkBId);
            yield* liveState(forkBId, (s) => s.forkLineage?.sourceSessionId === sourceId);

            yield* sessions.remove(sourceId);
            const forkBMeta = yield* store.get(forkBId);
            expect(forkBMeta.forkLineage?.sourceDeleted).toBe(true);
            const forkBLive = yield* liveState(
              forkBId,
              (s) => s.forkLineage?.sourceDeleted === true,
            );
            expect(forkBLive.forkLineage?.sourceDeleted).toBe(true);
            const forkBTranscript = yield* store.replay(forkBId);
            expect(
              forkBTranscript.some(
                (e) =>
                  e.item._tag === 'HandoffBoundary' &&
                  e.item.kind === 'fork' &&
                  e.item.summary === 'Fork B summary',
              ),
            ).toBe(true);
          }),
      ),
    TIMEOUT,
  );
});
