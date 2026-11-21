import { Clock, Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AcpSessionId } from '../acp/acpSession';
import { AgentId, Effort } from '../../src/shared/agents/agents.rpc';
import {
  ContextUsageReading,
  ForkLineage,
  ForkTarget,
  HandoffAttempt,
  SessionError,
  SessionId,
  type SessionSummary,
  WorkerKind,
  TurnId,
  type TranscriptEvent,
  type TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';
import { WorkflowTarget } from '../../src/shared/settings/settings.rpc';
import { PermissionMode, ProjectId, Timestamp } from '../../src/shared/projects/projects.rpc';
import { layerStoreUserData, Store, type VersionedFile } from '../store/store';
import { inlineEvent, StoredEvent, storeEvent, type BlobBytes } from './transcript-file';

export const AgentContextId = Schema.String.pipe(Schema.brand('AgentContextId')).annotate({
  identifier: 'AgentContextId',
});
export type AgentContextId = typeof AgentContextId.Type;

/** One stretch of a Session during which one Agent retains its conversational memory (spec 2.4). */
export const AgentContext = Schema.Struct({
  id: AgentContextId,
  agentId: AgentId,
  /** Every ACP session id opened in this Agent context, newest last. */
  acpSessionIds: Schema.Array(AcpSessionId),
  createdAt: Timestamp,
  retiredAt: Schema.optionalKey(Timestamp),
}).annotate({ identifier: 'AgentContext' });
export type AgentContext = typeof AgentContext.Type;

export const WorkflowVerification = Schema.Struct({
  turnId: TurnId,
  worktree: Schema.String,
  verifier: WorkflowTarget,
  baseline: Schema.Struct({
    staged: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
    working: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  }),
  phase: Schema.Literals(['preparing', 'implementing', 'verifying']),
}).annotate({ identifier: 'WorkflowVerification' });
export type WorkflowVerification = typeof WorkflowVerification.Type;

/** `sessions/<id>/session.json`: what Spence keeps about a Session besides its Transcript (spec 2.4). */
export const SessionMeta = Schema.Struct({
  id: SessionId,
  projectId: ProjectId,
  /** The folder the Session runs in; the Project folder in v1. */
  cwd: Schema.String,
  agentId: AgentId,
  userTitle: Schema.optionalKey(Schema.String),
  autoTitle: Schema.optionalKey(Schema.String),
  autoTitleImageCount: Schema.optionalKey(Schema.Number),
  autoTitleIsPlaceholder: Schema.Boolean,
  createdAt: Timestamp,
  lastActivityAt: Timestamp,
  archivedAt: Schema.optionalKey(Timestamp),
  activeContextId: AgentContextId,
  /** Durable Agent contexts in chronological order; retired contexts are never resurrected. */
  contexts: Schema.Array(AgentContext),
  /** True when reopening failed to restore the active context, until resolved by the user. */
  memoryLost: Schema.optionalKey(Schema.Boolean),
  /** The last chosen options. */
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Effort),
  permissionMode: PermissionMode,
  /** The last valid reported Context usage, restored as `historical` on reopen. */
  contextUsage: Schema.optionalKey(ContextUsageReading),
  /** Immediate Parent Session for a Worker, independent of Fork lineage. */
  parentSessionId: Schema.optionalKey(SessionId),
  /** Absent on legacy native records; owned Workers must be explicitly marked. */
  workerKind: Schema.optionalKey(WorkerKind),
  workflowTurnId: Schema.optionalKey(TurnId),
  workflowVerifications: Schema.optionalKey(Schema.Array(WorkflowVerification)),
  /**
   * Whether a native Worker was last known working (running or waiting for Permission). Absent on records from
   * before it was kept: restoration then falls back to an unfinished Turn in the Transcript.
   */
  workerActive: Schema.optionalKey(Schema.Boolean),
  /** Native identity within the immediate Parent Session; never exposed to the renderer. */
  nativeWorkerId: Schema.optionalKey(Schema.String),
  /** The Parent's Agent context scopes native IDs across context replacement. */
  nativeWorkerParentContextId: Schema.optionalKey(AgentContextId),
  /** Durable lineage when this Session is a Fork (spec 2.6). */
  forkLineage: Schema.optionalKey(ForkLineage),
  /** Reciprocal links to surviving Forks branched from this Session (spec 2.6). */
  forks: Schema.optionalKey(Schema.Array(ForkTarget)),
});
export type SessionMeta = typeof SessionMeta.Type;

