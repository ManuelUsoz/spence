import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BROWSER_MAX_WIDTH, BROWSER_MIN_WIDTH, PageId } from '../../src/shared/browser/browser.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { layerStore } from '../store/store';
import { BrowserStore, layerBrowserStore, type PersistedBrowserState } from './browser-store';

const withRoot = <A, E>(body: (root: string) => Effect.Effect<A, E>) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-browser-store-'))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ).pipe(Effect.flatMap(body), Effect.scoped);

const run = <A, E>(root: string, body: Effect.Effect<A, E, BrowserStore>) =>
  body.pipe(Effect.provide(layerBrowserStore.pipe(Layer.provide(layerStore(root)))), Effect.scoped);

const s1 = SessionId.make('session-1');
const p1 = PageId.make('page-1');
const p2 = PageId.make('page-2');

describe('BrowserStore', () => {
  it.effect('returns undefined without writing to disk when browser.json is absent', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const read = yield* run(
          root,
          BrowserStore.use((store) => store.read(s1)),
        );
        expect(read).toBeUndefined();
        const entries = yield* Effect.promise(() =>
          readdir(root).catch((): ReadonlyArray<string> => []),
        );
        expect(entries).toEqual([]);
      }),
    ),
  );

  it.effect(
    'writes versioned state at sessions/<sessionId>/browser.json and restores across restarts',
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const saved: PersistedBrowserState = {
            open: true,
            width: 620,
            activePageId: p2,
            pages: [
              { id: p1, url: 'http://localhost:3000', title: 'App' },
              { id: p2, url: 'https://example.com/docs', title: 'Docs' },
            ],
          };

          yield* run(
            root,
            BrowserStore.use((store) => store.write(s1, saved)),
          );

          const raw = yield* Effect.promise(() =>
            readFile(path.join(root, 'sessions', s1, 'browser.json'), 'utf8'),
          );
          expect(JSON.parse(raw)).toEqual({
            version: 1,
            ...saved,
          });

          const restored = yield* run(
            root,
            BrowserStore.use((store) => store.read(s1)),
          );
          expect(restored).toEqual(saved);

          yield* run(
            root,
            BrowserStore.use((store) => store.remove(s1)),
          );
          const afterRemove = yield* run(
            root,
            BrowserStore.use((store) => store.read(s1)),
          );
          expect(afterRemove).toBeUndefined();
        }),
      ),
  );

  it.effect('clamps out-of-range widths and heals an orphaned activePageId on read', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const dir = path.join(root, 'sessions', s1);
        yield* Effect.promise(() => mkdir(dir, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            path.join(dir, 'browser.json'),
            JSON.stringify({
              version: 1,
              open: true,
              width: 2400,
              activePageId: 'page-missing',
              pages: [{ id: p1, url: 'https://example.com', title: 'Example' }],
            }),
          ),
        );

        const restored = yield* run(
          root,
          BrowserStore.use((store) => store.read(s1)),
        );
        expect(restored).toEqual({
          open: true,
          width: BROWSER_MAX_WIDTH,
          activePageId: p1,
          pages: [{ id: p1, url: 'https://example.com', title: 'Example' }],
        });

        yield* run(
          root,
          BrowserStore.use((store) =>
            store.write(s1, {
              open: false,
              width: 50,
              activePageId: null,
              pages: [],
            }),
          ),
        );
        const clampedLow = yield* run(
          root,
          BrowserStore.use((store) => store.read(s1)),
        );
        expect(clampedLow?.width).toBe(BROWSER_MIN_WIDTH);
      }),
    ),
  );

  it.effect(
    'refuses to read or overwrite a newer-version browser.json and ignores unsafe IDs',
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const dir = path.join(root, 'sessions', s1);
          const file = path.join(dir, 'browser.json');
          const newerPayload = JSON.stringify({
            version: 99,
            open: true,
            width: 500,
            activePageId: null,
            pages: [],
          });
          yield* Effect.promise(() => mkdir(dir, { recursive: true }));
          yield* Effect.promise(() => writeFile(file, newerPayload));

          yield* run(
            root,
            Effect.gen(function* () {
              const store = yield* BrowserStore;
              expect(yield* store.read(s1)).toBeUndefined();
              yield* store.write(s1, {
                open: false,
                width: 480,
                activePageId: null,
                pages: [],
              });
            }),
          );

          expect(yield* Effect.promise(() => readFile(file, 'utf8'))).toBe(newerPayload);

          const unsafe = SessionId.make('../escape');
          expect(
            yield* run(
              root,
              BrowserStore.use((store) => store.read(unsafe)),
            ),
          ).toBeUndefined();
        }),
      ),
  );
});
