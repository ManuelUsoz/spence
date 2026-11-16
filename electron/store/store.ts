import { app } from 'electron';
import { Context, Effect, Equal, Layer, Schema } from 'effect';
import { createHash } from 'node:crypto';
import {
  access,
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tryFs } from './fs';

/** A failure a caller of the store can act on. I/O failures are defects. */
export class StoreError extends Schema.TaggedError<StoreError>()('StoreError', {
  reason: Schema.Literals(['NewerVersion', 'Invalid', 'NotFound']),
  detail: Schema.String,
}) {}

/** Turns a file body of version n into version n + 1. Forward only. */
export type Migration = (body: unknown) => unknown;

/** How a file is versioned: `migrations[i]` turns version i + 1 into i + 2, so there are `version - 1` of them. */
export interface Versioning {
  /** Path relative to the store root. */
  readonly file: string;
  readonly version: number;
  readonly migrations: ReadonlyArray<Migration>;
}

/**
 * A JSON file shaped `{ version, ...body }`, decoded strictly: a body that does not match the schema is an error.
 */
export interface VersionedFile<A> extends Versioning {
  readonly schema: Schema.Codec<A, unknown>;
  /** The value of a file that does not exist yet. */
  readonly initial: () => A;
}

/** The decoded value of a lenient file: one value per key. */
type ValuesByKey = Readonly<Record<string, unknown>>;

/**
 * A settings-style file `{ version, ...keys }`, decoded key by key: an invalid key falls back to its default with a
 * log line, unknown keys are dropped, and reading never fails. Written sparse: only keys that differ from the defaults.
 */
export interface LenientFile<A extends ValuesByKey> extends Versioning {
  readonly fields: { readonly [K in keyof A]: Schema.Codec<A[K], unknown> };
  readonly defaults: A;
  readonly recover?: { readonly [K in keyof A]?: (input: unknown) => A[K] };
}

const keysOf = <A extends ValuesByKey>(fields: { readonly [K in keyof A]: unknown }) =>
  Object.keys(fields) as ReadonlyArray<keyof A & string>;

export interface StoreShape {
  readonly root: string;
  /** Reads a versioned file, migrating (and rewriting it once) when it is older than the code. */
  readonly readVersioned: <A>(spec: VersionedFile<A>) => Effect.Effect<A, StoreError>;
  /** Writes a versioned file atomically at the spec's current version. */
  readonly writeVersioned: <A>(spec: VersionedFile<A>, value: A) => Effect.Effect<void>;
  /** Reads a lenient file; a missing, unreadable or newer file gives the defaults (and is left untouched). */
  readonly readLenient: <A extends ValuesByKey>(spec: LenientFile<A>) => Effect.Effect<A>;
  /**
   * Writes a lenient file atomically, keeping only the keys that differ from the defaults. A file from a newer version
   * is refused (`NewerVersion`) and left untouched.
   */
  readonly writeLenient: <A extends ValuesByKey>(
    spec: LenientFile<A>,
    value: A,
  ) => Effect.Effect<void, StoreError>;
  /** Appends whole lines to a JSONL file, first cutting off a torn last line left by a crash. */
  readonly appendLines: <A, I>(
    file: string,
    schema: Schema.Codec<A, I>,
    items: ReadonlyArray<A>,
  ) => Effect.Effect<void>;
  /** Stores bytes in `dir` under their sha256 (hex) and returns it. Storing the same bytes again is a no-op. */
  readonly putBlob: (dir: string, bytes: Uint8Array) => Effect.Effect<string>;
  /** Reads the bytes stored in `dir` under a sha256. */
  readonly getBlob: (dir: string, sha256: string) => Effect.Effect<Uint8Array, StoreError>;
  /** The names in a folder under the root; none when the folder does not exist. */
  readonly listDir: (dir: string) => Effect.Effect<ReadonlyArray<string>>;
  /** Removes a folder under the root and everything inside it; a missing folder is a no-op. */
  readonly removeDir: (dir: string) => Effect.Effect<void>;
  /** Reads every line of a JSONL file; a torn last line is ignored, a missing file is empty. */
  readonly readLines: <A, I>(
    file: string,
    schema: Schema.Codec<A, I>,
  ) => Effect.Effect<ReadonlyArray<A>, StoreError>;
}

/** Spence's own files under `<userData>/spence/`. Main is the only writer. */
export class Store extends Context.Service<Store, StoreShape>()('store/Store') {}

const SHA256 = /^[0-9a-f]{64}$/;

/** Reads a file as text; `undefined` when it does not exist. Other I/O failures are defects. */
const readText = (file: string) =>
  tryFs(file, () => readFile(file, 'utf8')).pipe(
    Effect.catchTag('FsError', () => Effect.succeed(undefined)),
  );

