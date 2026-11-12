import { Clock, Context, Effect, Layer, Schema, Semaphore } from 'effect';
import path from 'node:path';
import { AcpSessionId } from '../acp/acpSession';
import { AgentId, Effort } from '../../src/shared/agents/agents.rpc';
import {
  SessionError,
  SessionId,
  type SessionSummary,
  type TranscriptEvent,
  type TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';
import { PermissionMode, ProjectId, Timestamp } from '../../src/shared/projects/projects.rpc';
import { layerStoreUserData, Store, type VersionedFile } from '../store/store';
import { inlineEvent, StoredEvent, storeEvent, type BlobBytes } from './transcript-file';

/** `sessions/<id>/session.json`: what Spence keeps about a Session besides its Transcript (spec 2.4). */
export const SessionMeta = Schema.Struct({
  id: SessionId,
  projectId: ProjectId,
  /** The folder the Session runs in; the Project folder in v1. */
  cwd: Schema.String,
  agentId: AgentId,
  userTitle: Schema.optionalKey(Schema.String),
  autoTitle: Schema.optionalKey(Schema.String),
  autoTitleIsPlaceholder: Schema.Boolean,
  createdAt: Timestamp,
  lastActivityAt: Timestamp,
  archivedAt: Schema.optionalKey(Timestamp),
  /** Every ACP session id the Session ever had, newest last. */
  acpSessionIds: Schema.Array(AcpSessionId),
  /** The last chosen options. */
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Effort),
  permissionMode: PermissionMode,
});
export type SessionMeta = typeof SessionMeta.Type;

export interface SessionStoreShape {
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
  /** Records the Session's newest ACP session id, last in `acpSessionIds`, unless it is already the last. */
  readonly addAcpSession: (
    id: SessionId,
    acpSessionId: AcpSessionId,
  ) => Effect.Effect<void, SessionError>;
  /** A Project's kept Sessions, most recent activity first. Drafts are not listed. */
  readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<SessionSummary>>;
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
  /** What is kept about a Session, drafts included. */
  readonly meta: (id: SessionId) => Effect.Effect<SessionMeta, SessionError>;
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

const metaFile = (id: SessionId): VersionedFile<SessionMeta | undefined> => ({
  file: path.join(sessionDir(id), 'session.json'),
  version: 1,
  migrations: [],
  schema: Schema.UndefinedOr(SessionMeta),
  initial: () => undefined,
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

const toSummary = (meta: SessionMeta): SessionSummary => ({
  id: meta.id,
  agentId: meta.agentId,
  title: {
    ...(meta.userTitle === undefined ? {} : { user: meta.userTitle }),
    ...(meta.autoTitle === undefined ? {} : { auto: meta.autoTitle }),
    autoIsPlaceholder: meta.autoTitleIsPlaceholder,
  },
  lastActivityAt: meta.lastActivityAt,
  ...(meta.archivedAt === undefined ? {} : { archivedAt: meta.archivedAt }),
});

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
          if (entry.meta.acpSessionIds.at(-1) === acpSessionId) return;
          entry.meta = {
            ...entry.meta,
            acpSessionIds: [...entry.meta.acpSessionIds, acpSessionId],
          };
          // A draft is written with its first event.
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

    const list = (projectId: ProjectId) =>
      lock(
        Effect.gen(function* () {
          const metas = yield* Effect.forEach(
            yield* allIds,
            (id): Effect.Effect<ReadonlyArray<SessionMeta>> => {
              const entry = entries.get(id);
              // A draft with no events is not kept yet.
              if (entry !== undefined) {
                return Effect.succeed(entry.lastSeq === 0 ? [] : [entry.meta]);
              }
              return readMeta(id, 'is not listed').pipe(
                Effect.map((meta) => (meta === undefined ? [] : [meta])),
              );
            },
          );
          return metas
            .flat()
            .filter((meta) => meta.projectId === projectId)
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
            .map(toSummary);
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

    const meta = (id: SessionId) => lock(loadOrDie(id).pipe(Effect.map((entry) => entry.meta)));

    return SessionStore.of({
      createDraft,
      append,
      setOptions,
      flush,
      replay,
      get,
      addAcpSession,
      list,
      relocate,
      updateMeta,
      meta,
    });
  }),
);

/**
 * The SessionStore over `<userData>/spence/`. Provide this one layer wherever main needs `SessionStore` (handlers,
 * Projects relocating Sessions) so they share one instance and its in-memory Sessions.
 */
export const layerSessionStoreLive = layerSessionStore.pipe(Layer.provide(layerStoreUserData));
