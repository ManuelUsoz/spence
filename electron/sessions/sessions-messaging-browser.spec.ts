import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Option, Schedule, Stream } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { BrowserService } from '../browser/browser-service';
import { Projects } from '../projects/projects';
import { Settings } from '../settings/settings';
import { SessionStore } from './session-store';
import { Sessions } from './sessions';
import {
  MAX_ACTIVE_WORKERS_PER_PARENT,
  MAX_DELEGATION_DEPTH,
  MESSAGE_RATE_LIMIT,
} from './session-messaging';
import {
  TIMEOUT,
  withSessionsCustom,
  withSessions,
  text,
  untilTurnEnd,
  transcript,
  agentReply,
  events,
  liveState,
  withTwoProjects,
  crossProjectPair,
  permissionRequest,
  type McpServer,
  turnReply,
  holdingServer,
  callTool,
  messagingTree,
  sendAnswering,
} from './sessions-spec-fakes';

describe('Session messaging within a delegation tree', () => {
  it.live(
    'lists the reachable Sessions of the caller tree with their relation',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const tree = yield* messagingTree(project);
          const listed = yield* callTool(tree.oneServer, 'list_sessions', {});
          const byId = new Map<string, { relation: string; state: string; title: string }>(
            listed.data.sessions.map((entry: { id: string }) => [entry.id, entry] as const),
          );
          expect(byId.get(tree.parent)?.relation).toBe('parent');
          expect(byId.get(tree.two)).toMatchObject({ relation: 'sibling', state: 'idle' });
          expect(byId.get(tree.two)?.title).toBe('echo:two');
          expect(byId.has(tree.one)).toBe(false);
          expect(byId.has(tree.stranger)).toBe(false);
          const fromParent = yield* callTool(tree.parentServer, 'list_sessions', {});
          expect(
            fromParent.data.sessions.map((entry: { id: string; relation: string }) => [
              entry.id,
              entry.relation,
            ]),
          ).toEqual(
            expect.arrayContaining([
              [tree.one, 'child'],
              [tree.two, 'child'],
            ]),
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'starts a Turn on an idle Worker and attributes the message to the sender',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const tree = yield* messagingTree(project);
          const after = (yield* store.replay(tree.two)).at(-1)?.seq;
          const sent = yield* callTool(tree.oneServer, 'send_message', {
            to: tree.two,
            text: 'hello from one',
          });
          expect(sent.isError).toBe(false);
          expect(sent.data.delivery).toBe('started');
          const items = transcript(yield* untilTurnEnd(events(tree.two, after)));
          const received = items.find((item) => item._tag === 'Message' && item.role === 'user');
          expect(received).toMatchObject({
            parts: [{ _tag: 'text', text: 'hello from one' }],
            from: { sessionId: tree.one, title: 'echo:one' },
          });
          expect(agentReply(items)).toBe('hello from one');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'queues a message for a busy target through its ordinary Queue',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const tree = yield* messagingTree(project);
          yield* sessions.prompt(tree.two, text('hold'));
          const sent = yield* callTool(tree.oneServer, 'send_message', {
            to: tree.two,
            text: 'when you can',
          });
          expect(sent.data.delivery).toBe('queued');
          const state = yield* liveState(tree.two, (live) => live.queue.length === 1);
          expect(state.queue[0]).toMatchObject({
            parts: [{ _tag: 'text', text: 'when you can' }],
            from: { sessionId: tree.one },
          });
          yield* sessions.cancel(tree.two);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'lets a Parent message a Worker',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const tree = yield* messagingTree(project);
          const after = (yield* store.replay(tree.two)).at(-1)?.seq;
          const sent = yield* callTool(tree.parentServer, 'send_message', {
            to: tree.two,
            text: 'status please',
          });
          expect(sent.data.delivery).toBe('started');
          const items = transcript(yield* untilTurnEnd(events(tree.two, after)));
          expect(
            items.find((item) => item._tag === 'Message' && item.role === 'user'),
          ).toMatchObject({ from: { sessionId: tree.parent } });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'reaches a kept Session outside the caller tree and rejects drafts, unknown ids and self',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const tree = yield* messagingTree(project);
          for (const to of [tree.stranger, 'no-such-session', tree.one]) {
            const sent = yield* callTool(tree.oneServer, 'send_message', { to, text: 'hi' });
            expect(sent.isError).toBe(true);
            expect(sent.data.error.reason).toBe('NotReachable');
          }
          expect(yield* store.replay(tree.stranger)).toHaveLength(0);
          yield* turnReply(tree.stranger, 'echo:ready');
          const sent = yield* callTool(tree.oneServer, 'send_message', {
            to: tree.stranger,
            text: 'outside the tree',
          });
          expect(sent.data).toMatchObject({ accepted: true, to: tree.stranger });
          const result = yield* callTool(tree.oneServer, 'await_result', {
            handle: sent.data.handle,
          });
          expect(result.data).toMatchObject({ status: 'done', text: 'outside the tree' });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'rejects a caller whose Turn has ended',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const tree = yield* messagingTree(project);
          yield* sessions.cancel(tree.one);
          const status = yield* callTool(tree.oneServer, 'send_message', {
            to: tree.two,
            text: 'late',
          }).pipe(
            Effect.map((sent) => sent.status),
            Effect.repeat({
              schedule: Schedule.spaced('50 millis'),
              until: (code) => code !== 200,
            }),
          );
          expect(status).not.toBe(200);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'delivers a message once per retry key and rejects a conflicting reuse',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const tree = yield* messagingTree(project);
          yield* sessions.prompt(tree.two, text('hold'));
          const send = (body: string) =>
            callTool(tree.oneServer, 'send_message', { to: tree.two, text: body, requestId: 'k' });
          const first = yield* send('once');
          const again = yield* send('once');
          expect(again).toEqual(first);
          const conflict = yield* send('different');
          expect(conflict.isError).toBe(true);
          expect(conflict.data.error.reason).toBe('RequestIdConflict');
          const state = yield* liveState(tree.two, (live) => live.queue.length > 0);
          expect(state.queue).toHaveLength(1);
          yield* sessions.cancel(tree.two);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'stops ping-pong at the hop limit with a structured error to the sender',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const tree = yield* messagingTree(project);
          const sessions = yield* Sessions;
          yield* sessions.cancel(tree.one);
          yield* liveState(tree.one, (state) => state.runningTurn === undefined);
          yield* turnReply(tree.one, `pingpong:${tree.two}:${tree.one}`);
          // The chain runs on its own; wait for a Turn whose tool result is the refusal.
          const refused = yield* Effect.gen(function* () {
            for (const id of [tree.one, tree.two]) {
              const replayed = yield* store.replay(id);
              if (agentReply(replayed.map((event) => event.item)).includes('HopLimit')) return true;
            }
            return false;
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced('100 millis'),
              until: (done) => done,
            }),
          );
          expect(refused).toBe(true);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'rate limits a sender that floods messages',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const tree = yield* messagingTree(project);
          yield* sessions.prompt(tree.two, text('hold'));
          let limited: { readonly isError: boolean; readonly data: any } | undefined;
          for (let i = 0; i < 60 && limited === undefined; i++) {
            const sent = yield* callTool(tree.oneServer, 'send_message', {
              to: tree.two,
              text: `spam ${i}`,
            });
            if (sent.isError) limited = sent;
          }
          expect(limited?.data.error.reason).toBe('RateLimited');
          yield* sessions.cancel(tree.two);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'surfaces a needs-user message as Attention on the Parent without widening permissions',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const tree = yield* messagingTree(project);
          const before = yield* liveState(tree.parent, () => true);
          const sent = yield* callTool(tree.oneServer, 'send_message', {
            to: tree.parent,
            text: 'which database should I use?',
            needsUser: true,
          });
          expect(sent.isError).toBe(false);
          const state = yield* liveState(tree.parent, (live) => live.attention === 'needsAnswer');
          expect(state.options.permissionMode).toBe(before.options.permissionMode);
          expect(state.queue[0]).toMatchObject({ from: { sessionId: tree.one, needsUser: true } });
          // Once the Parent reads it, the question stays pending until the user answers in that Session.
          yield* sessions.cancel(tree.parent);
          yield* liveState(
            tree.parent,
            (live) => live.queue.length === 0 && live.runningTurn !== undefined,
          );
          const settled = yield* liveState(
            tree.parent,
            (live) => live.runningTurn === undefined && live.queue.length === 0,
          );
          expect(settled.attention).toBe('needsAnswer');
          yield* sessions.prompt(tree.parent, text('echo:use sqlite'));
          const answered = yield* liveState(tree.parent, (live) => live.attention === undefined);
          expect(answered.attention).toBeUndefined();
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'does not let a needs-user message target anything but the immediate Parent',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const tree = yield* messagingTree(project);
          const sent = yield* callTool(tree.oneServer, 'send_message', {
            to: tree.two,
            text: 'ask the user',
            needsUser: true,
          });
          expect(sent.isError).toBe(true);
          expect(sent.data.error.reason).toBe('InvalidTarget');
        }),
      ),
    TIMEOUT,
  );
});

