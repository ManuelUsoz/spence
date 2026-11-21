import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { clampBrowserWidth, PageId } from '../../src/shared/browser/browser.rpc';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { Store, type VersionedFile } from '../store/store';

export const PersistedBrowserPage = Schema.Struct({
  id: PageId,
  url: Schema.String,
  title: Schema.String,
}).annotate({ identifier: 'PersistedBrowserPage' });
export type PersistedBrowserPage = typeof PersistedBrowserPage.Type;

export const PersistedBrowserState = Schema.Struct({
  open: Schema.Boolean,
  width: Schema.Number,
  activePageId: Schema.NullOr(PageId),
  pages: Schema.Array(PersistedBrowserPage),
}).annotate({ identifier: 'PersistedBrowserState' });
export type PersistedBrowserState = typeof PersistedBrowserState.Type;

export interface BrowserStoreShape {
  readonly read: (sessionId: SessionId) => Effect.Effect<PersistedBrowserState | undefined>;
  readonly write: (sessionId: SessionId, state: PersistedBrowserState) => Effect.Effect<void>;
  readonly remove: (sessionId: SessionId) => Effect.Effect<void>;
}

/** Per-Session persisted Browser state (`sessions/<sessionId>/browser.json`) in Spence's Store. */
export class BrowserStore extends Context.Service<BrowserStore, BrowserStoreShape>()(
  'browser/BrowserStore',
) {}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const browserFilePath = (sessionId: SessionId): string =>
  path.join('sessions', sessionId, 'browser.json');

const browserFileSpec = (
  sessionId: SessionId,
): VersionedFile<PersistedBrowserState | undefined> => ({
  file: browserFilePath(sessionId),
  version: 1,
  migrations: [],
  schema: Schema.UndefinedOr(PersistedBrowserState),
  initial: () => undefined,
});

const normalizeState = (state: PersistedBrowserState): PersistedBrowserState => {
  const seen = new Set<PageId>();
  const pages: Array<PersistedBrowserPage> = [];
  for (const page of state.pages) {
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    pages.push({ id: page.id, url: page.url, title: page.title });
  }
  const activePageId =
    state.activePageId !== null && seen.has(state.activePageId)
      ? state.activePageId
      : (pages[0]?.id ?? null);
  return {
    open: state.open,
    width: clampBrowserWidth(state.width),
    activePageId,
    pages,
  };
};

export const layerBrowserStore = Layer.effect(
  BrowserStore,
  Effect.gen(function* () {
    const store = yield* Store;
    const lock = (yield* Semaphore.make(1)).withPermit;
    const protectedNewer = new Set<SessionId>();

    const read = Effect.fn('BrowserStore.read')(function* (sessionId: SessionId) {
      if (!SAFE_ID.test(sessionId)) return undefined;
      return yield* lock(
        store.readVersioned(browserFileSpec(sessionId)).pipe(
          Effect.map((loaded) => (loaded === undefined ? undefined : normalizeState(loaded))),
          Effect.catchTag('StoreError', (error) =>
            Effect.sync(() => {
              if (error.reason === 'NewerVersion') {
                protectedNewer.add(sessionId);
              }
            }).pipe(
              Effect.andThen(Effect.logWarning(`browser.json (${sessionId}): ${error.detail}`)),
              Effect.as(undefined),
            ),
          ),
        ),
      );
    });

    const write = Effect.fn('BrowserStore.write')(function* (
      sessionId: SessionId,
      state: PersistedBrowserState,
    ) {
      if (!SAFE_ID.test(sessionId)) return;
      yield* lock(
        Effect.gen(function* () {
          if (protectedNewer.has(sessionId)) return;
          yield* store.writeVersioned(browserFileSpec(sessionId), normalizeState(state));
        }),
      );
    });

    const remove = Effect.fn('BrowserStore.remove')(function* (sessionId: SessionId) {
      if (!SAFE_ID.test(sessionId)) return;
      yield* lock(
        Effect.gen(function* () {
          protectedNewer.delete(sessionId);
          yield* Effect.promise(() =>
            rm(path.join(store.root, browserFilePath(sessionId)), { force: true }).catch(
              () => undefined,
            ),
          );
        }),
      );
    });

    return BrowserStore.of({ read, write, remove });
  }),
);