type WorkerShape = Pick<SessionMeta, 'parentSessionId' | 'workerKind'>;

/** A Spence-owned Worker: explicitly marked and with an immediate Parent. */
export const isOwnedWorker = (
  meta: WorkerShape | undefined,
): meta is WorkerShape & { readonly parentSessionId: SessionId } =>
  meta?.workerKind === 'owned' && meta.parentSessionId !== undefined;

/** A provider-native Worker: has a Parent but is not Spence-owned (legacy records carry no kind). */
export const isNativeWorker = (meta: WorkerShape): boolean =>
  meta.parentSessionId !== undefined && meta.workerKind !== 'owned';

/** The current active Agent context of a Session, if present. */
export const activeContextOf = (meta: SessionMeta): AgentContext | undefined =>
  meta.contexts.find((context) => context.id === meta.activeContextId);

export interface SessionStoreShape {
  /** Persist an announced Worker immediately, or return the existing identity for a repeat announcement. */
  readonly ensureWorker: (
    meta: SessionMeta & { readonly parentSessionId: SessionId },
    nativeWorkerId: string,
    parentContextId: AgentContextId,
  ) => Effect.Effect<SessionMeta, SessionError>;
  readonly workflowBaselinePath: (id: SessionId, turn: TurnId) => string | undefined;
  /** Starts a draft Session: kept in memory only, and written with its first appended event. */
  readonly createDraft: (meta: SessionMeta) => Effect.Effect<void>;
  /**
   * Numbers items as the Session's next events and queues them for the next batch (about every 250 ms).
   * Returns the events, for the live stream.
   */
  readonly append: (
    id: SessionId,
    items: ReadonlyArray<TranscriptItem>,
  ) => Effect.Effect<ReadonlyArray<TranscriptEvent>, SessionError>;
  /**
   * Records the Session's last chosen options in `session.json`, with its next batch. A draft keeps them in memory
   * until its first event; a Session the store does not know is left alone.
   */
  readonly setOptions: (
    id: SessionId,
    options: Partial<Pick<SessionMeta, 'model' | 'effort' | 'permissionMode'>>,
  ) => Effect.Effect<void>;
  /** Writes the Session's queued events now, e.g. at Turn end. */
  readonly flush: (id: SessionId) => Effect.Effect<void, SessionError>;
  /** The Session's events after `afterSeq` (all when absent), written or still queued, with blobs inlined. */
  readonly replay: (
    id: SessionId,
    afterSeq?: number,
  ) => Effect.Effect<ReadonlyArray<TranscriptEvent>, SessionError>;
  /** What Spence keeps about the Session (a draft's too); `NotFound` when it has none. */
  readonly get: (id: SessionId) => Effect.Effect<SessionMeta, SessionError>;
  /** Records the newest ACP session id on the current active Agent context, unless already last. */
  readonly addAcpSession: (
    id: SessionId,
    acpSessionId: AcpSessionId,
  ) => Effect.Effect<void, SessionError>;
  /** Retires the current active Agent context and starts a fresh one for `agentId`. */
  readonly startContext: (
    id: SessionId,
    agentId: AgentId,
  ) => Effect.Effect<AgentContext, SessionError>;
  /** Persists or clears the `memoryLost` reopen gate for a Session. */
  readonly setMemoryLost: (id: SessionId, lost: boolean) => Effect.Effect<void, SessionError>;
  /** A Project's kept top-level Sessions, most recent activity first. Drafts and Workers are not listed. */
  readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<SessionSummary>>;
  /** Every kept Session across all Projects. Drafts are not listed. */
  readonly listAll: Effect.Effect<ReadonlyArray<SessionMeta>>;
  /**
   * Points every Session whose `cwd` is the old folder (`isOldFolder`) at `to`, drafts included. A Session file that
   * cannot be read, or one from a newer Spence, is left untouched.
   */
  readonly relocate: (isOldFolder: (cwd: string) => boolean, to: string) => Effect.Effect<void>;
  /** Changes what is kept about a Session (`session.json`), written with the next batch. */
  readonly updateMeta: (
    id: SessionId,
    change: (meta: SessionMeta) => SessionMeta,
  ) => Effect.Effect<void, SessionError>;
  /** Removes a Session (or draft) from memory and its `sessions/<id>/` folder from disk. */
  readonly remove: (id: SessionId) => Effect.Effect<void>;
  /** What is kept about a Session, drafts included. */
  readonly meta: (id: SessionId) => Effect.Effect<SessionMeta, SessionError>;
  /** Persists a failed/interrupted `HandoffAttempt` on the source Session, newest first. */
  readonly saveHandoffAttempt: (
    id: SessionId,
    attempt: HandoffAttempt,
  ) => Effect.Effect<void, SessionError>;
  /** Lists persisted `HandoffAttempt`s for a Session, newest first. */
  readonly listHandoffAttempts: (
    id: SessionId,
  ) => Effect.Effect<ReadonlyArray<HandoffAttempt>, SessionError>;
}