describe('Session messaging across Projects', () => {
  it.live(
    'records an answered Permission before completing its Step',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const pair = yield* crossProjectPair(a, b);
          const { request } = yield* sendAnswering(
            pair,
            { to: pair.target, text: 'ordered approval' },
            'allowOnce',
          );
          const items = (yield* store.replay(pair.sender)).map((event) => event.item);
          const answered = items.findIndex(
            (item) =>
              item._tag === 'PermissionRequest' &&
              item.id === request.id &&
              item.state._tag === 'answered',
          );
          const finished = items.findIndex(
            (item) => item._tag === 'Step' && item.id === request.stepId && item.status === 'done',
          );
          expect(answered).toBeGreaterThanOrEqual(0);
          expect(finished).toBeGreaterThan(answered);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'lets an Ask recipient reply to the approved exchange without asking again',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const pair = yield* crossProjectPair(a, b);
          yield* sessions.setOption({
            sessionId: pair.target,
            option: 'permissionMode',
            value: 'ask',
          });
          yield* sendAnswering(
            pair,
            {
              to: pair.target,
              text: `mcp:send_message:${JSON.stringify({ to: pair.sender, text: 'Progress from B' })}`,
            },
            'allowOnce',
          );
          const state = yield* liveState(pair.sender, (live) => live.queue.length > 0);
          expect(state.queue).toContainEqual(
            expect.objectContaining({
              from: expect.objectContaining({ sessionId: pair.target }),
              parts: [{ _tag: 'text', text: 'Progress from B' }],
            }),
          );
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'delivers an accepted Message after restart without duplicating its Turn or sender receipt',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-exchange-reopen-'))),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );
          const setup = { storeRoot: root };
          const accepted = yield* withSessionsCustom(setup, (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const sender = yield* sessions.create(project);
              const server = yield* holdingServer(sender);
              const target = yield* sessions.create(project);
              yield* holdingServer(target);
              const args = { to: target, text: 'echo:after restart', requestId: 'durable-send' };
              const sent = yield* callTool(server, 'send_message', args);
              expect(sent.data).toMatchObject({ delivery: 'queued' });
              return { sender, target, args, response: sent.data };
            }),
          );
          yield* withSessionsCustom(setup, () =>
            Effect.gen(function* () {
              const store = yield* SessionStore;
              const server = yield* holdingServer(accepted.sender);
              const retried = yield* callTool(server, 'send_message', accepted.args);
              expect(retried.data).toEqual(accepted.response);
              const result = yield* callTool(server, 'await_result', {
                handle: accepted.response.handle,
              });
              expect(result.data).toMatchObject({ status: 'done', text: 'after restart' });
              expect(
                (yield* store.replay(accepted.target)).filter(
                  ({ item }) =>
                    item._tag === 'Message' && item.from?.exchangeId === accepted.response.handle,
                ),
              ).toHaveLength(1);
              expect(
                (yield* store.replay(accepted.sender)).filter(
                  ({ item }) =>
                    item._tag === 'Notice' && item.sent?.id === accepted.response.handle,
                ),
              ).toHaveLength(1);
            }),
          );
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'starts an independent Session under Auto, publishes a background Tab and returns the exact Turn result',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const pair = yield* crossProjectPair(a, b, 'auto');
          const args = { project: b, text: 'echo:integration result', requestId: 'local-start' };
          const started = yield* callTool(pair.senderServer, 'start_session', args);
          expect(started.data).toMatchObject({ accepted: true, delivery: 'started' });
          const retried = yield* callTool(pair.senderServer, 'start_session', args);
          expect(retried.data).toEqual(started.data);
          const id = SessionId.make(started.data.session);
          const created = yield* sessions.backgroundTabs.pipe(Stream.runHead);
          expect(created).toMatchObject({
            _tag: 'Some',
            value: { sessionId: id, projectId: b, background: true },
          });
          const result = yield* callTool(pair.senderServer, 'await_result', {
            handle: started.data.handle,
          });
          expect(result.data).toEqual({ status: 'done', text: 'integration result' });
          expect(yield* store.get(id)).toMatchObject({ projectId: b });
          expect((yield* store.get(id)).parentSessionId).toBeUndefined();
          expect((yield* store.get(id)).memoryLost).toBeUndefined();
          expect((yield* store.replay(id)).map((entry) => entry.item)).toContainEqual(
            expect.objectContaining({
              _tag: 'Message',
              role: 'user',
              from: expect.objectContaining({ sessionId: pair.sender, projectId: a }),
            }),
          );
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'in Ask, Allow once delivers an attributed message and the next unrelated contact asks again',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const pair = yield* crossProjectPair(a, b);
          const after = (yield* store.replay(pair.target)).at(-1)?.seq;
          const { request, sent } = yield* sendAnswering(
            pair,
            { to: pair.target, text: 'hello across' },
            'allowOnce',
          );
          expect(request.options.map((option) => option.kind)).toEqual([
            'allowOnce',
            'allowAlways',
            'rejectOnce',
          ]);
          expect(sent.isError).toBe(false);
          expect(sent.data.delivery).toBe('started');
          const items = transcript(yield* untilTurnEnd(events(pair.target, after)));
          expect(
            items.find((item) => item._tag === 'Message' && item.role === 'user'),
          ).toMatchObject({
            parts: [{ _tag: 'text', text: 'hello across' }],
            from: { sessionId: pair.sender },
          });
          // Recorded in the sender's Transcript too.
          const senderItems = (yield* store.replay(pair.sender)).map((event) => event.item);
          expect(senderItems.some((item) => item._tag === 'Notice')).toBe(true);
          // Allow once stores nothing: the next contact asks again.
          const settings = yield* Settings.use((s) => s.get);
          expect(settings.crossProjectAccess).toEqual([]);
          const second = yield* sendAnswering(
            pair,
            { to: pair.target, text: 'again' },
            'rejectOnce',
          );
          expect(second.sent.isError).toBe(true);
          expect(second.sent.data.error.reason).toBe('PermissionDenied');
        }),
      ),
    TIMEOUT,
  );
});

