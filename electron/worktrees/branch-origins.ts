import { Clock, Context, Effect, Layer, Schema, Semaphore } from 'effect';
import path from 'node:path';
import { Timestamp } from '../../src/shared/projects/projects.rpc';
import { folderKey } from '../projects/folder-key';
import { realPathOrNull } from '../source-control/git-exec';
import { Store, type VersionedFile } from '../store/store';

const BranchOriginEntry = Schema.Struct({
  createdFromBranch: Schema.String,
  recordedAt: Timestamp,
});
type BranchOriginEntry = typeof BranchOriginEntry.Type;

const BranchOriginsDoc = Schema.Struct({
  entries: Schema.Record(Schema.String, BranchOriginEntry),
});
type BranchOriginsDoc = typeof BranchOriginsDoc.Type;

const branchOriginsFile: VersionedFile<BranchOriginsDoc> = {
  file: 'worktrees/branch-origins.json',
  version: 1,
  migrations: [],
  schema: BranchOriginsDoc,
  initial: () => ({ entries: {} }),
};

export const branchOriginKey = async (worktreePath: string, branch: string): Promise<string> => {
  const real = (await realPathOrNull(worktreePath)) ?? worktreePath;
  return `${folderKey(path.resolve(real), process.platform)}\0${branch}`;
};

export interface BranchOriginsShape {
  readonly record: (input: {
    readonly worktreePath: string;
    readonly branch: string;
    readonly createdFromBranch: string;
  }) => Effect.Effect<void>;
  readonly get: (input: {
    readonly worktreePath: string;
    readonly branch: string;
  }) => Effect.Effect<string | null>;
}

/** Persists the origin branch (`createdFromBranch`) for Worktrees created by Spence. */
export class BranchOrigins extends Context.Service<BranchOrigins, BranchOriginsShape>()(
  'worktrees/BranchOrigins',
) {}

export const layerBranchOrigins = Layer.effect(
  BranchOrigins,
  Effect.gen(function* () {
    const store = yield* Store;
    const lock = yield* Semaphore.make(1);

    const readDoc = store
      .readVersioned(branchOriginsFile)
      .pipe(Effect.catchTag('StoreError', () => Effect.succeed<BranchOriginsDoc>({ entries: {} })));

    const record: BranchOriginsShape['record'] = Effect.fnUntraced(function* (input) {
      if (input.createdFromBranch.trim().length === 0 || input.branch.trim().length === 0) return;
      const key = yield* Effect.promise(() => branchOriginKey(input.worktreePath, input.branch));
      const now = Timestamp.make(yield* Clock.currentTimeMillis);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const doc = yield* readDoc;
          yield* store.writeVersioned(branchOriginsFile, {
            entries: {
              ...doc.entries,
              [key]: { createdFromBranch: input.createdFromBranch, recordedAt: now },
            },
          });
        }),
      );
    });

    const get: BranchOriginsShape['get'] = Effect.fnUntraced(function* (input) {
      if (input.branch.trim().length === 0) return null;
      const key = yield* Effect.promise(() => branchOriginKey(input.worktreePath, input.branch));
      const doc = yield* lock.withPermits(1)(readDoc);
      return doc.entries[key]?.createdFromBranch ?? null;
    });

    return { record, get };
  }),
);
