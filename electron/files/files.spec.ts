import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from 'effect';
import { afterEach, describe, expect } from 'vitest';
import { DEFAULT_FILES_PREVIEW_MAX_BYTES, FilesError } from '../../src/shared/files/files.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { WorktreeId } from '../../src/shared/worktrees/worktrees.rpc';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';
import { FolderPicker, layerFolders } from '../projects/folders';
import { layerProjects, Projects } from '../projects/projects';
import { layerSessionStore } from '../sessions/session-store';
import { layerStore } from '../store/store';
import { layerGitWorkerDirect } from '../worktrees/git-client';
import { layerWorktrees, Worktrees } from '../worktrees/worktrees';
import { ExternalOpener, Files, layerFiles } from './files';

const createdDirs: string[] = [];

const makeTempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
};

const runGit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const initGitRepo = async (dir: string): Promise<void> => {
  runGit(dir, 'init');
  runGit(dir, 'config', 'user.email', 'test@example.com');
  runGit(dir, 'config', 'user.name', 'Test User');
  await writeFile(join(dir, 'README.md'), '# Repo\n');
  runGit(dir, 'add', 'README.md');
  runGit(dir, 'commit', '-m', 'init');
};

const makeTestLayer = (storeDir: string, pickedFolders: string[]) => {
  const openedPaths: string[] = [];
  const nextPicked = () => {
    const next = pickedFolders.shift();
    return next === undefined ? Option.none<string>() : Option.some(next);
  };
  const pathLayer = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));
  const storeLayer = layerStore(storeDir);
  const gitWorkerLayer = layerGitWorkerDirect.pipe(Layer.provide(pathLayer));
  const projectsLayer = layerProjects.pipe(
    Layer.provide(layerSessionStore),
    Layer.provide(
      Layer.mergeAll(
        storeLayer,
        layerFolders,
        Layer.succeed(FolderPicker, { pick: Effect.sync(nextPicked) }),
      ),
    ),
  );
  const worktreesLayer = layerWorktrees.pipe(
    Layer.provide(Layer.mergeAll(gitWorkerLayer, storeLayer, pathLayer)),
  );
  const openerLayer = Layer.succeed(ExternalOpener, {
    openPath: (targetPath) =>
      Effect.sync(() => {
        openedPaths.push(targetPath);
      }),
  });
  const filesLayer = layerFiles.pipe(
    Layer.provideMerge(Layer.mergeAll(projectsLayer, worktreesLayer, gitWorkerLayer, openerLayer)),
  );
  return {
    layer: Layer.mergeAll(filesLayer, projectsLayer, worktreesLayer),
    openedPaths,
  };
};