/** Atomic write: a temp file next to the target, then a rename over it. */
const writeAtomic = Effect.fnUntraced(function* (file: string, data: string | Uint8Array) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  yield* Effect.promise(() => mkdir(path.dirname(file), { recursive: true }));
  yield* Effect.promise(() => writeFile(temp, data));
  yield* Effect.promise(() => rename(temp, file));
});

/** Cuts a file back to its last newline, dropping a torn last line. A missing file stays missing. */
const cutTornTail = Effect.fnUntraced(
  function* (file: string) {
    const handle = yield* Effect.acquireRelease(
      tryFs(file, () => open(file, 'r+')),
      (opened) => Effect.promise(() => opened.close()),
    );
    const { size } = yield* Effect.promise(() => handle.stat());
    if (size === 0) return;
    const last = Buffer.alloc(1);
    yield* Effect.promise(() => handle.read(last, 0, 1, size - 1));
    if (last[0] === 0x0a) return;
    const content = yield* Effect.promise(() => handle.readFile());
    yield* Effect.promise(() => handle.truncate(content.lastIndexOf(0x0a) + 1));
  },
  Effect.scoped,
  Effect.catchTag('FsError', () => Effect.void),
);

const parseJson = (file: string, text: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => new StoreError({ reason: 'Invalid', detail: `${file} is not valid JSON` }),
  });

const invalid = (file: string) => () =>
  new StoreError({ reason: 'Invalid', detail: `${file} does not match its schema` });

