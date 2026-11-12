import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { layerStore } from '../store/store';
import { FolderPicker, Folders } from './folders';
import { layerProjects, Projects } from './projects';
import { layerSessionCwds } from './session-cwds';

/**
 * A disk of folders by exact path. On `win32` paths match case-insensitively and resolve to the casing on disk,
 * as `realpath` does there.
 */
const fakeFolders = (platform: NodeJS.Platform, folders: Set<string>) => {
  const find = (p: string) =>
    [...folders].find((f) =>
      platform === 'win32' ? f.toLowerCase() === p.toLowerCase() : f === p,
    );
  return Layer.succeed(Folders, {
    platform,
    realPath: (p) => Effect.sync(() => Option.fromUndefinedOr(find(p))),
    exists: (p) => Effect.sync(() => find(p) !== undefined),
  });
};

/** A picker that answers with the queued folders in order, then cancels. */
const fakePicker = (answers: Array<string>) =>
  Layer.succeed(FolderPicker, {
    pick: Effect.sync(() => Option.fromUndefinedOr(answers.shift())),
  });

interface World {
  readonly root: string;
  readonly folders: Set<string>;
  readonly pick: Array<string>;
}

/** A fresh store root per test, removed afterwards, with the given disk and picker answers. */
const withProjects = <A, E>(
  platform: NodeJS.Platform,
  body: (world: World) => Effect.Effect<A, E, Projects>,
) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-projects-'))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ).pipe(
    Effect.flatMap((root) => {
      const world: World = { root, folders: new Set(), pick: [] };
      const layer = layerProjects.pipe(
        Layer.provide(layerSessionCwds),
        Layer.provide(layerStore(root)),
        Layer.provide(fakeFolders(platform, world.folders)),
        Layer.provide(fakePicker(world.pick)),
      );
      return body(world).pipe(Effect.provide(layer));
    }),
    Effect.scoped,
  );

const addFolder = (world: World, folder: string) =>
  Effect.gen(function* () {
    world.folders.add(folder);
    world.pick.push(folder);
    return yield* Projects.use((p) => p.add);
  });

const unknownId = ProjectId.make('nope');

