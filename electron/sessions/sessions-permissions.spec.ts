import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Option, Schedule, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  SessionId,
  TurnId,
  type LiveState,
  type SessionStreamItem,
} from '../../src/shared/sessions/sessions.rpc';
import { PaneId, PanelId, TabId } from '../../src/shared/tabs/tabs.rpc';
import {
  EMPTY_WORKSPACE,
  allTabPanels,
  allWorkspaceSessionIds,
  openSessionTab,
} from '../../src/shared/tabs/workspace-layout';
import { fakeEntry } from '../acp/acpFakes';
import { AgentLifetime } from '../acp/acpLifetime';
import { AcpClient } from '../acp/acpSessionManager';
import { codex as codexCatalog } from '../agents/codex/codex';
import { PathSources } from '../agents/merged-path';
import { Settings } from '../settings/settings';
import { Store } from '../store/store';
import { AGENT_DELETES_FILE } from './delete-queue';
import { activeContextOf, AgentContextId, SessionStore } from './session-store';
import { Sessions } from './sessions';
import {
  TIMEOUT,
  withSessionsCustom,
  withSessions,
  text,
  workspaceFor,
  untilTurnEnd,
  transcript,
  agentReply,
  events,
  seqs,
  agentAnswering,
  agentStatus,
  liveState,
  permissionRequest,
  permissionRequests,
} from './sessions-spec-fakes';

