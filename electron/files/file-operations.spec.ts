import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { afterEach, describe, expect } from 'vitest';
import { FileOperationsError } from '../../src/shared/files/file-operations.rpc';
import { OperationId } from '../../src/shared/source-control/source-control.rpc';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';
import { FolderPicker, layerFolders } from '../projects/folders';
import { layerProjects, Projects } from '../projects/projects';
import { layerSessionStore } from '../sessions/session-store';
import { layerStore } from '../store/store';
import { layerOperations } from '../source-control/operations';
import { layerReservationCoordinator } from '../source-control/reservation-coordinator';
import { layerReviewRegistry } from '../source-control/review-registry';
import { layerGitWorkerDirect } from '../worktrees/git-client';
import { layerWorktrees } from '../worktrees/worktrees';
import { FileOperations, layerFileOperations } from './file-operations';
import { Trash } from './trash';

const createdDirs: string[] = [];

const makeTempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
};

const runGit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const initGitRepo = async (dir: string): Promise<void> => {
  runGit(dir, 'init');
  runGit(dir, 'config', 'user.email', 'test@example.com');
  runGit(dir, 'config', 'user.name', 'Test User');
  await writeFile(path.join(dir, 'README.md'), '# Repo\n');
  runGit(dir, 'add', 'README.md');
  runGit(dir, 'commit', '-m', 'init');
};

const makeTestLayer = (
  storeDir: string,
  pickedFolders: string[],
  trashLayer: Layer.Layer<Trash>,
) => {
  const remaining = [...pickedFolders];
  const pathLayer = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));
  const storeLayer = layerStore(storeDir);
  const gitWorkerLayer = layerGitWorkerDirect.pipe(Layer.provide(pathLayer));
  const worktreesLayer = layerWorktrees.pipe(
    Layer.provide(Layer.mergeAll(gitWorkerLayer, storeLayer, pathLayer)),
  );
  const projectsLayer = layerProjects.pipe(
    Layer.provide(layerSessionStore),
    Layer.provide(
      Layer.mergeAll(
        storeLayer,
        layerFolders,
        worktreesLayer,
        Layer.succeed(FolderPicker, {
          pick: Effect.sync(() => {
            const next = remaining.shift();
            return next === undefined ? Option.none() : Option.some(next);
          }),
        }),
      ),
    ),
  );
  const operationsLayer = layerOperations.pipe(
    Layer.provide(Layer.mergeAll(layerReservationCoordinator, storeLayer)),
    Layer.orDie,
  );
  const fileOperationsLayer = layerFileOperations.pipe(
    Layer.provide(
      Layer.mergeAll(
        projectsLayer,
        worktreesLayer,
        pathLayer,
        layerReviewRegistry,
        layerReservationCoordinator,
        operationsLayer,
        trashLayer,
      ),
    ),
  );
  return Layer.mergeAll(fileOperationsLayer, projectsLayer, operationsLayer);
};

