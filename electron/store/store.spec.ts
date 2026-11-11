import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { layerStore, Store, type LenientFile, type VersionedFile } from './store';

/** A fresh store root per test, removed afterwards. */
const withRoot = <A, E>(body: (root: string) => Effect.Effect<A, E, Store>) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-store-'))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ).pipe(
    Effect.flatMap((root) => body(root).pipe(Effect.provide(layerStore(root)))),
    Effect.scoped,
  );

const put = (root: string, file: string, content: string) =>
  Effect.promise(async () => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  });
const read = (root: string, file: string) =>
  Effect.promise(() => readFile(path.join(root, file), 'utf8'));
const mtime = (root: string, file: string) =>
  Effect.promise(() => stat(path.join(root, file)).then((s) => s.mtimeMs));

// v1: { names: string[] }  v2: { items: string[] }  v3: { items: { name }[] }
const Projects: VersionedFile<{ readonly items: ReadonlyArray<{ readonly name: string }> }> = {
  file: 'projects.json',
  version: 3,
  migrations: [
    (v1) => ({ items: (v1 as { names: Array<string> }).names }),
    (v2) => ({ items: (v2 as { items: Array<string> }).items.map((name) => ({ name })) }),
  ],
  schema: Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  initial: () => ({ items: [] }),
};

describe('Store blobs', () => {
  // sha256("hello")
  const HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  const hello = new TextEncoder().encode('hello');

  it.effect('stores bytes under their sha256, idempotently, and reads them back', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const store = yield* Store;
        expect(yield* store.putBlob('s/blobs', hello)).toBe(HELLO);
        const writtenAt = yield* mtime(root, `s/blobs/${HELLO}`);

        expect(yield* store.putBlob('s/blobs', hello)).toBe(HELLO);
        expect(yield* mtime(root, `s/blobs/${HELLO}`)).toBe(writtenAt);
        expect(new TextDecoder().decode(yield* store.getBlob('s/blobs', HELLO))).toBe('hello');
      }),
    ),
  );

  it.effect('fails NotFound for an unknown or malformed hash', () =>
    withRoot(() =>
      Effect.gen(function* () {
        const store = yield* Store;
        expect((yield* Effect.flip(store.getBlob('s/blobs', HELLO))).reason).toBe('NotFound');
        expect((yield* Effect.flip(store.getBlob('s/blobs', '../../secret'))).reason).toBe(
          'NotFound',
        );
      }),
    ),
  );
});

describe('Store JSONL files', () => {
  const Event = Schema.Struct({ seq: Schema.Number, text: Schema.String });

  it.effect('appends whole lines and reads them back decoded', () =>
    withRoot(() =>
      Effect.gen(function* () {
        const store = yield* Store;
        expect(yield* store.readLines('s/transcript.jsonl', Event)).toEqual([]);

        yield* store.appendLines('s/transcript.jsonl', Event, [{ seq: 1, text: 'a' }]);
        yield* store.appendLines('s/transcript.jsonl', Event, [
          { seq: 2, text: 'b' },
          { seq: 3, text: 'c' },
        ]);
        expect(yield* store.readLines('s/transcript.jsonl', Event)).toEqual([
          { seq: 1, text: 'a' },
          { seq: 2, text: 'b' },
          { seq: 3, text: 'c' },
        ]);
      }),
    ),
  );

  it.effect('ignores a torn last line and appends cleanly after it', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const store = yield* Store;
        yield* put(root, 't.jsonl', '{"seq":1,"text":"a"}\n{"seq":2,"te');

        expect(yield* store.readLines('t.jsonl', Event)).toEqual([{ seq: 1, text: 'a' }]);

        yield* store.appendLines('t.jsonl', Event, [{ seq: 2, text: 'b' }]);
        expect(yield* store.readLines('t.jsonl', Event)).toEqual([
          { seq: 1, text: 'a' },
          { seq: 2, text: 'b' },
        ]);
      }),
    ),
  );
});