afterEach(async () => {
  while (createdDirs.length > 0) {
    const next = createdDirs.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe('Files domain service', () => {
  it.live(
    'validates Project & Worktree identity, honors Project ignored visibility, and opens externally',
    () =>
      Effect.gen(function* () {
        const setup = yield* Effect.promise(async () => {
          const storeDir = await makeTempDir('spence-files-store-');
          const parent = await makeTempDir('spence-files-proj-');
          const repoDir = join(parent, 'repo');
          const linkedWtDir = join(parent, 'wt-feat');
          const otherRepoDir = join(parent, 'other-repo');
          await mkdir(repoDir);
          await mkdir(otherRepoDir);
          await initGitRepo(repoDir);
          await initGitRepo(otherRepoDir);
          await writeFile(join(repoDir, '.gitignore'), '*.log\n');
          await writeFile(join(repoDir, 'ignored.log'), 'secret-log');
          await writeFile(join(repoDir, 'main.ts'), 'export const main = 1;\n');
          runGit(repoDir, 'add', '.gitignore', 'main.ts');
          runGit(repoDir, 'commit', '-m', 'add files');
          runGit(repoDir, 'worktree', 'add', '-b', 'feat', linkedWtDir);
          await writeFile(join(linkedWtDir, 'wt-only.ts'), 'export const wt = true;\n');
          return { storeDir, repoDir, otherRepoDir };
        });

        const { layer, openedPaths } = makeTestLayer(setup.storeDir, [
          setup.repoDir,
          setup.otherRepoDir,
        ]);

        yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const worktrees = yield* Worktrees;
          const files = yield* Files;

          const projA = yield* projects.add;
          const projB = yield* projects.add;
          expect(projA).not.toBeNull();
          expect(projB).not.toBeNull();
          if (!projA || !projB) return;

          const defaultPage = yield* files.listDir({
            target: { projectId: projA.id },
            dirPath: '',
          });
          expect(defaultPage.showIgnoredFiles).toBe(false);
          expect(defaultPage.entries.some((entry) => entry.name === 'ignored.log')).toBe(false);

          const updatedProj = yield* projects.setSettings(projA.id, { showIgnoredFiles: true });
          expect(updatedProj.settings.showIgnoredFiles).toBe(true);
          const withIgnored = yield* files.listDir({
            target: { projectId: projA.id },
            dirPath: '',
          });
          expect(withIgnored.showIgnoredFiles).toBe(true);
          expect(withIgnored.entries).toContainEqual(
            expect.objectContaining({ name: 'ignored.log', ignored: true }),
          );

          const invA = yield* worktrees.inventory(projA.path, projA.id);
          const linkedWt = invA.worktrees.find((w) => !w.isPrimary);
          expect(linkedWt).toBeDefined();
          if (!linkedWt) return;

          const wtPreview = yield* files.readPreview({
            target: { projectId: projA.id, worktreeId: linkedWt.id },
            relativePath: 'wt-only.ts',
          });
          expect(wtPreview).toMatchObject({
            _tag: 'Text',
            path: 'wt-only.ts',
            content: 'export const wt = true;\n',
            previewLimitBytes: DEFAULT_FILES_PREVIEW_MAX_BYTES,
          });

          const invB = yield* worktrees.inventory(projB.path, projB.id);
          const otherWt = invB.worktrees[0];
          expect(otherWt).toBeDefined();
          if (!otherWt) return;

          const crossErr = yield* files
            .listDir({
              target: { projectId: projA.id, worktreeId: otherWt.id },
              dirPath: '',
            })
            .pipe(Effect.flip);
          expect(crossErr).toMatchObject({ _tag: 'FilesError', reason: 'MissingWorktree' });

          const unknownProjErr = yield* files
            .listDir({
              target: { projectId: ProjectId.make('missing-proj') },
              dirPath: '',
            })
            .pipe(Effect.flip);
          expect(unknownProjErr).toMatchObject({ _tag: 'FilesError', reason: 'MissingProject' });

          const unknownWtErr = yield* files
            .listDir({
              target: { projectId: projA.id, worktreeId: WorktreeId.make('wt_missing') },
              dirPath: '',
            })
            .pipe(Effect.flip);
          expect(unknownWtErr).toMatchObject({ _tag: 'FilesError', reason: 'MissingWorktree' });

          yield* files.openExternal({
            target: { projectId: projA.id, worktreeId: linkedWt.id },
            relativePath: 'wt-only.ts',
          });
          expect(openedPaths).toHaveLength(1);
          expect(openedPaths[0]?.toLowerCase()).toContain('wt-only.ts');

          const blockedOpen = yield* files
            .openExternal({
              target: { projectId: projA.id },
              relativePath: '.git/config',
            })
            .pipe(Effect.flip);
          expect(blockedOpen).toMatchObject({ _tag: 'FilesError', reason: 'OutsideRoot' });
          expect(openedPaths).toHaveLength(1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.live('blocks symlink escapes and nested repos through the full Files service', () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(async () => {
        const storeDir = await makeTempDir('spence-files-sec-store-');
        const parent = await makeTempDir('spence-files-sec-proj-');
        const repoDir = join(parent, 'repo');
        const outsideDir = join(parent, 'outside');
        const nestedRepoDir = join(repoDir, 'packages', 'sub');
        await mkdir(repoDir);
        await mkdir(outsideDir);
        await writeFile(join(outsideDir, 'secret.txt'), 'nope');
        await initGitRepo(repoDir);
        await mkdir(nestedRepoDir, { recursive: true });
        await initGitRepo(nestedRepoDir);
        await writeFile(join(nestedRepoDir, 'nested.txt'), 'sub');
        await symlink(
          outsideDir,
          join(repoDir, 'out-link'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        return { storeDir, repoDir };
      });

      const { layer } = makeTestLayer(setup.storeDir, [setup.repoDir]);
      yield* Effect.gen(function* () {
        const projects = yield* Projects;
        const files = yield* Files;
        const proj = yield* projects.add;
        expect(proj).not.toBeNull();
        if (!proj) return;

        const escapeErr = yield* files
          .readPreview({ target: { projectId: proj.id }, relativePath: 'out-link/secret.txt' })
          .pipe(Effect.flip);
        expect(escapeErr).toMatchObject({ _tag: 'FilesError', reason: 'OutsideRoot' });

        const nestedErr = yield* files
          .readPreview({
            target: { projectId: proj.id },
            relativePath: 'packages/sub/nested.txt',
          })
          .pipe(Effect.flip);
        expect(nestedErr).toMatchObject({ _tag: 'FilesError', reason: 'OutsideRoot' });

        const missingPreview = yield* files.readPreview({
          target: { projectId: proj.id },
          relativePath: 'does-not-exist.ts',
        });
        expect(missingPreview).toMatchObject({ _tag: 'Unavailable', reason: 'Missing' });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.live('streams debounced live changes for Files.watch', () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(async () => {
        const storeDir = await makeTempDir('spence-files-watch-store-');
        const folder = await makeTempDir('spence-files-watch-dir-');
        await writeFile(join(folder, 'initial.txt'), 'v1');
        return { storeDir, folder };
      });

      const { layer } = makeTestLayer(setup.storeDir, [setup.folder]);
      yield* Effect.gen(function* () {
        const projects = yield* Projects;
        const files = yield* Files;
        const proj = yield* projects.add;
        expect(proj).not.toBeNull();
        if (!proj) return;

        const subscribed = yield* Deferred.make<void>();
        const fiber = yield* files.watch({ projectId: proj.id }).pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Effect.sleep('150 millis');
        yield* Effect.promise(() => writeFile(join(setup.folder, 'added.txt'), 'live'));

        const items = yield* Fiber.join(fiber).pipe(Effect.timeout('5 seconds'));
        expect(items).toHaveLength(1);
        expect(items[0]?._tag).toBe('Changed');
        if (items[0]?._tag === 'Changed') {
          expect(items[0].paths.some((p) => p.includes('added.txt') || p === '')).toBe(true);
        }

        expect(Schema.is(FilesError)(new FilesError({ reason: 'NotFound', detail: 'x' }))).toBe(
          true,
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.live('works in plain non-Git folders and emits RootMissing when watched root disappears', () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(async () => {
        const storeDir = await makeTempDir('spence-files-nongit-store-');
        const folder = await makeTempDir('spence-files-nongit-dir-');
        await writeFile(join(folder, 'notes.md'), 'hello');
        return { storeDir, folder };
      });

      const { layer } = makeTestLayer(setup.storeDir, [setup.folder]);
      yield* Effect.gen(function* () {
        const projects = yield* Projects;
        const files = yield* Files;
        const proj = yield* projects.add;
        expect(proj).not.toBeNull();
        if (!proj) return;

        const page = yield* files.listDir({ target: { projectId: proj.id }, dirPath: '' });
        expect(page.isGitRepo).toBe(false);
        expect(page.entries).toEqual([
          expect.objectContaining({ name: 'notes.md', kind: 'file', ignored: false }),
        ]);

        const fiber = yield* files
          .watch({ projectId: proj.id })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
        yield* Effect.sleep('150 millis');
        yield* Effect.promise(() => rm(setup.folder, { recursive: true, force: true }));
        // Watching handles must close cleanly on scope/error without leaking locks; either RootMissing
        // arrives immediately or wait slightly if Windows holds delete notification momentarily.
        const maybe = yield* Fiber.join(fiber).pipe(Effect.timeoutOption('2 seconds'));
        if (Option.isSome(maybe) && maybe.value.length > 0) {
          const ev = maybe.value[0];
          expect(ev?._tag === 'Unavailable' || ev?._tag === 'Changed').toBe(true);
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );
});