export const makeStore = (root: string): StoreShape => {
  const resolve = (file: string) => path.join(root, file);

  const writeJson = (file: string, json: object) =>
    writeAtomic(resolve(file), `${JSON.stringify(json, null, 2)}\n`);

  const writeVersioned = <A>(spec: VersionedFile<A>, value: A) =>
    Schema.encodeEffect(spec.schema)(value).pipe(
      Effect.orDie,
      Effect.flatMap((body) =>
        writeJson(spec.file, { version: spec.version, ...(body as object) }),
      ),
    );

  /** Loads a file's body migrated to the spec's version; `undefined` when the file does not exist. */
  const load = Effect.fnUntraced(function* (spec: Versioning) {
    const text = yield* readText(resolve(spec.file));
    if (text === undefined) return undefined;

    const json = yield* parseJson(spec.file, text);
    const found =
      typeof json === 'object' && json !== null
        ? (json as { version?: unknown }).version
        : undefined;
    if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
      return yield* new StoreError({
        reason: 'Invalid',
        detail: `${spec.file} has no valid version`,
      });
    }
    if (found > spec.version) {
      return yield* new StoreError({
        reason: 'NewerVersion',
        detail: `${spec.file} is version ${found}; this Spence reads up to ${spec.version}`,
      });
    }

    const { version: _version, ...body } = json as { version: number };
    const migrated = spec.migrations
      .slice(found - 1, spec.version - 1)
      .reduce<unknown>((acc, m) => m(acc), body);
    return { body: migrated, stale: found < spec.version };
  });

  const readVersioned = Effect.fnUntraced(function* <A>(spec: VersionedFile<A>) {
    const loaded = yield* load(spec);
    if (loaded === undefined) return spec.initial();
    const value = yield* Schema.decodeUnknownEffect(spec.schema)(loaded.body).pipe(
      Effect.mapError(invalid(spec.file)),
    );
    if (loaded.stale) yield* writeVersioned(spec, value);
    return value;
  });

  /** Writes the keys that differ from the defaults, whatever is on disk. */
  const writeSparse = <A extends ValuesByKey>(spec: LenientFile<A>, value: A) =>
    Effect.forEach(keysOf(spec.fields), (key) =>
      Equal.equals(value[key], spec.defaults[key])
        ? Effect.succeed([])
        : Schema.encodeEffect(spec.fields[key])(value[key]).pipe(
            Effect.orDie,
            Effect.map((encoded) => [[key, encoded] as const]),
          ),
    ).pipe(
      Effect.flatMap((entries) =>
        writeJson(spec.file, { version: spec.version, ...Object.fromEntries(entries.flat()) }),
      ),
    );

  /** A file from a newer Spence is refused, never overwritten; an unreadable one may be replaced. */
  const writeLenient = <A extends ValuesByKey>(spec: LenientFile<A>, value: A) =>
    load(spec).pipe(
      Effect.catch((error) => (error.reason === 'NewerVersion' ? Effect.fail(error) : Effect.void)),
      Effect.andThen(writeSparse(spec, value)),
    );

  const readLenient = <A extends ValuesByKey>(spec: LenientFile<A>): Effect.Effect<A> =>
    load(spec).pipe(
      Effect.flatMap((loaded) => {
        if (loaded === undefined) return Effect.succeed(spec.defaults);
        const body =
          typeof loaded.body === 'object' && loaded.body !== null
            ? (loaded.body as Record<string, unknown>)
            : {};
        return Effect.forEach(keysOf(spec.fields), (key) =>
          body[key] === undefined
            ? Effect.succeed([key, spec.defaults[key]] as const)
            : spec.recover?.[key] !== undefined
              ? Effect.succeed([key, spec.recover[key](body[key])] as const)
              : Schema.decodeUnknownEffect(spec.fields[key])(body[key]).pipe(
                  Effect.map((decoded) => [key, decoded] as const),
                  Effect.catch(() =>
                    Effect.logWarning(
                      `${spec.file}: invalid "${String(key)}", using the default`,
                    ).pipe(Effect.as([key, spec.defaults[key]] as const)),
                  ),
                ),
        ).pipe(
          Effect.map((entries) => Object.fromEntries(entries) as A),
          Effect.tap((value) => (loaded.stale ? writeSparse(spec, value) : Effect.void)),
        );
      }),
      Effect.catch((error) =>
        Effect.logWarning(`${spec.file}: ${error.detail}, using the defaults`).pipe(
          Effect.as(spec.defaults),
        ),
      ),
    );

  const appendLines = Effect.fnUntraced(function* <A, I>(
    file: string,
    schema: Schema.Codec<A, I>,
    items: ReadonlyArray<A>,
  ) {
    const encoded = yield* Effect.forEach(items, (item) => Schema.encodeEffect(schema)(item)).pipe(
      Effect.orDie,
    );
    const text = encoded.map((line) => `${JSON.stringify(line)}\n`).join('');
    const target = resolve(file);
    yield* cutTornTail(target);
    yield* Effect.promise(() => mkdir(path.dirname(target), { recursive: true }));
    yield* Effect.promise(() => appendFile(target, text));
  });

  const readLines = Effect.fnUntraced(function* <A, I>(file: string, schema: Schema.Codec<A, I>) {
    const text = (yield* readText(resolve(file))) ?? '';
    // Everything after the last newline is a torn line from a crash mid-write.
    const lines = text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .filter((line) => line !== '');
    return yield* Effect.forEach(lines, (line, index) =>
      parseJson(file, line).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError(
          () =>
            new StoreError({ reason: 'Invalid', detail: `${file} line ${index + 1} is invalid` }),
        ),
      ),
    );
  });

  const putBlob = Effect.fnUntraced(function* (dir: string, bytes: Uint8Array) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const target = resolve(path.join(dir, hash));
    const exists = yield* tryFs(target, () => access(target)).pipe(
      Effect.as(true),
      Effect.catchTag('FsError', () => Effect.succeed(false)),
    );
    if (!exists) yield* writeAtomic(target, bytes);
    return hash;
  });

  const getBlob = (dir: string, hash: string) => {
    const notFound = new StoreError({ reason: 'NotFound', detail: `no blob ${hash} in ${dir}` });
    if (!SHA256.test(hash)) return Effect.fail(notFound);
    const file = resolve(path.join(dir, hash));
    return tryFs(file, () => readFile(file)).pipe(
      Effect.map((buffer): Uint8Array => new Uint8Array(buffer)),
      Effect.catchTag('FsError', () => Effect.fail(notFound)),
    );
  };

  const listDir = (dir: string) => {
    const folder = resolve(dir);
    return tryFs(folder, () => readdir(folder)).pipe(
      Effect.catchTag('FsError', () => Effect.succeed<ReadonlyArray<string>>([])),
    );
  };

  const removeDir = (dir: string) => {
    const folder = resolve(dir);
    return tryFs(folder, () => rm(folder, { recursive: true, force: true })).pipe(Effect.orDie);
  };

  return {
    root,
    listDir,
    removeDir,
    putBlob,
    getBlob,
    readVersioned,
    writeVersioned,
    readLenient,
    writeLenient,
    appendLines,
    readLines,
  };
};

/** The store rooted at `root`. Production passes `<userData>/spence`; tests pass a temp directory. */
export const layerStore = (root: string) => Layer.succeed(Store, makeStore(root));

/** The store at `<userData>/spence/`. The path is read when the layer is built, after the e2e `userData` override. */
export const layerStoreUserData = Layer.suspend(() =>
  layerStore(path.join(app.getPath('userData'), 'spence')),
);