/** Sessions and their Transcripts in the Store, under `sessions/<sessionId>/`. */
export class SessionStore extends Context.Service<SessionStore, SessionStoreShape>()(
  'sessions/SessionStore',
) {}

/** How long appended events may wait before they are written. */
export const BATCH_INTERVAL = '250 millis';

const SESSIONS = 'sessions';
/** Ids become folder names: anything else could escape `sessions/`. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const sessionDir = (id: SessionId) => path.join(SESSIONS, id);
const transcriptFile = (id: SessionId) => path.join(sessionDir(id), 'transcript.jsonl');
const blobsDir = (id: SessionId) => path.join(sessionDir(id), 'blobs');

const migrateV1ToV2 = (body: unknown): unknown => {
  if (typeof body !== 'object' || body === null) return body;
  const record = body as Record<string, unknown>;
  const { acpSessionIds, ...rest } = record;
  const contextId = 'ctx-1';
  return {
    ...rest,
    activeContextId: contextId,
    contexts: [
      {
        id: contextId,
        agentId: record['agentId'],
        acpSessionIds: Array.isArray(acpSessionIds) ? acpSessionIds : [],
        createdAt: record['createdAt'],
      },
    ],
  };
};

const metaFile = (id: SessionId): VersionedFile<SessionMeta | undefined> => ({
  file: path.join(sessionDir(id), 'session.json'),
  version: 2,
  migrations: [migrateV1ToV2],
  schema: Schema.UndefinedOr(SessionMeta),
  initial: () => undefined,
});

const HandoffAttemptsData = Schema.Struct({
  attempts: Schema.Array(HandoffAttempt),
});
type HandoffAttemptsData = typeof HandoffAttemptsData.Type;

const handoffsFile = (id: SessionId): VersionedFile<HandoffAttemptsData> => ({
  file: path.join(sessionDir(id), 'handoffs.json'),
  version: 1,
  migrations: [],
  schema: HandoffAttemptsData,
  initial: () => ({ attempts: [] }),
});

/** A Session this run has touched. */
interface Entry {
  meta: SessionMeta;
  lastSeq: number;
  /** Appended, not yet written. */
  pending: Array<TranscriptEvent>;
  metaDirty: boolean;
}

const notFound = (id: SessionId) =>
  new SessionError({ reason: 'NotFound', detail: `no Session ${id}` });

const toSummary = (meta: SessionMeta, workerCount = 0): SessionSummary => ({
  id: meta.id,
  agentId: meta.agentId,
  title: {
    ...(meta.userTitle === undefined ? {} : { user: meta.userTitle }),
    ...(meta.autoTitle === undefined ? {} : { auto: meta.autoTitle }),
    ...(meta.autoTitleImageCount === undefined ? {} : { autoImageCount: meta.autoTitleImageCount }),
    autoIsPlaceholder: meta.autoTitleIsPlaceholder,
  },
  lastActivityAt: meta.lastActivityAt,
  ...(meta.archivedAt === undefined ? {} : { archivedAt: meta.archivedAt }),
  ...(workerCount === 0 ? {} : { workerCount }),
});

/** The number of Worker descendants (any depth) of each Session that has some. */
const descendantCounts = (metas: ReadonlyArray<SessionMeta>): ReadonlyMap<SessionId, number> => {
  const children = new Map<SessionId, Array<SessionId>>();
  for (const meta of metas) {
    if (meta.parentSessionId === undefined) continue;
    children.set(meta.parentSessionId, [...(children.get(meta.parentSessionId) ?? []), meta.id]);
  }
  const count = (id: SessionId, seen: ReadonlySet<SessionId>): number =>
    (children.get(id) ?? []).reduce(
      (sum, child) => (seen.has(child) ? sum : sum + 1 + count(child, new Set([...seen, id]))),
      0,
    );
  return new Map([...children.keys()].map((id) => [id, count(id, new Set())]));
};