describe('Projects', () => {
  it.effect('adds a picked folder named after it, and lists it', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const added = yield* addFolder(world, '/work/my-app');
        expect(added).toMatchObject({
          name: 'my-app',
          path: '/work/my-app',
          settings: {},
          folderMissing: false,
        });
        expect(added?.lastUsedAt).toBe(added?.addedAt);
        expect(yield* Projects.use((p) => p.list)).toEqual([added]);
      }),
    ),
  );

  it.effect('does nothing when the picker is cancelled', () =>
    withProjects('linux', () =>
      Effect.gen(function* () {
        expect(yield* Projects.use((p) => p.add)).toBeNull();
        expect(yield* Projects.use((p) => p.list)).toEqual([]);
      }),
    ),
  );

  it.effect('keeps nested folders as separate Projects', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        yield* addFolder(world, '/work/app');
        yield* addFolder(world, '/work/app/packages/ui');
        expect((yield* Projects.use((p) => p.list)).map((p) => p.name)).toEqual(['app', 'ui']);
      }),
    ),
  );

  it.effect('refuses a folder that is already a Project, naming it', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const added = yield* addFolder(world, '/work/app');
        if (added === null) return expect.unreachable();
        yield* Projects.use((p) => p.rename(added.id, 'My App'));
        const error = yield* Effect.flip(addFolder(world, '/work/app'));
        expect(error).toMatchObject({ reason: 'AlreadyAdded', detail: 'My App' });
      }),
    ),
  );

  it.effect('on Windows, refuses the same folder spelled in another case', () =>
    withProjects('win32', (world) =>
      Effect.gen(function* () {
        yield* addFolder(world, 'C:\\Work\\App');
        world.pick.push('c:\\work\\app');
        const error = yield* Effect.flip(Projects.use((p) => p.add));
        expect(error).toMatchObject({ reason: 'AlreadyAdded', detail: 'App' });
      }),
    ),
  );

  it.effect('on Linux, folders that differ only in case are different Projects', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        yield* addFolder(world, '/work/App');
        yield* addFolder(world, '/work/app');
        expect(yield* Projects.use((p) => p.list)).toHaveLength(2);
      }),
    ),
  );

  it.effect('revives a removed Project with the same id when its folder is added again', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const added = yield* addFolder(world, '/work/app');
        if (added === null) return expect.unreachable();
        yield* Projects.use((p) => p.rename(added.id, 'Kept'));
        yield* Projects.use((p) => p.remove(added.id));
        expect(yield* Projects.use((p) => p.list)).toEqual([]);

        const revived = yield* addFolder(world, '/work/app');
        expect(revived).toMatchObject({ id: added.id, name: 'Kept' });
        expect(yield* Projects.use((p) => p.list)).toHaveLength(1);
      }),
    ),
  );

  it.effect('keeps the tombstone on disk when removing', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const added = yield* addFolder(world, '/work/app');
        if (added === null) return expect.unreachable();
        yield* Projects.use((p) => p.remove(added.id));
        const file = JSON.parse(
          yield* Effect.promise(() => readFile(path.join(world.root, 'projects.json'), 'utf8')),
        ) as { version: number; projects: Array<{ id: string; removedAt?: number }> };
        expect(file.version).toBe(1);
        expect(file.projects).toEqual([
          expect.objectContaining({ id: added.id, removedAt: expect.any(Number) }),
        ]);
      }),
    ),
  );

  it.effect('renames, and falls back to the folder name for a blank name', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const added = yield* addFolder(world, '/work/my-app');
        if (added === null) return expect.unreachable();
        expect((yield* Projects.use((p) => p.rename(added.id, '  Shop  '))).name).toBe('Shop');
        expect((yield* Projects.use((p) => p.rename(added.id, '   '))).name).toBe('my-app');
      }),
    ),
  );

  it.effect('fails NotFound for an unknown or removed id', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const added = yield* addFolder(world, '/work/app');
        if (added === null) return expect.unreachable();
        yield* Projects.use((p) => p.remove(added.id));
        for (const id of [unknownId, added.id]) {
          const error = yield* Effect.flip(Projects.use((p) => p.rename(id, 'x')));
          expect(error.reason).toBe('NotFound');
        }
      }),
    ),
  );

  it.effect('reports a missing folder when listing and checking', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const added = yield* addFolder(world, '/work/app');
        if (added === null) return expect.unreachable();
        world.folders.delete('/work/app');
        expect((yield* Projects.use((p) => p.list))[0]?.folderMissing).toBe(true);
        expect((yield* Projects.use((p) => p.check(added.id))).folderMissing).toBe(true);
        world.folders.add('/work/app');
        expect((yield* Projects.use((p) => p.check(added.id))).folderMissing).toBe(false);
      }),
    ),
  );

  it.effect('locates a moved folder and rewrites the cwd of its Sessions in the old folder', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const added = yield* addFolder(world, '/work/app');
        if (added === null) return expect.unreachable();
        const session = (id: string, cwd: string) =>
          Effect.promise(async () => {
            await mkdir(path.join(world.root, 'sessions', id), { recursive: true });
            await writeFile(
              path.join(world.root, 'sessions', id, 'session.json'),
              JSON.stringify({ version: 1, id, projectId: added.id, cwd, agentId: 'claude' }),
            );
          });
        const cwdOf = (id: string) =>
          Effect.promise(() =>
            readFile(path.join(world.root, 'sessions', id, 'session.json'), 'utf8'),
          ).pipe(Effect.map((text) => (JSON.parse(text) as { cwd: string }).cwd));
        yield* session('s1', '/work/app');
        yield* session('s2', '/elsewhere');

        world.folders.delete('/work/app');
        world.folders.add('/moved/app');
        world.pick.push('/moved/app');
        const located = yield* Projects.use((p) => p.locate(added.id));

        expect(located).toMatchObject({ id: added.id, path: '/moved/app', folderMissing: false });
        expect(yield* cwdOf('s1')).toBe('/moved/app');
        expect(yield* cwdOf('s2')).toBe('/elsewhere');
        const s1 = JSON.parse(
          yield* Effect.promise(() =>
            readFile(path.join(world.root, 'sessions', 's1', 'session.json'), 'utf8'),
          ),
        ) as Record<string, unknown>;
        expect(s1).toMatchObject({ version: 1, id: 's1', agentId: 'claude' });
      }),
    ),
  );

  it.effect('refuses to locate onto the folder of another Project', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const a = yield* addFolder(world, '/work/a');
        yield* addFolder(world, '/work/b');
        if (a === null) return expect.unreachable();
        world.pick.push('/work/b');
        const error = yield* Effect.flip(Projects.use((p) => p.locate(a.id)));
        expect(error).toMatchObject({ reason: 'AlreadyAdded', detail: 'b' });
      }),
    ),
  );

  it.effect('patches settings sparsely, and null clears a key', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const added = yield* addFolder(world, '/work/app');
        if (added === null) return expect.unreachable();
        const set = Projects.use((p) => p.setSettings(added.id, { defaultPermissionMode: 'ask' }));
        expect((yield* set).settings).toEqual({ defaultPermissionMode: 'ask' });
        expect((yield* Projects.use((p) => p.setSettings(added.id, {}))).settings).toEqual({
          defaultPermissionMode: 'ask',
        });
        const cleared = yield* Projects.use((p) =>
          p.setSettings(added.id, { defaultPermissionMode: null }),
        );
        expect(cleared.settings).toEqual({});
      }),
    ),
  );

  it.effect('touch moves lastUsedAt forward', () =>
    withProjects('linux', (world) =>
      Effect.gen(function* () {
        const added = yield* addFolder(world, '/work/app');
        if (added === null) return expect.unreachable();
        yield* TestClock.adjust('1 hour');
        yield* Projects.use((p) => p.touch(added.id));
        const [listed] = yield* Projects.use((p) => p.list);
        expect(listed?.lastUsedAt).toBe(added.lastUsedAt + 3_600_000);
        expect(listed?.addedAt).toBe(added.addedAt);
      }),
    ),
  );
});