describe('Permission requests and the Permission mode', () => {
  it.live(
    'a failed Turn sets status error until the next Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('crash'));
          const failedItems = yield* untilTurnEnd(events(id));
          const afterSeq = seqs(failedItems).at(-1) ?? 0;
          expect((yield* liveState(id, () => true)).status).toBe('error');
          expect((yield* sessions.list(project)).find((session) => session.id === id)?.status).toBe(
            'error',
          );
          yield* sessions.prompt(id, text('echo:recovered'));
          yield* untilTurnEnd(events(id, afterSeq));
          expect((yield* liveState(id, () => true)).status).toBe('idle');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'a pending Permission request sets status blocked until answered',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          const change = yield* sessions.changes.pipe(
            Stream.filter((item) => item.sessionId === id && item.state.status === 'blocked'),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* sessions.prompt(id, text('permit'));
          const pending = yield* permissionRequest(id, 'pending');
          expect((yield* liveState(id, () => true)).status).toBe('blocked');
          expect(Option.getOrUndefined(yield* Fiber.join(change))).toMatchObject({
            projectId: project,
            sessionId: id,
          });
          expect(
            (yield* sessions.list(project)).find((session) => session.id === id),
          ).toMatchObject({
            status: 'blocked',
          });
          const cleared = yield* Effect.forkChild(
            liveState(id, (state) => state.status !== 'blocked'),
          );
          yield* sessions.answerPermission(id, pending.id, 'allow');
          expect((yield* liveState(id, () => true)).status).not.toBe('blocked');
          expect((yield* Fiber.join(cleared)).status).not.toBe('blocked');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'publishes the Session active cwd on LiveState',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          const meta = yield* store.get(id);
          const state = yield* liveState(id, () => true);
          expect(state.cwd).toBe(meta.cwd);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'projects activity and blockedTarget onto LiveState, SessionSummary, and SessionWorkerSummary',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });

          // Steer-hold emits Thought then Message chunk, publishing thinking -> writing activity.
          const sawThinking = yield* sessions.changes.pipe(
            Stream.filter(
              (item) => item.sessionId === id && item.state.activity?.kind === 'thinking',
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          const sawWriting = yield* sessions.changes.pipe(
            Stream.filter(
              (item) => item.sessionId === id && item.state.activity?.kind === 'writing',
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* sessions.prompt(id, text('steer-hold'));
          const thinking = Option.getOrThrow(yield* Fiber.join(sawThinking));
          expect(thinking.state.activity?.kind).toBe('thinking');
          expect(typeof thinking.state.activity?.startedAt).toBe('number');
          const writing = Option.getOrThrow(yield* Fiber.join(sawWriting));
          expect(writing.state.activity?.kind).toBe('writing');
          expect(typeof writing.state.activity?.startedAt).toBe('number');
          const listedWhileWriting = (yield* sessions.list(project)).find((s) => s.id === id);
          expect(listedWhileWriting?.activity?.kind).toBe('writing');
          yield* sessions.cancel(id);
          yield* untilTurnEnd(events(id));
          expect(
            (yield* liveState(id, (s) => s.runningTurn === undefined)).activity,
          ).toBeUndefined();

          // Permit emits execute step "ls -la" and pending PermissionRequest -> activity + blockedTarget.
          yield* sessions.prompt(id, text('permit'));
          const pending = yield* permissionRequest(id, 'pending');
          const blockedLive = yield* liveState(id, (s) => s.blockedTarget !== undefined);
          expect(blockedLive.blockedTarget).toBe('ls -la');
          expect(blockedLive.activity).toMatchObject({ kind: 'execute', target: 'ls -la' });
          const blockedSummary = (yield* sessions.list(project)).find((s) => s.id === id);
          expect(blockedSummary?.blockedTarget).toBe('ls -la');
          expect(blockedSummary?.activity).toMatchObject({ kind: 'execute', target: 'ls -la' });
          yield* sessions.answerPermission(id, pending.id, 'allow');
          yield* untilTurnEnd(events(id));
          const settledLive = yield* liveState(id, (s) => s.runningTurn === undefined);
          expect(settledLive.blockedTarget).toBeUndefined();
          expect(settledLive.activity).toBeUndefined();

          // Consecutive Steps with identical kind and target still publish the updated startedAt.
          const startedAts: number[] = [];
          const collectRepeat = yield* sessions.changes.pipe(
            Stream.filter(
              (item) =>
                item.sessionId === id &&
                item.state.activity?.kind === 'execute' &&
                item.state.activity.target === 'npm test',
            ),
            Stream.tap((item) =>
              Effect.sync(() => {
                const startedAt = item.state.activity?.startedAt;
                if (startedAt !== undefined && startedAts.at(-1) !== startedAt) {
                  startedAts.push(startedAt);
                }
              }),
            ),
            Stream.takeUntil(() => startedAts.length >= 2),
            Stream.runDrain,
            Effect.timeoutOption('5 seconds'),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* sessions.prompt(id, text('repeat-same-step'));
          yield* Fiber.join(collectRepeat);
          yield* untilTurnEnd(events(id));
          expect(startedAts.length).toBeGreaterThanOrEqual(2);
          expect(startedAts[1]).toBeGreaterThan(startedAts[0] ?? 0);

          // Owned worker waiting on permission projects blockedTarget onto SessionWorkerSummary.
          const parent = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: parent, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(parent, text('delegate:ask'));
          const waitingParent = yield* liveState(
            parent,
            (state) => state.workers?.some((worker) => worker.state === 'requiresAction') === true,
          );
          const worker = waitingParent.workers?.find((w) => w.state === 'requiresAction');
          if (worker === undefined) return yield* Effect.die('Waiting worker missing');
          const parentSummary = (yield* sessions.list(project)).find((s) => s.id === parent);
          const workerSummary = parentSummary?.workers?.find(
            (w) => w.sessionId === worker.sessionId,
          );
          expect(workerSummary?.state).toBe('requiresAction');
          expect(workerSummary?.blockedTarget).toBe('Run ls');
          yield* sessions.cancel(parent);
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
    'preserves pre-update edit diffs and relative files on the Step linked to a pending Permission request',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(id, text('permit-edit'));
          const pending = yield* permissionRequest(id, 'pending');
          const liveEvents = yield* events(id).pipe(
            Stream.takeUntil(
              (item) =>
                item._tag === 'Transcript' &&
                item.event.item._tag === 'PermissionRequest' &&
                item.event.item.id === pending.id,
            ),
            Stream.runCollect,
          );
          const steps = transcript([...liveEvents]).filter((item) => item._tag === 'Step');
          const linked = steps.find((step) => step.id === pending.stepId);
          expect(linked).toMatchObject({
            _tag: 'Step',
            id: pending.stepId,
            kind: 'edit',
            files: ['src/perm.ts'],
            diffs: [{ path: 'src/perm.ts', before: 'before', after: 'after' }],
          });
          yield* sessions.answerPermission(id, pending.id, 'allow');
          yield* untilTurnEnd(events(id));
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
            yield* sessions.setTabs(workspaceFor(project, [id], id));
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
            expect(allWorkspaceSessionIds((yield* sessions.restoreTabs).workspace).has(id)).toBe(
              false,
            );

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
      'delete cascades to every Worker descendant, keeps siblings and independent Forks',
      () =>
        withSessions((project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const store = yield* SessionStore;
            const parent = yield* sessions.create(project);
            const other = yield* sessions.create(project);
            yield* sessions.prompt(parent, text('echo:hi'));
            yield* untilTurnEnd(events(parent));
            const parentMeta = yield* store.get(parent);
            const keep = (id: string, parentId: SessionId | undefined, extra = {}) =>
              Effect.gen(function* () {
                const context = AgentContextId.make(`${id}-context`);
                const sessionId = SessionId.make(id);
                yield* store.createDraft({
                  ...parentMeta,
                  id: sessionId,
                  ...(parentId === undefined
                    ? {}
                    : { parentSessionId: parentId, workerKind: 'owned' as const }),
                  activeContextId: context,
                  contexts: [
                    {
                      id: context,
                      agentId: parentMeta.agentId,
                      acpSessionIds: [],
                      createdAt: parentMeta.createdAt,
                    },
                  ],
                  ...extra,
                });
                yield* sessions.prompt(sessionId, text('echo:hi'));
                yield* untilTurnEnd(events(sessionId));
                return sessionId;
              });
            const child = yield* keep('child', parent);
            const grandchild = yield* keep('grandchild', child);
            const sibling = yield* keep('sibling', other);
            const fork = yield* keep('fork', undefined, {
              forkLineage: { sourceSessionId: child, sourceTurnNumber: 1, sourceTitle: 'child' },
            });
            yield* store.updateMeta(child, (meta) => ({
              ...meta,
              forks: [{ forkSessionId: fork, sourceTurnId: TurnId.make('t1'), forkTitle: 'fork' }],
            }));
            yield* sessions.setTabs(
              workspaceFor(project, [parent, child, grandchild, sibling, fork], fork),
            );

            const summary = (yield* sessions.list(project)).find((item) => item.id === parent);
            expect(summary?.workerCount).toBe(2);

            yield* sessions.remove(parent);

            const left = (yield* store.listAll).map((meta) => meta.id).sort();
            expect(left).toEqual([sibling, fork].sort());
            const tabs = [
              ...allWorkspaceSessionIds((yield* sessions.restoreTabs).workspace),
            ].sort();
            expect(tabs).toEqual([sibling, fork].sort());
            const forkMeta = (yield* store.listAll).find((meta) => meta.id === fork);
            expect(forkMeta?.parentSessionId).toBeUndefined();
            expect(forkMeta?.forkLineage?.sourceDeleted).toBe(true);
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
            yield* sessions.setTabs(workspaceFor(project, [s1], s1));
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
          expect(listedBefore.find((s) => s.id === id)?.status).toBe('working');

          yield* sessions.cancelProject(project);
          const ended = transcript(yield* untilTurnEnd(events(id)));
          expect(ended.at(-1)).toMatchObject({
            _tag: 'TurnEnded',
            outcome: { _tag: 'cancelled' },
          });
          const listedAfter = yield* sessions.list(project);
          expect(listedAfter.find((s) => s.id === id)?.status).toBe('idle');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'restoreTabs preserves status on kept Tabs and marks unprompted in-memory drafts',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const kept = yield* sessions.create(project);
          yield* sessions.prompt(kept, text('crash'));
          yield* untilTurnEnd(events(kept));

          const draft = yield* sessions.create(project);
          yield* sessions.setTabs(workspaceFor(project, [kept, draft], draft));

          const restored = yield* sessions.restoreTabs;
          expect(restored.workspace.activeProjectId).toBe(project);
          expect(restored.workspace.projects[0]?.activeTabId).toBe(TabId.make(`tab-${draft}`));
          expect(
            restored.workspace.projects[0]?.tabs.flatMap((t) => allTabPanels(t).map((p) => p.spec)),
          ).toEqual([
            { _tag: 'Session', sessionId: kept },
            { _tag: 'Session', sessionId: draft, draft: true },
          ]);
          expect(restored.sessions).toMatchObject([
            {
              id: kept,
              projectId: project,
              status: 'error',
            },
            {
              id: draft,
              projectId: project,
              status: 'idle',
            },
          ]);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'getComposer / setComposer keeps unsent text and images during Worker navigation and drops them when the Tab closes',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const workspace = workspaceFor(project, [id], id);
          yield* sessions.setTabs(workspace);

          expect(yield* sessions.getComposer(id)).toEqual({ text: '', images: [] });

          const draft = {
            text: 'unsent note',
            images: [{ name: 'pic.png', mimeType: 'image/png', data: 'AQID' }],
          };
          yield* sessions.setComposer(id, draft);
          expect(yield* sessions.getComposer(id)).toEqual(draft);

          const worker = yield* sessions.create(project);
          const switched = openSessionTab(workspace, {
            projectId: project,
            sessionId: worker,
            replacePanelId: PanelId.make(`panel-${id}`),
            workerAncestors: [id],
            createIds: () => ({
              tabId: TabId.make(`tab-${worker}`),
              paneId: PaneId.make(`pane-${worker}`),
              panelId: PanelId.make(`panel-${worker}`),
            }),
          });
          yield* sessions.setTabs(switched.workspace);
          expect(yield* sessions.getComposer(id)).toEqual(draft);

          // Closing the Tab drops the drafts of conversations retained in the Pane.
          yield* sessions.setTabs(EMPTY_WORKSPACE);
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
          yield* sessions.setTabs(workspaceFor(project, [id], id));
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
          yield* sessions.setTabs(workspaceFor(project, [a, b], a));
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
          yield* sessions.setTabs(workspaceFor(project, [active, idle], active));
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
          yield* sessions.setTabs(workspaceFor(project, [a, b], a));
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
              yield* sessions.setTabs(workspaceFor(project, [a], a));
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
        crossDeviceTools: true,
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
      'restarts an idle unverified Agent on retryAgent so an in-place update clears unverified',
      () => {
        const fakeScript = fileURLToPath(new URL('../acp/fakeAgent.mjs', import.meta.url));
        const writeVersionedShim = (binDir: string, version: string) =>
          Effect.promise(() =>
            process.platform === 'win32'
              ? writeFile(
                  path.join(binDir, 'versioned-fake.cmd'),
                  `@"${process.execPath}" "${fakeScript}" --version=${version} %*\r\n`,
                )
              : writeFile(
                  path.join(binDir, 'versioned-fake'),
                  `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" --version=${version} "$@"\n`,
                  { mode: 0o755 },
                ),
          );
        const entry = fakeEntry([], {
          id: AgentId.make('claude'),
          name: 'Claude',
          binary: 'versioned-fake',
          qualification: { kind: 'exact', version: '1.0.0' },
        });
        return withSessionsCustom(
          { catalog: [entry], fallbackAgentId: entry.id },
          (project, install) =>
            Effect.gen(function* () {
              yield* writeVersionedShim(install.bin, '0.9.0');
              const sessions = yield* Sessions;
              const id = yield* sessions.create(project);
              const before = yield* liveState(id, (next) => next.agentStatus === 'ready');
              expect(before.installedVersion).toBe('0.9.0');
              expect(before.versionQualification).toBe('unverified');

              yield* writeVersionedShim(install.bin, '1.0.0');
              yield* sessions.retryAgent(id);

              const after = yield* liveState(
                id,
                (next) => next.agentStatus === 'ready' && next.versionQualification === 'qualified',
              );
              expect(after.installedVersion).toBe('1.0.0');
            }),
        );
      },
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
              expect(unverified.upgradeCommand).toBe('@agentclientprotocol/codex-acp@2.6.0');
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
              const afterAskSeq = seqs(
                yield* untilTurnEnd(events(id, seqs(askModeReplay).at(-1))),
              ).at(-1);

              // usage_update populates ContextUsage while cumulative Usage does not.
              yield* sessions.prompt(id, text('cumulative-only'));
              const afterCumulativeSeq = seqs(yield* untilTurnEnd(events(id, afterAskSeq))).at(-1);
              const beforeUsage = yield* liveState(
                id,
                (next) => next.contextUsage?._tag === 'unavailable',
              );
              expect(beforeUsage.contextUsage).toEqual({ _tag: 'unavailable' });

              yield* sessions.prompt(id, text('usage:24000/200000'));
              yield* untilTurnEnd(events(id, afterCumulativeSeq));
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