describe('Store lenient files', () => {
  const Settings: LenientFile<{ readonly theme: 'light' | 'dark'; readonly fontSize: number }> = {
    file: 'settings.json',
    version: 1,
    migrations: [],
    fields: { theme: Schema.Literals(['light', 'dark']), fontSize: Schema.Number },
    defaults: { theme: 'dark', fontSize: 13 },
  };

  it.effect('defaults invalid keys, keeps valid ones and drops unknown ones', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const store = yield* Store;
        yield* put(
          root,
          'settings.json',
          JSON.stringify({ version: 1, theme: 'purple', fontSize: 16, legacy: true }),
        );

        expect(yield* store.readLenient(Settings)).toStrictEqual({ theme: 'dark', fontSize: 16 });
      }),
    ),
  );

  it.effect('writes only the keys that differ from the defaults', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.writeLenient(Settings, { theme: 'light', fontSize: 13 });
        expect(JSON.parse(yield* read(root, 'settings.json'))).toStrictEqual({
          version: 1,
          theme: 'light',
        });
      }),
    ),
  );

  it.effect('compares arrays and objects with their defaults by value, not identity', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const Layout: LenientFile<{
          readonly pinned: ReadonlyArray<string>;
          readonly window: { readonly width: number };
        }> = {
          file: 'layout.json',
          version: 1,
          migrations: [],
          fields: {
            pinned: Schema.Array(Schema.String),
            window: Schema.Struct({ width: Schema.Number }),
          },
          defaults: { pinned: [], window: { width: 800 } },
        };

        yield* store.writeLenient(Layout, { pinned: [], window: { width: 800 } });
        expect(JSON.parse(yield* read(root, 'layout.json'))).toStrictEqual({ version: 1 });

        yield* store.writeLenient(Layout, { pinned: ['a'], window: { width: 800 } });
        expect(JSON.parse(yield* read(root, 'layout.json'))).toStrictEqual({
          version: 1,
          pinned: ['a'],
        });
      }),
    ),
  );

  it.effect('never fails: unreadable or newer files give the defaults and stay untouched', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const store = yield* Store;
        expect(yield* store.readLenient(Settings)).toStrictEqual({ theme: 'dark', fontSize: 13 });

        yield* put(root, 'settings.json', '{ not json');
        expect(yield* store.readLenient(Settings)).toStrictEqual({ theme: 'dark', fontSize: 13 });

        const newer = JSON.stringify({ version: 2, theme: 'light' });
        yield* put(root, 'settings.json', newer);
        expect(yield* store.readLenient(Settings)).toStrictEqual({ theme: 'dark', fontSize: 13 });
        expect(yield* read(root, 'settings.json')).toBe(newer);
      }),
    ),
  );

  it.effect('refuses to overwrite a file from a newer version', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const newer = JSON.stringify({ version: 2, theme: 'light' });
        yield* put(root, 'settings.json', newer);

        const error = yield* Effect.flip(
          store.writeLenient(Settings, { theme: 'dark', fontSize: 20 }),
        );
        expect(error.reason).toBe('NewerVersion');
        expect(yield* read(root, 'settings.json')).toBe(newer);
      }),
    ),
  );
});

describe('Store versioned files', () => {
  it.effect('runs the migration chain on first read and rewrites the file once', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const store = yield* Store;
        yield* put(root, 'projects.json', JSON.stringify({ version: 1, names: ['a', 'b'] }));

        expect(yield* store.readVersioned(Projects)).toEqual({
          items: [{ name: 'a' }, { name: 'b' }],
        });
        expect(JSON.parse(yield* read(root, 'projects.json'))).toEqual({
          version: 3,
          items: [{ name: 'a' }, { name: 'b' }],
        });

        const rewrittenAt = yield* mtime(root, 'projects.json');
        expect(yield* store.readVersioned(Projects)).toEqual({
          items: [{ name: 'a' }, { name: 'b' }],
        });
        expect(yield* mtime(root, 'projects.json')).toBe(rewrittenAt);
      }),
    ),
  );

  it.effect('refuses a file from a newer version and leaves it untouched', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const newer = JSON.stringify({ version: 4, items: [], extra: true });
        yield* put(root, 'projects.json', newer);

        const error = yield* Effect.flip(store.readVersioned(Projects));
        expect(error.reason).toBe('NewerVersion');
        expect(yield* read(root, 'projects.json')).toBe(newer);
      }),
    ),
  );

  it.effect('gives the default for a missing file and reads back what it wrote', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const store = yield* Store;
        expect(yield* store.readVersioned(Projects)).toEqual({ items: [] });

        yield* store.writeVersioned(Projects, { items: [{ name: 'x' }] });
        expect(JSON.parse(yield* read(root, 'projects.json'))).toEqual({
          version: 3,
          items: [{ name: 'x' }],
        });
        expect(yield* store.readVersioned(Projects)).toEqual({ items: [{ name: 'x' }] });
      }),
    ),
  );
});
