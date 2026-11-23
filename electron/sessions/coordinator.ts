import { Clock, Context, Effect, Layer, PubSub, Semaphore, Stream } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import {
  type PermissionMode,
  type ProjectId,
  Timestamp,
} from '../../src/shared/projects/projects.rpc';
import type { SessionId, SessionTitle } from '../../src/shared/sessions/sessions.rpc';
import type { TabActivation } from '../../src/shared/tabs/tabs.rpc';
import { Projects } from '../projects/projects';
import { Settings } from '../settings/settings';
import type { Exchange } from './coordination-store';
import { makeRateLimiter, MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS } from './session-messaging';
import { isNativeWorker, SessionStore } from './session-store';

const makeCoordinator = Effect.gen(function* () {
  const projects = yield* Projects;
  const sessions = yield* SessionStore;
  const settings = yield* Settings;
  const created = yield* PubSub.unbounded<TabActivation>();
  const grants = yield* Semaphore.make(1);
  const allow = makeRateLimiter(MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS);

  const project = (id: string) =>
    Effect.map(projects.list, (list) => list.find((entry) => entry.id === id));

  const discover = Effect.fn('Coordinator.discover')(function* (
    caller: SessionId,
    projectId: ProjectId,
  ) {
    const all = yield* sessions.listAll;
    return all.filter(
      (entry) =>
        entry.id !== caller &&
        entry.projectId === projectId &&
        entry.archivedAt === undefined &&
        !isNativeWorker(entry),
    );
  });

  const target = Effect.fn('Coordinator.target')(function* (caller: SessionId, id: string) {
    if (caller === id) return undefined;
    const meta = (yield* sessions.listAll).find((entry) => entry.id === id);
    if (meta === undefined || isNativeWorker(meta)) return undefined;
    const destination = yield* project(meta.projectId);
    return destination === undefined ? undefined : { meta, project: destination };
  });

  const allowed = Effect.fn('Coordinator.allowed')(function* (from: ProjectId, to: ProjectId) {
    return (yield* settings.get).crossProjectAccess.some(
      (entry) => entry.from === from && entry.to === to,
    );
  });

  const needsApproval = Effect.fn('Coordinator.needsApproval')(function* (input: {
    readonly mode: PermissionMode;
    readonly from: ProjectId;
    readonly to: ProjectId;
    readonly startsSession: boolean;
    readonly isReply: boolean;
  }) {
    if (input.mode === 'auto') return false;
    if (input.startsSession) return true;
    if (input.isReply || input.from === input.to) return false;
    return !(yield* allowed(input.from, input.to));
  });

  const grant = (from: ProjectId, to: ProjectId) =>
    grants.withPermit(
      Effect.gen(function* () {
        const settingsNow = yield* settings.get;
        const active = new Set((yield* projects.list).map((entry) => entry.id));
        if (
          !active.has(from) ||
          !active.has(to) ||
          settingsNow.crossProjectAccess.some((entry) => entry.from === from && entry.to === to)
        )
          return;
        const addedAt = Timestamp.make(yield* Clock.currentTimeMillis);
        yield* settings
          .update({
            crossProjectAccess: [...settingsNow.crossProjectAccess, { from, to, addedAt }],
          })
          .pipe(Effect.ignore);
      }),
    );

  const key = (session: SessionId, context: string, requestId: string | undefined) =>
    requestId === undefined
      ? randomUUID()
      : createHash('sha256')
          .update(JSON.stringify([session, context, requestId]))
          .digest('hex');

  const exchange = (id: string) =>
    Effect.map(sessions.coordination.list, (list) => list.find((entry) => entry.id === id));

  const accept = (record: Exchange) =>
    sessions.coordination.update((list) =>
      list.some((entry) => entry.id === record.id) ? list : [...list, record],
    );

  const update = (id: string, change: Partial<Pick<Exchange, 'status' | 'failure' | 'delivery'>>) =>
    sessions.coordination.update((list) =>
      list.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)),
    );

  const discardQueued = (matches: (entry: Exchange) => boolean, failure: string) =>
    sessions.coordination.update((list) => {
      const discard = (entry: Exchange) => entry.status === 'queued' && matches(entry);
      return list.some(discard)
        ? list.map((entry) => (discard(entry) ? { ...entry, status: 'failed', failure } : entry))
        : list;
    });

  const acknowledgeTabs = (ids: ReadonlySet<SessionId>) =>
    sessions.coordination.update((list) => {
      const added = (entry: Exchange) =>
        entry.startsSession && !entry.tabOpened && ids.has(entry.target);
      return list.some(added)
        ? list.map((entry) => (added(entry) ? { ...entry, tabOpened: true } : entry))
        : list;
    });

  const backgroundTab = (record: Exchange, title: SessionTitle): TabActivation => ({
    sessionId: record.target,
    projectId: record.project,
    title,
    background: true,
  });

  const announceCreation = (record: Exchange, title: SessionTitle) =>
    PubSub.publish(created, backgroundTab(record, title));

  const backgroundTabs = Stream.unwrap(
    Effect.gen(function* () {
      const live = yield* PubSub.subscribe(created);
      const activeProjects = new Set((yield* projects.list).map((entry) => entry.id));
      const pending = (yield* sessions.coordination.list).filter(
        (record) => record.startsSession && !record.tabOpened && activeProjects.has(record.project),
      );
      const initial = yield* Effect.forEach(pending, (record) =>
        sessions.get(record.target).pipe(
          Effect.map((meta) =>
            meta.archivedAt === undefined
              ? backgroundTab(record, {
                  ...(meta.userTitle === undefined ? {} : { user: meta.userTitle }),
                  ...(meta.autoTitle === undefined ? {} : { auto: meta.autoTitle }),
                  autoIsPlaceholder: meta.autoTitleIsPlaceholder,
                })
              : undefined,
          ),
          Effect.catchTag('SessionError', () => Effect.succeed(undefined)),
        ),
      );
      return Stream.concat(
        Stream.fromIterable(initial.filter((item) => item !== undefined)),
        Stream.fromSubscription(live),
      );
    }),
  );

  return {
    project,
    projects: projects.list,
    discover,
    target,
    needsApproval,
    grant,
    allow,
    exchanges: sessions.coordination.list,
    exchange,
    key,
    accept,
    update,
    acknowledgeTabs,
    announceCreation,
    backgroundTabs,
    discardQueued,
  };
});

export class Coordinator extends Context.Service<
  Coordinator,
  Effect.Success<typeof makeCoordinator>
>()('sessions/Coordinator') {}

export const layerCoordinator = Layer.effect(Coordinator, makeCoordinator);
