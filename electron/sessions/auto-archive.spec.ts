import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { PermissionMode, ProjectId, Timestamp } from '../../src/shared/projects/projects.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { type Settings as SettingsValue } from '../../src/shared/settings/settings.rpc';
import { Settings } from '../settings/settings';
import { type AutoArchive, DAY_MS, layerAutoArchive } from './auto-archive';
import { AgentContextId, SessionStore, type SessionMeta } from './session-store';
import { Sessions } from './sessions';

const makeMeta = (id: string, lastActivityAt: number, archivedAt?: number): SessionMeta => {
  const activeContextId = AgentContextId.make('ctx-1');
  const agentId = AgentId.make('agent');
  const createdAt = Timestamp.make(lastActivityAt);
  return {
    id: SessionId.make(id),
    projectId: ProjectId.make('p1'),
    cwd: '/proj',
    agentId,
    autoTitleIsPlaceholder: false,
    createdAt,
    lastActivityAt: createdAt,
    ...(archivedAt === undefined ? {} : { archivedAt: Timestamp.make(archivedAt) }),
    activeContextId,
    contexts: [{ id: activeContextId, agentId, acpSessionIds: [], createdAt }],
    permissionMode: PermissionMode.make('auto'),
  };
};

const runAutoArchive = <A, E, R>(options: {
  readonly autoArchiveDays: number | null;
  readonly metas: ReadonlyArray<SessionMeta>;
  readonly protectedIds: ReadonlySet<SessionId>;
  readonly program: (calls: {
    readonly archived: Array<SessionId>;
    readonly deleted: Array<SessionId>;
  }) => Effect.Effect<A, E, R | AutoArchive>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const archived: Array<SessionId> = [];
      const deleted: Array<SessionId> = [];
      const metas = [...options.metas];
      const baseTime = 100 * DAY_MS;
      yield* TestClock.setTime(baseTime);

      const settingsLayer = Layer.succeed(Settings, {
        get: Effect.succeed<SettingsValue>({
          language: 'system',
          theme: 'system',
          notifications: true,
          sidebarLayout: 'oneProject',
          projectOrder: { by: 'lastUsed', direction: 'desc' },
          defaultPermissionMode: 'auto',
          defaultAgent: 'claude',
          agents: {},
          autoArchiveDays: options.autoArchiveDays,
        }),
        update: () => Effect.die('unused'),
      });
      const storeLayer = Layer.succeed(SessionStore, {
        createDraft: () => Effect.die('unused'),
        append: () => Effect.die('unused'),
        setOptions: () => Effect.die('unused'),
        flush: () => Effect.die('unused'),
        replay: () => Effect.die('unused'),
        get: () => Effect.die('unused'),
        addAcpSession: () => Effect.die('unused'),
        startContext: () => Effect.die('unused'),
        setMemoryLost: () => Effect.die('unused'),
        list: () => Effect.die('unused'),
        listAll: Effect.succeed(metas),
        relocate: () => Effect.die('unused'),
        updateMeta: () => Effect.die('unused'),
        remove: () => Effect.die('unused'),
        meta: () => Effect.die('unused'),
      });
      const sessionsLayer = Layer.succeed(Sessions, {
        create: () => Effect.die('unused'),
        setAgent: () => Effect.die('unused'),
        agentOf: () => Effect.die('unused'),
        prompt: () => Effect.die('unused'),
        cancel: () => Effect.die('unused'),
        startEmptyContext: () => Effect.die('unused'),
        stopAgent: () => Effect.die('unused'),
        checkExitGate: () => Effect.die('unused'),
        rename: () => Effect.die('unused'),
        retryAgent: () => Effect.die('unused'),
        loginAgent: () => Effect.die('unused'),
        clearContext: () => Effect.die('unused'),
        answerPermission: () => Effect.die('unused'),
        setOption: () => Effect.die('unused'),
        archive: (id) =>
          Effect.sync(() => {
            archived.push(id);
            const idx = metas.findIndex((m) => m.id === id);
            const found = metas[idx];
            if (found !== undefined) {
              metas[idx] = { ...found, archivedAt: Timestamp.make(Date.now()) };
            }
          }),
        unarchive: () => Effect.die('unused'),
        remove: (id) =>
          Effect.sync(() => {
            deleted.push(id);
          }),
        protectedFromAutoArchive: Effect.succeed(options.protectedIds),
        events: () => Stream.die('unused'),
        setTabs: () => Effect.die('unused'),
        restoreTabs: Effect.die('unused'),
        changes: Stream.die('unused'),
        list: () => Effect.die('unused'),
        cancelProject: () => Effect.die('unused'),
        getComposer: () => Effect.die('unused'),
        setComposer: () => Effect.die('unused'),
      });

      const layer = layerAutoArchive.pipe(
        Layer.provide(Layer.mergeAll(settingsLayer, storeLayer, sessionsLayer)),
      );
      return yield* options
        .program({
          archived,
          deleted,
        })
        .pipe(Effect.provide(layer));
    }),
  );

describe('AutoArchive', () => {
  it.effect('does nothing when autoArchiveDays is null', () =>
    runAutoArchive({
      autoArchiveDays: null,
      metas: [makeMeta('very-old', 0)],
      protectedIds: new Set(),
      program: ({ archived, deleted }) =>
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          yield* TestClock.adjust('1 hour');
          expect(archived).toEqual([]);
          expect(deleted).toEqual([]);
        }),
    }),
  );

  it.effect(
    'archives idle sessions >= autoArchiveDays at launch and hourly, skipping protected and already archived, never deleting',
    () => {
      const now = 100 * DAY_MS;
      const exactlyOld = makeMeta('exactly-30d', now - 30 * DAY_MS);
      const almostOld = makeMeta('29d-plus', now - 30 * DAY_MS + 1800_000); // crosses threshold within 1 hour
      const fresh = makeMeta('fresh', now - DAY_MS);
      const protectedIdle = makeMeta('open-tab-or-turn', now - 60 * DAY_MS);
      const alreadyArchived = makeMeta('already-archived', now - 60 * DAY_MS, now - 5 * DAY_MS);

      return runAutoArchive({
        autoArchiveDays: 30,
        metas: [exactlyOld, almostOld, fresh, protectedIdle, alreadyArchived],
        protectedIds: new Set([protectedIdle.id]),
        program: ({ archived, deleted }) =>
          Effect.gen(function* () {
            // Launch sweep runs immediately without needing 1 hour.
            yield* Effect.yieldNow;
            expect(archived).toEqual([exactlyOld.id]);
            expect(deleted).toEqual([]);

            // Advance 1 hour: hourly sweep triggers and picks up `almostOld` once it passes 30 days.
            yield* TestClock.adjust('1 hour');
            expect(archived).toEqual([exactlyOld.id, almostOld.id]);
            expect(deleted).toEqual([]);
          }),
      });
    },
  );
});