describe('Session messaging across Projects: the allow-list and revocation', () => {
  it.live(
    'Always allow is stored per Project pair, applies without asking, and lists the other Project',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const pair = yield* crossProjectPair(a, b);
          const first = yield* sendAnswering(pair, { to: pair.target, text: 'one' }, 'allowAlways');
          expect(first.sent.isError).toBe(false);
          const settings = yield* Settings.use((s) => s.get);
          expect(settings.crossProjectAccess).toMatchObject([{ from: a, to: b }]);
          // No request this time: the call returns on its own.
          const second = yield* callTool(pair.senderServer, 'send_message', {
            to: pair.target,
            text: 'two',
          });
          expect(second.isError).toBe(false);
          expect(['started', 'queued']).toContain(second.data.delivery);
          const listed = yield* callTool(pair.senderServer, 'list_sessions', { projectId: b });
          expect(listed.data.sessions.map((entry: { id: string }) => entry.id)).toContain(
            pair.target,
          );
          const overview = yield* callTool(pair.senderServer, 'list_sessions', {});
          expect(overview.data.projects).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: b })]),
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'lists Session targets before asking to contact them',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const pair = yield* crossProjectPair(a, b);
          const overview = yield* callTool(pair.senderServer, 'list_sessions', {});
          expect(overview.data.projects).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: b })]),
          );
          expect(JSON.stringify(overview.data)).not.toContain(pair.target);
          const listed = yield* callTool(pair.senderServer, 'list_sessions', { projectId: b });
          expect(listed.isError).toBe(false);
          expect(JSON.stringify(listed.data)).toContain(pair.target);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'the receiver keeps its own Permission mode and records the attributed message',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const pair = yield* crossProjectPair(a, b);
          const before = yield* liveState(pair.target, () => true);
          const sequence = (yield* store.replay(pair.target)).at(-1)?.seq;
          yield* sendAnswering(pair, { to: pair.target, text: 'hello' }, 'allowOnce');
          yield* untilTurnEnd(events(pair.target, sequence)).pipe(Effect.asVoid);
          const after = yield* liveState(pair.target, () => true);
          expect(after.options.permissionMode).toEqual(before.options.permissionMode);
          const items = (yield* store.replay(pair.target)).map((event) => event.item);
          const received = items.find((item) => item._tag === 'Message' && item.from !== undefined);
          expect(received).toMatchObject({
            from: { sessionId: pair.sender, projectName: expect.any(String) },
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a cancelled Turn denies the pending request; nothing reaches the target',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const pair = yield* crossProjectPair(a, b);
          const before = (yield* store.replay(pair.target)).length;
          const call = yield* Effect.forkChild(
            callTool(pair.senderServer, 'send_message', { to: pair.target, text: 'never' }),
          );
          yield* permissionRequest(pair.sender, 'pending');
          yield* sessions.cancel(pair.sender);
          const sent = yield* Fiber.join(call);
          expect(sent.isError === true || sent.status !== 200).toBe(true);
          expect((yield* store.replay(pair.target)).length).toBe(before);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'removing a Project revokes its stored allowances',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const pair = yield* crossProjectPair(a, b);
          yield* sendAnswering(pair, { to: pair.target, text: 'one' }, 'allowAlways');
          expect((yield* Settings.use((s) => s.get)).crossProjectAccess).toHaveLength(1);
          yield* Projects.use((projects) => projects.remove(b));
          yield* sessions.cancelProject(b);
          expect((yield* Settings.use((s) => s.get)).crossProjectAccess).toEqual([]);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'an owned Worker in another Project is reachable with permission',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const sessions = yield* Sessions;
          const pair = yield* crossProjectPair(a, b);
          yield* sendAnswering(pair, { to: pair.target, text: 'one' }, 'allowAlways');
          const parentB = yield* sessions.create(b);
          const targetServer = yield* holdingServer(parentB);
          const before = new Set((yield* store.listAll).map((meta) => meta.id));
          yield* callTool(targetServer, 'delegate', { task: 'echo:w' });
          const worker = (yield* store.listAll).find((meta) => !before.has(meta.id));
          expect(worker?.parentSessionId).toBe(parentB);
          const sent = yield* callTool(pair.senderServer, 'send_message', {
            to: worker?.id ?? '',
            text: 'x',
          });
          expect(sent.data).toMatchObject({ accepted: true, to: worker?.id });
          yield* sessions.cancel(parentB);
        }),
      ),
    TIMEOUT,
  );
});