export const layerSessionStore = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const store = yield* Store;
    const lock = (yield* Semaphore.make(1)).withPermit;
    const entries = new Map<SessionId, Entry>();

    const blobs = (id: SessionId): BlobBytes => ({
      put: (bytes) => store.putBlob(blobsDir(id), bytes),
      get: (hash) => store.getBlob(blobsDir(id), hash).pipe(Effect.orDie),
    });

    const readStored = (id: SessionId) =>
      store.readLines(transcriptFile(id), StoredEvent).pipe(Effect.orDie);

    /** The Session's entry, loaded from disk on first use. */
    const load = Effect.fnUntraced(function* (id: SessionId) {
      const known = entries.get(id);
      if (known !== undefined) return known;
      if (!SAFE_ID.test(id)) return yield* notFound(id);
      const meta = yield* store.readVersioned(metaFile(id));
      if (meta === undefined) return yield* notFound(id);
      const stored = yield* readStored(id);
      const entry: Entry = {
        meta,
        lastSeq: stored.at(-1)?.seq ?? 0,
        pending: [],
        metaDirty: false,
      };
      entries.set(id, entry);
      return entry;
    });

    /** `load` for callers that cannot act on an unreadable Session file. */
    const loadOrDie = (id: SessionId) =>
      load(id).pipe(Effect.catchTag('StoreError', (error) => Effect.die(error)));

    /** Writes an entry's queued events; uninterruptible, so a batch is never written twice. */
    const write = (id: SessionId, entry: Entry) =>
      Effect.gen(function* () {
        if (entry.pending.length === 0 && !entry.metaDirty) return;
        const batch = [...entry.pending];
        const stored = yield* Effect.forEach(batch, storeEvent(blobs(id)));
        if (entry.metaDirty) yield* store.writeVersioned(metaFile(id), entry.meta);
        entry.metaDirty = false;
        yield* store.appendLines(transcriptFile(id), StoredEvent, stored);
        entry.pending.splice(0, batch.length);
      }).pipe(Effect.uninterruptible);

    const flushAll = lock(
      Effect.suspend(() =>
        Effect.forEach([...entries], ([id, entry]) => write(id, entry), { discard: true }),
      ),
    );

    yield* Effect.addFinalizer(() => flushAll);
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(BATCH_INTERVAL).pipe(Effect.andThen(flushAll))),
    );

    const createDraft = (meta: SessionMeta) =>
      lock(
        Effect.sync(() => {
          entries.set(meta.id, { meta, lastSeq: 0, pending: [], metaDirty: false });
        }),
      );

    const append = (id: SessionId, items: ReadonlyArray<TranscriptItem>) =>
      lock(
        Effect.gen(function* () {
          const entry = yield* loadOrDie(id);
          if (items.length === 0) return [];
          const at = yield* Clock.currentTimeMillis;
          const events = items.map((item): TranscriptEvent => ({ seq: ++entry.lastSeq, at, item }));
          entry.pending.push(...events);
          entry.meta = { ...entry.meta, lastActivityAt: at };
          entry.metaDirty = true;
          return events;
        }),
      );

    const setOptions = (
      id: SessionId,
      options: Partial<Pick<SessionMeta, 'model' | 'effort' | 'permissionMode'>>,
    ) =>
      lock(
        loadOrDie(id).pipe(
          Effect.map((entry) => {
            entry.meta = { ...entry.meta, ...options };
            // A draft is written with its first event, options included.
            if (entry.lastSeq > 0) entry.metaDirty = true;
          }),
          Effect.catchTag('SessionError', () => Effect.void),
        ),
      );

    const flush = (id: SessionId) =>
      lock(loadOrDie(id).pipe(Effect.flatMap((entry) => write(id, entry))));

    const replay = (id: SessionId, afterSeq = 0) =>
      lock(
        Effect.gen(function* () {
          const entry = yield* loadOrDie(id);
          const written = yield* readStored(id);
          const inlined = yield* Effect.forEach(
            written.filter((event) => event.seq > afterSeq),
            inlineEvent(blobs(id)),
          );
          return [...inlined, ...entry.pending.filter((event) => event.seq > afterSeq)];
        }),
      );

    const get = (id: SessionId) => lock(loadOrDie(id).pipe(Effect.map((entry) => entry.meta)));

    const addAcpSession = (id: SessionId, acpSessionId: AcpSessionId) =>
      lock(
        Effect.gen(function* () {
          const entry = yield* loadOrDie(id);
          const active = activeContextOf(entry.meta);
          if (active === undefined || active.acpSessionIds.at(-1) === acpSessionId) return;
          entry.meta = {
            ...entry.meta,
            contexts: entry.meta.contexts.map((context) =>
              context.id === active.id
                ? { ...context, acpSessionIds: [...context.acpSessionIds, acpSessionId] }
                : context,
            ),
          };
          // A draft is written with its first event.
          if (entry.lastSeq > 0) entry.metaDirty = true;
        }),
      );

    const startContext = (id: SessionId, agentId: AgentId) =>
      lock(
        Effect.gen(function* () {
          const entry = yield* loadOrDie(id);
          const now = Timestamp.make(yield* Clock.currentTimeMillis);
          const next: AgentContext = {
            id: AgentContextId.make(randomUUID()),
            agentId,
            acpSessionIds: [],
            createdAt: now,
          };
          const { memoryLost: _dropLost, ...rest } = entry.meta;
          entry.meta = {
            ...rest,
            agentId,
            activeContextId: next.id,
            contexts: [
              ...entry.meta.contexts.map((context) =>
                context.id === entry.meta.activeContextId && context.retiredAt === undefined
                  ? { ...context, retiredAt: now }
                  : context,
              ),
              next,
            ],
          };
          if (entry.lastSeq > 0) entry.metaDirty = true;
          return next;
        }),
      );

    const setMemoryLost = (id: SessionId, lost: boolean) =>
      lock(
        Effect.gen(function* () {
          const entry = yield* loadOrDie(id);
          if (lost) {
            entry.meta = { ...entry.meta, memoryLost: true };
          } else {
            const { memoryLost: _drop, ...rest } = entry.meta;
            entry.meta = rest;
          }
          if (entry.lastSeq > 0) entry.metaDirty = true;
        }),
      );

    /** Every Session this run knows of: on disk or in memory, drafts included. */
    const allIds = store
      .listDir(SESSIONS)
      .pipe(
        Effect.map(
          (names) =>
            new Set([
              ...names.filter((name) => SAFE_ID.test(name)).map((name) => SessionId.make(name)),
              ...entries.keys(),
            ]),
        ),
      );

    /** A Session's meta as on disk; none when it is missing or Spence cannot read it (logged with `why`). */
    const readMeta = (id: SessionId, why: string) =>
      store
        .readVersioned(metaFile(id))
        .pipe(
          Effect.catchTag('StoreError', (error) =>
            Effect.logWarning(`Session ${id} ${why}: ${error.detail}`).pipe(Effect.as(undefined)),
          ),
        );

    const keptMetas = Effect.gen(function* () {
      const metas = yield* Effect.forEach(
        yield* allIds,
        (id): Effect.Effect<ReadonlyArray<SessionMeta>> => {
          const entry = entries.get(id);
          // A draft with no events is not kept yet.
          if (entry !== undefined) {
            return Effect.succeed(
              entry.lastSeq === 0 && entry.meta.nativeWorkerId === undefined ? [] : [entry.meta],
            );
          }
          return readMeta(id, 'is not listed').pipe(
            Effect.map((meta) => (meta === undefined ? [] : [meta])),
          );
        },
      );
      return metas.flat();
    });

    const list = (projectId: ProjectId) =>
      lock(
        keptMetas.pipe(
          Effect.map((metas) => {
            const counts = descendantCounts(metas);
            return metas
              .filter((meta) => meta.projectId === projectId && meta.parentSessionId === undefined)
              .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
              .map((meta) => toSummary(meta, counts.get(meta.id)));
          }),
        ),
      );

    const listAll = lock(keptMetas);

    const ensureWorker = (
      meta: SessionMeta & { readonly parentSessionId: SessionId },
      nativeWorkerId: string,
      parentContextId: AgentContextId,
    ) =>
      lock(
        Effect.gen(function* () {
          const existing = (yield* keptMetas).find(
            (candidate) =>
              candidate.parentSessionId === meta.parentSessionId &&
              candidate.nativeWorkerId === nativeWorkerId &&
              candidate.nativeWorkerParentContextId === parentContextId,
          );
          if (existing !== undefined) return existing;
          const occupied = yield* loadOrDie(meta.id).pipe(
            Effect.map(() => true),
            Effect.catchTag('SessionError', () => Effect.succeed(false)),
          );
          if (occupied) {
            return yield* new SessionError({
              reason: 'Busy',
              detail: `Session ${meta.id} already exists`,
            });
          }
          const worker = {
            ...meta,
            workerKind: 'native' as const,
            nativeWorkerId,
            nativeWorkerParentContextId: parentContextId,
          };
          const entry: Entry = { meta: worker, lastSeq: 0, pending: [], metaDirty: true };
          yield* write(worker.id, entry);
          entries.set(worker.id, entry);
          return worker;
        }),
      );

    const relocateOne = Effect.fnUntraced(function* (
      id: SessionId,
      isOldFolder: (cwd: string) => boolean,
      to: string,
    ) {
      const entry = entries.get(id);
      if (entry !== undefined) {
        if (!isOldFolder(entry.meta.cwd)) return;
        entry.meta = { ...entry.meta, cwd: to };
        // A draft is written with its first event, already in the new folder.
        if (entry.lastSeq === 0) return;
        entry.metaDirty = true;
        return yield* write(id, entry);
      }
      const meta = yield* readMeta(id, 'is not relocated');
      if (meta === undefined || !isOldFolder(meta.cwd)) return;
      yield* store.writeVersioned(metaFile(id), { ...meta, cwd: to });
    });

    const relocate = (isOldFolder: (cwd: string) => boolean, to: string) =>
      lock(
        allIds.pipe(
          Effect.flatMap((ids) =>
            Effect.forEach(ids, (id) => relocateOne(id, isOldFolder, to), { discard: true }),
          ),
        ),
      );

    const updateMeta = (id: SessionId, change: (meta: SessionMeta) => SessionMeta) =>
      lock(
        Effect.gen(function* () {
          const entry = yield* loadOrDie(id);
          entry.meta = change(entry.meta);
          // A draft is written with its first event.
          if (entry.lastSeq > 0) entry.metaDirty = true;
        }),
      );

    const remove = (id: SessionId) =>
      lock(
        Effect.gen(function* () {
          entries.delete(id);
          if (SAFE_ID.test(id)) yield* store.removeDir(sessionDir(id));
        }),
      );

    const meta = get;

    const listHandoffAttempts = (id: SessionId) =>
      lock(
        Effect.gen(function* () {
          if (!SAFE_ID.test(id)) return [];
          const data = yield* store
            .readVersioned(handoffsFile(id))
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(`Session ${id} handoffs: ${error.detail}`).pipe(
                  Effect.as({ attempts: [] } satisfies HandoffAttemptsData),
                ),
              ),
            );
          return data.attempts;
        }),
      );

    const saveHandoffAttempt = (id: SessionId, attempt: HandoffAttempt) =>
      lock(
        Effect.gen(function* () {
          yield* loadOrDie(id);
          const existing = yield* store
            .readVersioned(handoffsFile(id))
            .pipe(
              Effect.catch(() => Effect.succeed({ attempts: [] } satisfies HandoffAttemptsData)),
            );
          const filtered = existing.attempts.filter((item) => item.id !== attempt.id);
          yield* store
            .writeVersioned(handoffsFile(id), { attempts: [attempt, ...filtered] })
            .pipe(Effect.orDie);
        }),
      );

    return SessionStore.of({
      workflowBaselinePath: (id, turn) =>
        SAFE_ID.test(id) && SAFE_ID.test(turn)
          ? path.join(store.root, sessionDir(id), 'workflow-baselines', turn)
          : undefined,
      createDraft,
      ensureWorker,
      append,
      setOptions,
      flush,
      replay,
      get,
      addAcpSession,
      startContext,
      setMemoryLost,
      list,
      listAll,
      relocate,
      updateMeta,
      remove,
      meta,
      saveHandoffAttempt,
      listHandoffAttempts,
    });
  }),
);

/**
 * The SessionStore over `<userData>/spence/`. Provide this one layer wherever main needs `SessionStore` (handlers,
 * Projects relocating Sessions) so they share one instance and its in-memory Sessions.
 */
export const layerSessionStoreLive = layerSessionStore.pipe(Layer.provide(layerStoreUserData));
