import { Clock, Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import {
  Effort,
  PermissionMode,
  SessionError,
  SessionId,
  Timestamp,
  type SessionSummary,
  type TranscriptEvent,
  type TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { Store, type VersionedFile } from '../store/store';
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
  acpSessionIds: Schema.Array(Schema.String),
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
  /** Writes the Session's queued events now, e.g. at Turn end. */
  readonly flush: (id: SessionId) => Effect.Effect<void, SessionError>;
  /** The Session's events after `afterSeq` (all when absent), written or still queued, with blobs inlined. */
  readonly replay: (
    id: SessionId,
    afterSeq?: number,
  ) => Effect.Effect<ReadonlyArray<TranscriptEvent>, SessionError>;
  /** A Project's kept Sessions, most recent activity first. Drafts are not listed. */
  readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<SessionSummary>>;
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

const sessionDir = (id: string) => path.join(SESSIONS, id);
const transcriptFile = (id: string) => path.join(sessionDir(id), 'transcript.jsonl');
const blobsDir = (id: string) => path.join(sessionDir(id), 'blobs');

const metaFile = (id: string): VersionedFile<SessionMeta | undefined> => ({
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

const notFound = (id: string) =>
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
    const entries = new Map<string, Entry>();

    const blobs = (id: string): BlobBytes => ({
      put: (bytes) => store.putBlob(blobsDir(id), bytes),
      get: (hash) => store.getBlob(blobsDir(id), hash).pipe(Effect.orDie),
    });

    const readStored = (id: string) =>
      store.readLines(transcriptFile(id), StoredEvent).pipe(Effect.orDie);

    /** The Session's entry, loaded from disk on first use. */
    const load = Effect.fnUntraced(function* (id: string) {
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
    const loadOrDie = (id: string) =>
      load(id).pipe(Effect.catchTag('StoreError', (error) => Effect.die(error)));

    /** Writes an entry's queued events; uninterruptible, so a batch is never written twice. */
    const write = (id: string, entry: Entry) =>
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

    const list = (projectId: ProjectId) =>
      lock(
        Effect.gen(function* () {
          const onDisk = yield* Effect.tryPromise({
            try: () => readdir(path.join(store.root, SESSIONS)),
            catch: (error) => error,
          }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
          const metas = yield* Effect.forEach(
            new Set([...onDisk, ...entries.keys()]),
            (id): Effect.Effect<ReadonlyArray<SessionMeta>> => {
              const entry = entries.get(id);
              // A draft with no events is not kept yet.
              if (entry !== undefined) {
                return Effect.succeed(entry.lastSeq === 0 ? [] : [entry.meta]);
              }
              if (!SAFE_ID.test(id)) return Effect.succeed([]);
              return store.readVersioned(metaFile(id)).pipe(
                Effect.map((meta) => (meta === undefined ? [] : [meta])),
                Effect.catchTag('StoreError', (error) =>
                  Effect.logWarning(`Session ${id} is not listed: ${error.detail}`).pipe(
                    Effect.as([]),
                  ),
                ),
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

    return SessionStore.of({ createDraft, append, flush, replay, list });
  }),
);