describe('Delegation outcomes, limits and capability ceiling', () => {
  /** A delegated call that waits for its Worker: returns once the Worker's Turn has ended. */
  const delegateAndStop = (outcome: 'cancel' | 'fail') =>
    withSessions((project) =>
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const store = yield* SessionStore;
        const parent = yield* sessions.create(project);
        const server = yield* holdingServer(parent);
        const before = new Set((yield* store.listAll).map((meta) => meta.id));
        const call = yield* Effect.forkChild(
          callTool(server, 'delegate', { task: outcome === 'cancel' ? 'hold' : 'error' }),
        );
        if (outcome === 'cancel') {
          const child = yield* Effect.gen(function* () {
            for (;;) {
              const created = (yield* store.listAll).find((meta) => !before.has(meta.id));
              if (created !== undefined) return created.id;
              yield* Effect.sleep('50 millis');
            }
          });
          yield* liveState(child, (state) => state.runningTurn !== undefined);
          yield* sessions.cancel(child);
        }
        const result = yield* Fiber.join(call);
        yield* sessions.cancel(parent);
        return result;
      }),
    );

  it.live(
    'returns a structured cancellation when the Worker is stopped',
    () =>
      delegateAndStop('cancel').pipe(
        Effect.map((result) => {
          expect(result.status).toBe(200);
          expect(result.isError).toBe(true);
          expect(result.data.error.reason).toBe('WorkerCancelled');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'returns a structured failure when the Worker fails',
    () =>
      delegateAndStop('fail').pipe(
        Effect.map((result) => {
          expect(result.status).toBe(200);
          expect(result.isError).toBe(true);
          expect(result.data.error.reason).toBe('WorkerFailed');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'an inactive credential gets a structured error, not a defect',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('report-mcp-servers'));
          const report = agentReply(transcript(yield* untilTurnEnd(events(parent))));
          const server: McpServer | undefined = JSON.parse(report)[0];
          if (server === undefined) return yield* Effect.die('Delegation server missing');
          const result = yield* callTool(server, 'delegate', { task: 'echo:stale' });
          expect(result.status).toBe(200);
          expect(result.isError).toBe(true);
          expect(result.data.error.reason).toBe('NotActive');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'refuses to delegate below the depth cap',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const root = yield* sessions.create(project);
          let server = yield* holdingServer(root);
          for (let depth = 1; depth <= MAX_DELEGATION_DEPTH; depth++) {
            const before = new Set((yield* store.listAll).map((meta) => meta.id));
            const made = yield* callTool(server, 'delegate', { task: `echo:d${depth}` });
            expect(made.isError).toBe(false);
            const created = (yield* store.listAll).find((meta) => !before.has(meta.id));
            if (created === undefined) return yield* Effect.die('Worker missing');
            server = yield* holdingServer(created.id);
          }
          const refused = yield* callTool(server, 'delegate', { task: 'echo:too-deep' });
          expect(refused.isError).toBe(true);
          expect(refused.data.error.reason).toBe('DepthLimit');
          yield* sessions.cancel(root);
        }),
      ),
    90_000,
  );

  it.live(
    'refuses more concurrent Workers than the per-parent cap',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          const server = yield* holdingServer(parent);
          const running = yield* Effect.forEach(
            Array.from({ length: MAX_ACTIVE_WORKERS_PER_PARENT }, (_, i) => i),
            (i) => Effect.forkChild(callTool(server, 'delegate', { task: 'hold', index: i })),
          );
          const children = () =>
            store.listAll.pipe(
              Effect.map((metas) => metas.filter((meta) => meta.parentSessionId === parent)),
            );
          while ((yield* children()).length < MAX_ACTIVE_WORKERS_PER_PARENT) {
            yield* Effect.sleep('50 millis');
          }
          for (const child of yield* children()) {
            yield* liveState(child.id, (state) => state.runningTurn !== undefined);
          }
          const refused = yield* callTool(server, 'delegate', { task: 'echo:extra' });
          expect(refused.isError).toBe(true);
          expect(refused.data.error.reason).toBe('WorkerLimit');
          yield* sessions.cancel(parent);
          yield* Effect.forEach(running, Fiber.join);
        }),
      ),
    90_000,
  );

  it.live(
    'a Worker never has a broader Permission mode than its Parent',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const tree = yield* messagingTree(project);
          // Lowering the Parent lowers its Workers.
          yield* sessions.setOption({
            sessionId: tree.parent,
            option: 'permissionMode',
            value: 'ask',
          });
          const lowered = yield* liveState(
            tree.one,
            (state) => state.options.permissionMode === 'ask',
          );
          expect(lowered.options.permissionMode).toBe('ask');
          // A Worker cannot raise itself above the Parent.
          yield* sessions.setOption({
            sessionId: tree.one,
            option: 'permissionMode',
            value: 'auto',
          });
          const after = yield* liveState(tree.one, () => true);
          expect(after.options.permissionMode).toBe('ask');
          yield* sessions.cancel(tree.parent);
        }),
      ),
    90_000,
  );

  it.live(
    'the same retry key does not delegate twice after the credential was reissued',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          const first = yield* holdingServer(parent);
          const args = { task: 'echo:once', requestId: 'again' };
          const a = yield* callTool(first, 'delegate', args);
          yield* sessions.cancel(parent);
          yield* liveState(parent, (state) => state.runningTurn === undefined);
          // Stopping the Agent and resuming the same context issues a new credential.
          yield* sessions.stopAgent(parent, true);
          const second = yield* holdingServer(parent);
          expect(second.headers).not.toEqual(first.headers);
          const b = yield* callTool(second, 'delegate', args);
          expect(b).toEqual(a);
          expect(
            (yield* store.listAll).filter((meta) => meta.parentSessionId === parent),
          ).toHaveLength(1);
          yield* sessions.cancel(parent);
        }),
      ),
    TIMEOUT,
  );
});