afterEach(async () => {
  while (createdDirs.length > 0) {
    const next = createdDirs.pop();
    if (next) {
      await rm(next, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

describe('FileOperations reviewed create/rename/delete', () => {
  it.live(
    'creates a file and a folder durably inside a Project',
    () =>
      Effect.gen(function* () {
        const storeDir = yield* Effect.promise(() => makeTempDir('spence-fop-store-'));
        const repoDir = yield* Effect.promise(() => makeTempDir('spence-fop-proj-'));
        yield* Effect.promise(() => initGitRepo(repoDir));

        const layer = makeTestLayer(
          storeDir,
          [repoDir],
          Layer.succeed(Trash, { moveToTrash: () => Effect.void }),
        );

        yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const ops = yield* FileOperations;
          const proj = yield* projects.add;
          expect(proj).not.toBeNull();
          if (!proj) return;
          const target = { projectId: proj.id };

          const fileReview = yield* ops.reviewCreate({
            target,
            dirPath: '',
            name: 'new-file.ts',
            kind: 'file',
          });
          expect(fileReview.blockers).toHaveLength(0);
          expect(fileReview.targets[0]).toMatchObject({
            path: 'new-file.ts',
            exists: false,
            willBeTrashed: false,
          });

          const fileResult = yield* ops.execute({
            reviewId: fileReview.reviewId,
            operationId: OperationId.make('op-create-file'),
          });
          expect(fileResult.outcome).toBe('Succeeded');
          const fileStat = yield* Effect.promise(() =>
            lstat(path.join(repoDir, 'new-file.ts')).catch(() => undefined),
          );
          expect(fileStat?.isFile()).toBe(true);

          const folderReview = yield* ops.reviewCreate({
            target,
            dirPath: '',
            name: 'new-folder',
            kind: 'folder',
          });
          yield* ops.execute({
            reviewId: folderReview.reviewId,
            operationId: OperationId.make('op-create-folder'),
          });
          const folderStat = yield* Effect.promise(() =>
            lstat(path.join(repoDir, 'new-folder')).catch(() => undefined),
          );
          expect(folderStat?.isDirectory()).toBe(true);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    'renames a file and trashes an explicitly reviewed existing destination',
    () =>
      Effect.gen(function* () {
        const storeDir = yield* Effect.promise(() => makeTempDir('spence-fop-rename-store-'));
        const repoDir = yield* Effect.promise(() => makeTempDir('spence-fop-rename-proj-'));
        yield* Effect.promise(() => initGitRepo(repoDir));
        yield* Effect.promise(() => writeFile(path.join(repoDir, 'old.ts'), 'old'));
        yield* Effect.promise(() => writeFile(path.join(repoDir, 'existing.ts'), 'existing'));

        const trashed: string[] = [];
        const layer = makeTestLayer(
          storeDir,
          [repoDir],
          Layer.succeed(Trash, {
            moveToTrash: (absolutePath) =>
              Effect.sync(() => {
                trashed.push(absolutePath);
              }),
          }),
        );

        yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const ops = yield* FileOperations;
          const proj = yield* projects.add;
          expect(proj).not.toBeNull();
          if (!proj) return;
          const target = { projectId: proj.id };

          const blockedReview = yield* ops.reviewRename({
            target,
            relativePath: 'old.ts',
            newName: 'existing.ts',
          });
          expect(blockedReview.blockers.some((b) => b.code === 'TargetExists')).toBe(true);

          const review = yield* ops.reviewRename({
            target,
            relativePath: 'old.ts',
            newName: 'existing.ts',
            allowOverwrite: true,
          });
          expect(review.blockers).toHaveLength(0);
          expect(review.targets[0]).toMatchObject({
            path: 'old.ts',
            exists: true,
            willBeTrashed: false,
          });
          expect(review.targets[1]).toMatchObject({
            path: 'existing.ts',
            exists: true,
            willBeTrashed: true,
          });

          const result = yield* ops.execute({
            reviewId: review.reviewId,
            operationId: OperationId.make('op-rename'),
          });
          expect(result.outcome).toBe('Succeeded');
          expect(trashed).toHaveLength(1);
          expect(trashed[0]?.endsWith('existing.ts')).toBe(true);

          const oldStat = yield* Effect.promise(() =>
            lstat(path.join(repoDir, 'old.ts')).catch(() => undefined),
          );
          expect(oldStat).toBeUndefined();
          const newStat = yield* Effect.promise(() =>
            lstat(path.join(repoDir, 'existing.ts')).catch(() => undefined),
          );
          expect(newStat?.isFile()).toBe(true);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    'deletes files through trash and falls back to permanent delete when trash is unavailable',
    () =>
      Effect.gen(function* () {
        const storeDir = yield* Effect.promise(() => makeTempDir('spence-fop-del-store-'));
        const repoDir = yield* Effect.promise(() => makeTempDir('spence-fop-del-proj-'));
        yield* Effect.promise(() => initGitRepo(repoDir));
        yield* Effect.promise(() => writeFile(path.join(repoDir, 'a.ts'), 'a'));
        yield* Effect.promise(() => writeFile(path.join(repoDir, 'b.ts'), 'b'));

        const trashed: string[] = [];
        const layer = makeTestLayer(
          storeDir,
          [repoDir],
          Layer.succeed(Trash, {
            moveToTrash: () =>
              Effect.fail(
                new FileOperationsError({
                  reason: 'TrashUnavailable',
                  detail: 'Trash unavailable in test.',
                }),
              ),
          }),
        );

        yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const ops = yield* FileOperations;
          const proj = yield* projects.add;
          expect(proj).not.toBeNull();
          if (!proj) return;
          const target = { projectId: proj.id };

          const review = yield* ops.reviewDelete({
            target,
            relativePaths: ['a.ts', 'b.ts'],
          });
          expect(review.targets).toHaveLength(2);

          const firstAttempt = yield* ops
            .execute({
              reviewId: review.reviewId,
              operationId: OperationId.make('op-delete-trash'),
            })
            .pipe(Effect.flip);
          expect(firstAttempt.reason).toBe('TrashUnavailable');
          expect(trashed).toHaveLength(0);

          // A trash-mode review can never authorize permanent removal.
          const bypass = yield* ops
            .execute({
              reviewId: review.reviewId,
              operationId: OperationId.make('op-delete-bypass'),
              allowPermanentDelete: true,
            })
            .pipe(Effect.flip);
          expect(bypass.reason).toBe('PermanentDeleteRequired');

          // When trash is unavailable the caller must re-review and explicitly confirm permanent removal.
          const permanentReview = yield* ops.reviewDelete({
            target,
            relativePaths: ['a.ts', 'b.ts'],
            permanent: true,
          });
          expect(permanentReview.requiresPermanentConfirmation).toBe(true);
          const secondAttempt = yield* ops.execute({
            reviewId: permanentReview.reviewId,
            operationId: OperationId.make('op-delete-permanent'),
            allowPermanentDelete: true,
          });
          expect(secondAttempt.outcome).toBe('Succeeded');
          const aStat = yield* Effect.promise(() =>
            lstat(path.join(repoDir, 'a.ts')).catch(() => undefined),
          );
          const bStat = yield* Effect.promise(() =>
            lstat(path.join(repoDir, 'b.ts')).catch(() => undefined),
          );
          expect(aStat).toBeUndefined();
          expect(bStat).toBeUndefined();
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    'blocks protected Git paths, traversal, and nested repositories at review time',
    () =>
      Effect.gen(function* () {
        const storeDir = yield* Effect.promise(() => makeTempDir('spence-fop-sec-store-'));
        const repoDir = yield* Effect.promise(() => makeTempDir('spence-fop-sec-proj-'));
        const nestedDir = path.join(repoDir, 'packages', 'sub');
        yield* Effect.promise(() => mkdir(nestedDir, { recursive: true }));
        yield* Effect.promise(() => initGitRepo(repoDir));
        yield* Effect.promise(() => initGitRepo(nestedDir));

        const layer = makeTestLayer(
          storeDir,
          [repoDir],
          Layer.succeed(Trash, { moveToTrash: () => Effect.void }),
        );

        yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const ops = yield* FileOperations;
          const proj = yield* projects.add;
          expect(proj).not.toBeNull();
          if (!proj) return;
          const target = { projectId: proj.id };

          const gitCreate = yield* ops
            .reviewCreate({
              target,
              dirPath: '',
              name: '.git',
              kind: 'file',
            })
            .pipe(Effect.flip);
          expect(gitCreate.reason).toBe('ProtectedPath');

          const traversalDelete = yield* ops
            .reviewDelete({
              target,
              relativePaths: ['../escape.ts'],
            })
            .pipe(Effect.flip);
          expect(traversalDelete.reason).toBe('OutsideRoot');

          const nestedDelete = yield* ops.reviewDelete({
            target,
            relativePaths: ['packages/sub'],
          });
          expect(nestedDelete.blockers.some((b) => b.code === 'NestedRepo')).toBe(true);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    'refuses root deletion and detects saved content changes between review and execution',
    () =>
      Effect.gen(function* () {
        const storeDir = yield* Effect.promise(() => makeTempDir('spence-fop-root-store-'));
        const repoDir = yield* Effect.promise(() => makeTempDir('spence-fop-root-proj-'));
        yield* Effect.promise(() => initGitRepo(repoDir));
        yield* Effect.promise(() => writeFile(path.join(repoDir, 'data.txt'), 'before'));

        const layer = makeTestLayer(
          storeDir,
          [repoDir],
          Layer.succeed(Trash, {
            moveToTrash: () => Effect.void,
          }),
        );

        yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const ops = yield* FileOperations;
          const proj = yield* projects.add;
          expect(proj).not.toBeNull();
          if (!proj) return;
          const target = { projectId: proj.id };

          for (const unsafe of ['', '.', '..', './.']) {
            const refused = yield* ops
              .reviewDelete({ target, relativePaths: [unsafe] })
              .pipe(Effect.flip);
            expect(refused.reason).toBe('OutsideRoot');
          }
          const rootStillExists = yield* Effect.promise(() =>
            lstat(repoDir).catch(() => undefined),
          );
          expect(rootStillExists?.isDirectory()).toBe(true);

          const review = yield* ops.reviewDelete({ target, relativePaths: ['data.txt'] });
          yield* Effect.promise(() => writeFile(path.join(repoDir, 'data.txt'), 'after'));
          const stale = yield* ops
            .execute({
              reviewId: review.reviewId,
              operationId: OperationId.make('op-stale-content'),
            })
            .pipe(Effect.flip);
          expect(stale.reason).toBe('StaleReview');
          const content = yield* Effect.promise(() =>
            readFile(path.join(repoDir, 'data.txt'), 'utf8'),
          );
          expect(content).toBe('after');
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    'reports partial results when one path in a delete batch fails',
    () =>
      Effect.gen(function* () {
        const storeDir = yield* Effect.promise(() => makeTempDir('spence-fop-partial-store-'));
        const repoDir = yield* Effect.promise(() => makeTempDir('spence-fop-partial-proj-'));
        yield* Effect.promise(() => initGitRepo(repoDir));
        yield* Effect.promise(() => writeFile(path.join(repoDir, 'a.ts'), 'a'));
        yield* Effect.promise(() => writeFile(path.join(repoDir, 'b.ts'), 'b'));

        const layer = makeTestLayer(
          storeDir,
          [repoDir],
          Layer.succeed(Trash, {
            moveToTrash: (absolutePath) =>
              absolutePath.endsWith('b.ts')
                ? Effect.fail(
                    new FileOperationsError({
                      reason: 'IoFailed',
                      detail: 'Simulated failure for partial result.',
                    }),
                  )
                : Effect.void,
          }),
        );

        yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const ops = yield* FileOperations;
          const proj = yield* projects.add;
          expect(proj).not.toBeNull();
          if (!proj) return;
          const target = { projectId: proj.id };

          const review = yield* ops.reviewDelete({
            target,
            relativePaths: ['a.ts', 'b.ts'],
          });
          const result = yield* ops.execute({
            reviewId: review.reviewId,
            operationId: OperationId.make('op-partial'),
          });
          expect(result.outcome).toBe('Partial');
          expect(result.pathResults).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ path: 'a.ts', status: 'Completed' }),
              expect.objectContaining({ path: 'b.ts', status: 'Failed' }),
            ]),
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    'reconciles interrupted file operations on restart',
    () =>
      Effect.gen(function* () {
        const storeDir = yield* Effect.promise(() => makeTempDir('spence-fop-recon-store-'));
        const repoDir = yield* Effect.promise(() => makeTempDir('spence-fop-recon-proj-'));
        yield* Effect.promise(() => initGitRepo(repoDir));
        yield* Effect.promise(() => writeFile(path.join(repoDir, 'left.ts'), 'left'));

        const layer = makeTestLayer(
          storeDir,
          [repoDir],
          Layer.succeed(Trash, { moveToTrash: () => Effect.void }),
        );

        yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const ops = yield* FileOperations;
          const proj = yield* projects.add;
          expect(proj).not.toBeNull();
          if (!proj) return;
          const target = { projectId: proj.id };

          const review = yield* ops.reviewDelete({
            target,
            relativePaths: ['left.ts'],
          });
          const opId = OperationId.make('op-interrupted');
          const interrupted = yield* ops
            .execute({
              reviewId: review.reviewId,
              operationId: opId,
            })
            .pipe(
              Effect.tap(() => Effect.die('interrupted')),
              Effect.exit,
            );
          expect(interrupted._tag).toBe('Failure');

          const restoredLayer = makeTestLayer(
            storeDir,
            [repoDir],
            Layer.succeed(Trash, { moveToTrash: () => Effect.void }),
          );
          const reconciled = yield* Effect.gen(function* () {
            const restoredOps = yield* FileOperations;
            return yield* restoredOps.execute({
              reviewId: review.reviewId,
              operationId: opId,
            });
          }).pipe(Effect.provide(restoredLayer));
          expect(reconciled.outcome).toBe('Succeeded');
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    'leaves Git index untouched after file mutations',
    () =>
      Effect.gen(function* () {
        const storeDir = yield* Effect.promise(() => makeTempDir('spence-fop-index-store-'));
        const repoDir = yield* Effect.promise(() => makeTempDir('spence-fop-index-proj-'));
        yield* Effect.promise(() => initGitRepo(repoDir));
        yield* Effect.promise(() => writeFile(path.join(repoDir, 'tracked.ts'), 'tracked'));
        yield* Effect.sync(() => runGit(repoDir, 'add', 'tracked.ts'));
        yield* Effect.sync(() => runGit(repoDir, 'commit', '-m', 'add tracked'));

        const layer = makeTestLayer(
          storeDir,
          [repoDir],
          Layer.succeed(Trash, {
            moveToTrash: (absolutePath) =>
              Effect.promise(() => rm(absolutePath, { recursive: true, force: true })),
          }),
        );

        yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const ops = yield* FileOperations;
          const proj = yield* projects.add;
          expect(proj).not.toBeNull();
          if (!proj) return;
          const target = { projectId: proj.id };

          const review = yield* ops.reviewDelete({
            target,
            relativePaths: ['tracked.ts'],
          });
          yield* ops.execute({
            reviewId: review.reviewId,
            operationId: OperationId.make('op-index'),
          });

          const status = yield* Effect.sync(() => runGit(repoDir, 'status', '--porcelain'));
          expect(status).toContain(' D tracked.ts');
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    20_000,
  );
});
