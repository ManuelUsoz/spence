import { Context, Effect, Layer } from 'effect';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../store/store';
import { folderKey } from './folder-key';
import { Folders } from './folders';

/** The `cwd` of stored Sessions, as far as Projects need it. */
export class SessionCwds extends Context.Service<
  SessionCwds,
  {
    /** Rewrites the `cwd` of every Session whose `cwd` is `from` to `to`. Other fields are kept as they are. */
    readonly relocate: (from: string, to: string) => Effect.Effect<void>;
  }
>()('projects/SessionCwds') {}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';

/**
 * Walks `sessions/<id>/session.json` under the store and edits the raw JSON, so it works whatever version the
 * Session files are at. A Session file that cannot be read or parsed is left alone.
 */
export const layerSessionCwds = Layer.effect(
  SessionCwds,
  Effect.gen(function* () {
    const store = yield* Store;
    const { platform } = yield* Folders;
    const dir = path.join(store.root, 'sessions');

    const relocateOne = (file: string, from: string, to: string) =>
      Effect.tryPromise({
        try: async () => {
          const json: unknown = JSON.parse(await readFile(file, 'utf8'));
          if (typeof json !== 'object' || json === null) return;
          const cwd = (json as { cwd?: unknown }).cwd;
          if (typeof cwd !== 'string' || folderKey(cwd, platform) !== folderKey(from, platform)) {
            return;
          }
          const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
          await writeFile(temp, `${JSON.stringify({ ...json, cwd: to }, null, 2)}\n`);
          await rename(temp, file);
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`could not relocate the cwd in ${file}: ${String(error)}`),
        ),
      );

    const relocate = Effect.fn('SessionCwds.relocate')(function* (from: string, to: string) {
      const ids = yield* Effect.tryPromise({
        try: () => readdir(dir),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          isMissing(error) ? Effect.succeed<ReadonlyArray<string>>([]) : Effect.die(error),
        ),
      );
      yield* Effect.forEach(
        ids,
        (id) => relocateOne(path.join(dir, id, 'session.json'), from, to),
        {
          discard: true,
        },
      );
    });

    return { relocate };
  }),
);