describe('Cross-Project messaging quota', () => {
  it.live(
    'a denied send does not consume the quota',
    () =>
      withTwoProjects((a, b) =>
        Effect.gen(function* () {
          const pair = yield* crossProjectPair(a, b);
          for (let i = 0; i < MESSAGE_RATE_LIMIT; i++) {
            const denied = yield* sendAnswering(
              pair,
              { to: pair.target, text: `no ${i}` },
              'rejectOnce',
            );
            expect(denied.sent.data.error.reason).toBe('PermissionDenied');
          }
          const { sent } = yield* sendAnswering(
            pair,
            { to: pair.target, text: 'yes' },
            'allowOnce',
          );
          expect(sent.isError).toBe(false);
        }),
      ),
    120_000,
  );
});

describe('Messaging quota per delegation tree', () => {
  it.live(
    'Workers of one tree share one quota',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const tree = yield* messagingTree(project);
          const twoServer = yield* holdingServer(tree.two);
          for (let i = 0; i < MESSAGE_RATE_LIMIT; i++) {
            yield* callTool(tree.oneServer, 'send_message', { to: tree.parent, text: `m${i}` });
          }
          const other = yield* callTool(twoServer, 'send_message', {
            to: tree.parent,
            text: 'late',
          });
          expect(other.isError).toBe(true);
          expect(other.data.error.reason).toBe('RateLimited');
          yield* sessions.cancel(tree.parent);
        }),
      ),
    90_000,
  );
});

describe('Browser MCP server registration & isolation', () => {
  it.live(
    'registers spence-browser at mcpServers[1] for Local Sessions, enforces Turn guard, isolates Pages, and revokes on clearContext',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const s1 = yield* sessions.create(project);
          const s2 = yield* sessions.create(project);

          yield* sessions.prompt(s1, text('report-mcp-servers'));
          const report1 = agentReply(transcript(yield* untilTurnEnd(events(s1))));
          const servers1: ReadonlyArray<{
            name?: string;
            url: string;
            headers: ReadonlyArray<{ name: string; value: string }>;
          }> = JSON.parse(report1);

          expect(servers1).toHaveLength(2);
          expect(servers1[0]?.name).toBe('spence');
          expect(servers1[1]?.name).toBe('spence-browser');

          yield* sessions.prompt(s2, text('report-mcp-servers'));
          const report2 = agentReply(transcript(yield* untilTurnEnd(events(s2))));
          const servers2: ReadonlyArray<{
            name?: string;
            url: string;
            headers: ReadonlyArray<{ name: string; value: string }>;
          }> = JSON.parse(report2);
          const browserServer1 = servers1[1];
          const browserServer2 = servers2[1];
          if (browserServer1 === undefined || browserServer2 === undefined) {
            return yield* Effect.die('Browser MCP server missing');
          }

          // After Turn ends, calling spence-browser returns NotActive.
          const staleCall = yield* callTool(browserServer1, 'pages', { action: 'list' });
          expect(staleCall.isError).toBe(true);
          expect(staleCall.data.error.reason).toBe('NotActive');

          // While Turn is running, spence-browser executes and isolates Pages across Sessions.
          yield* sessions.prompt(s1, text('hold'));
          yield* sessions.prompt(s2, text('hold'));
          const nav1 = yield* callTool(browserServer1, 'navigate', {
            url: 'http://127.0.0.1:4444/s1',
          });
          expect(nav1.isError).toBe(false);
          const nav1Body = JSON.parse(
            (nav1.data as { readonly pageId?: string }) ? JSON.stringify(nav1.data) : '{}',
          ) as { readonly pageId?: string };
          expect(typeof nav1Body.pageId).toBe('string');

          const foreignSnap = yield* callTool(browserServer2, 'snapshot', {
            pageId: nav1Body.pageId,
          });
          expect(foreignSnap.isError).toBe(true);
          expect(foreignSnap.data.error.reason).toBe('PageNotFound');

          yield* sessions.cancel(s1);
          yield* sessions.cancel(s2);
          yield* liveState(s1, (state) => state.runningTurn === undefined);
          yield* liveState(s2, (state) => state.runningTurn === undefined);

          // Clearing context revokes the old spence-browser token.
          yield* sessions.clearContext(s1);
          const status = yield* Effect.promise(() =>
            fetch(browserServer1.url, {
              method: 'POST',
              headers: Object.fromEntries(
                browserServer1.headers.map(({ name, value }) => [name, value]),
              ),
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
            }).then((response) => response.status),
          );
          expect(status).toBe(403);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'omits spence-browser MCP server for Remote device Sessions',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const remoteId = yield* sessions.create(project);
          yield* sessions.prompt(remoteId, text('echo:seed'));
          const firstTurn = yield* untilTurnEnd(events(remoteId));
          const afterSeq = firstTurn.reduce(
            (max, item) => (item._tag === 'Transcript' ? Math.max(max, item.event.seq) : max),
            0,
          );

          yield* store.updateMeta(remoteId, (meta) => ({
            ...meta,
            deviceId: 'remote-device-9',
          }));
          yield* store.flush(remoteId);
          yield* sessions.clearContext(remoteId);
          const browserService = yield* BrowserService;
          const remoteStateErr = yield* browserService.getState(remoteId).pipe(Effect.flip);
          expect(remoteStateErr).toMatchObject({
            _tag: 'BrowserError',
            reason: 'RemoteUnsupported',
          });
          const remoteOpenErr = yield* browserService.setOpen(remoteId, true).pipe(Effect.flip);
          expect(remoteOpenErr).toMatchObject({
            _tag: 'BrowserError',
            reason: 'RemoteUnsupported',
          });
          yield* sessions.prompt(remoteId, text('report-mcp-servers'));
          const report = agentReply(transcript(yield* untilTurnEnd(events(remoteId, afterSeq))));
          const servers: ReadonlyArray<{ readonly name?: string }> = JSON.parse(report);
          expect(servers.map((s) => s.name)).toEqual(['spence']);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'Browser handoff raises needsAnswer Attention across events, changes, and list, and clears on continueAgent or Turn cancel',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const browserService = yield* BrowserService;
          const s1 = yield* sessions.create(project);

          yield* sessions.prompt(s1, text('report-mcp-servers'));
          const report = agentReply(transcript(yield* untilTurnEnd(events(s1))));
          const servers: ReadonlyArray<{
            name?: string;
            url: string;
            headers: ReadonlyArray<{ name: string; value: string }>;
          }> = JSON.parse(report);
          const browserServer = servers[1];
          if (browserServer === undefined) return yield* Effect.die('Browser MCP server missing');

          // Start a Turn and navigate + call handoff.
          yield* sessions.prompt(s1, text('hold'));
          yield* callTool(browserServer, 'navigate', { url: 'http://127.0.0.1:4444/login' });
          expect((yield* browserService.getState(s1)).control._tag).toBe('agentActive');

          const changesFiber = yield* sessions.changes.pipe(
            Stream.filter((c) => c.sessionId === s1 && c.state.attention === 'needsAnswer'),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          const handoffFiber = yield* callTool(browserServer, 'handoff', {
            reason: 'Sign in with SSO',
          }).pipe(Effect.forkChild);

          const needsYou = yield* liveState(s1, (state) => state.attention === 'needsAnswer').pipe(
            Effect.timeout('5 seconds'),
          );
          expect(needsYou.attention).toBe('needsAnswer');
          expect(yield* Fiber.join(changesFiber)).toHaveLength(1);
          expect((yield* sessions.list(project)).find((s) => s.id === s1)?.attention).toBe(
            'needsAnswer',
          );

          // Continuing clears needsAnswer Attention and resolves handoff.
          const clearedFiber = yield* sessions.changes.pipe(
            Stream.filter((c) => c.sessionId === s1 && c.state.attention === undefined),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          yield* browserService.continueAgent(s1);
          const handoffRes = yield* Fiber.join(handoffFiber);
          expect(handoffRes.isError).toBe(false);
          expect(yield* Fiber.join(clearedFiber)).toHaveLength(1);
          expect(
            (yield* liveState(s1, (state) => state.attention === undefined)).attention,
          ).toBeUndefined();

          // Cancelling the Turn while a second handoff is waiting unblocks handoff, resets control to idle, and clears Attention.
          const handoff2Fiber = yield* callTool(browserServer, 'handoff', {
            reason: 'Complete 2FA',
          }).pipe(Effect.forkChild);
          yield* liveState(s1, (state) => state.attention === 'needsAnswer');

          yield* sessions.cancel(s1);
          const handoff2Res = yield* Fiber.join(handoff2Fiber);
          expect(handoff2Res.isError).toBe(true);
          expect((yield* browserService.getState(s1)).control).toEqual({ _tag: 'idle' });
          yield* liveState(s1, (state) => state.runningTurn === undefined);
          expect((yield* liveState(s1, () => true)).attention).toBeUndefined();

          // stopAgent also cleanly unblocks pending Browser handoff and resets control to idle.
          yield* sessions.prompt(s1, text('hold'));
          const handoff3Fiber = yield* callTool(browserServer, 'handoff', {
            reason: 'Verify before stopAgent',
          }).pipe(Effect.forkChild);
          yield* liveState(s1, (state) => state.attention === 'needsAnswer').pipe(
            Effect.timeout('5 seconds'),
          );
          yield* sessions.stopAgent(s1, true);
          const handoff3Res = yield* Fiber.join(handoff3Fiber);
          expect(handoff3Res.status).toBe(403);
          expect((yield* browserService.getState(s1)).control).toEqual({ _tag: 'idle' });
          expect((yield* liveState(s1, () => true)).attention).toBe('error');
        }),
      ),
    TIMEOUT,
  );
});

describe('Browser URL safety guardrails & origin Permission requests', () => {
  const registerBrowserServer = (id: SessionId) =>
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const store = yield* SessionStore;
      const after = (yield* store.replay(id)).at(-1)?.seq;
      yield* sessions.prompt(id, text('report-mcp-servers'));
      const report = agentReply(transcript(yield* untilTurnEnd(events(id, after))));
      const servers: ReadonlyArray<McpServer & { readonly name?: string }> = JSON.parse(report);
      const browser = servers[1];
      if (browser === undefined || browser.name !== 'spence-browser') {
        return yield* Effect.die('spence-browser MCP server missing');
      }
      return browser;
    });

  const browserAnswering = (
    id: SessionId,
    server: McpServer,
    tool: string,
    args: Record<string, unknown>,
    optionId: 'allow-session' | 'allow-always' | 'deny',
  ) =>
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const store = yield* SessionStore;
      const after = (yield* store.replay(id)).at(-1)?.seq;
      const call = yield* Effect.forkChild(callTool(server, tool, args));
      const request = yield* events(id, after).pipe(
        Stream.map((item) =>
          item._tag === 'Transcript' &&
          item.event.item._tag === 'PermissionRequest' &&
          item.event.item.state._tag === 'pending'
            ? item.event.item
            : undefined,
        ),
        Stream.filter((found) => found !== undefined),
        Stream.runHead,
        Effect.flatMap((head) =>
          Option.match(head, {
            onNone: () => Effect.die('the stream ended before the request'),
            onSome: Effect.succeed,
          }),
        ),
      );
      yield* liveState(id, (state) => state.attention === 'needsAnswer');
      yield* sessions.answerPermission(id, request.id, optionId);
      return { request, res: yield* Fiber.join(call) };
    });

  it.live(
    'prompts with allow-session / allow-always / deny for external origins, enforces Session vs persisted Settings, and blocks non-HTTP(S) schemes',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const s1 = yield* sessions.create(project);
          const s2 = yield* sessions.create(project);
          const b1 = yield* registerBrowserServer(s1);
          const b2 = yield* registerBrowserServer(s2);

          yield* sessions.prompt(s1, text('hold'));
          yield* sessions.prompt(s2, text('hold'));

          // Non-HTTP(S) scheme is permanently blocked even in Auto mode without raising a PermissionRequest.
          const blocked = yield* callTool(b1, 'navigate', { url: 'file:///etc/passwd' });
          expect(blocked.isError).toBe(true);
          expect(blocked.data.error.reason).toBe('SchemeBlocked');

          // External origin raises a Step + PermissionRequest with allow-session, allow-always, deny.
          const denied = yield* browserAnswering(
            s1,
            b1,
            'navigate',
            { url: 'https://example.com/secret' },
            'deny',
          );
          expect(denied.request.options.map((o) => ({ id: o.id, kind: o.kind }))).toEqual([
            { id: 'allow-session', kind: 'allowOnce' },
            { id: 'allow-always', kind: 'allowAlways' },
            { id: 'deny', kind: 'rejectOnce' },
          ]);
          expect(denied.res.isError).toBe(true);
          expect(denied.res.data.error.reason).toBe('PermissionDenied');

          // allow-session approves only for s1 and stores nothing in Settings.
          const sessionAllowed = yield* browserAnswering(
            s1,
            b1,
            'navigate',
            { url: 'https://example.com/docs' },
            'allow-session',
          );
          expect(sessionAllowed.res.isError).toBe(false);
          const againInS1 = yield* callTool(b1, 'snapshot', {});
          expect(againInS1.isError).toBe(false);
          expect((yield* Settings.use((s) => s.get)).browserAllowedOrigins).toEqual([]);

          // s2 still prompts for https://example.com; allow-always persists it in Settings.
          const alwaysAllowed = yield* browserAnswering(
            s2,
            b2,
            'navigate',
            { url: 'https://example.com/home' },
            'allow-always',
          );
          expect(alwaysAllowed.res.isError).toBe(false);
          expect((yield* Settings.use((s) => s.get)).browserAllowedOrigins).toEqual([
            'https://example.com',
          ]);

          // A third Session sees the persisted origin without prompting.
          const s3 = yield* sessions.create(project);
          const b3 = yield* registerBrowserServer(s3);
          yield* sessions.prompt(s3, text('hold'));
          const s3Nav = yield* callTool(b3, 'navigate', { url: 'https://example.com/public' });
          expect(s3Nav.isError).toBe(false);

          yield* sessions.cancel(s1);
          yield* sessions.cancel(s2);
          yield* sessions.cancel(s3);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'auto-allows loopback in Auto mode, prompts in Ask mode, and cancels pending Browser Permission on Turn cancel',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const s1 = yield* sessions.create(project);
          const b1 = yield* registerBrowserServer(s1);

          // Auto mode: loopback succeeds immediately.
          yield* sessions.prompt(s1, text('hold'));
          const autoNav = yield* callTool(b1, 'navigate', { url: 'http://localhost:3000/app' });
          expect(autoNav.isError).toBe(false);
          yield* sessions.cancel(s1);
          yield* liveState(s1, (state) => state.runningTurn === undefined);

          // Ask mode: loopback triggers a PermissionRequest; cancelling the Turn denies it.
          yield* sessions.setOption({ sessionId: s1, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(s1, text('hold'));
          const call = yield* Effect.forkChild(
            callTool(b1, 'navigate', { url: 'http://localhost:3000/ask' }),
          );
          yield* liveState(s1, (state) => state.attention === 'needsAnswer');
          yield* sessions.cancel(s1);
          const cancelled = yield* Fiber.join(call);
          expect(cancelled.isError).toBe(true);
          expect(cancelled.data.error.reason).toBe('PermissionDenied');
        }),
      ),
    TIMEOUT,
  );
});
