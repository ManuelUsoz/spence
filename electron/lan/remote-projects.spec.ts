/**
 * Setting up a Remote device from a viewer: two in-process Devices over real loopback `wss://`, the host serving real
 * Projects (over a real disk), Folders and execution Settings, the viewer calling them as its window would
 * (`DeviceScopedRpcs` through the production router, the Device named in the `DEVICE_SCOPE_HEADER`).
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { RpcClient } from 'effect/rpc';
import { mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEVICE_SCOPE_HEADER, type DeviceId } from '../../src/shared/devices/devices.rpc';
import { installFakeAgent, fakeEntry } from '../acp/acpFakes';
import { makeTestDevice, pairDevices, tempDataDir, type TestDevice } from '../devices/test-peer';
import { layerFolders } from '../projects/folders';
import { Projects } from '../projects/projects';
import { layerFoldersHandlers } from '../rpc/folders';
import { layerProjectsHandlersWith } from '../rpc/projects';
import { layerSessionsHandlersWith } from '../rpc/sessions';
import { layerExecutionSettingsHandlersWith } from '../rpc/settings';
import { AgentCatalog, makeAgentCatalog } from '../sessions/session-agent';
import { layerSessionsWithFakeAgent } from '../sessions/sessions-fakes';
import { Settings } from '../settings/settings';

/** Spawning the fake Agent takes longer than the default on a cold machine. */
const TIMEOUT = 60_000;

const onDevice =
  (device: DeviceId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    RpcClient.withHeaders(effect, { [DEVICE_SCOPE_HEADER]: device });

/** A Device whose Projects, Folders and execution Settings are real, over its own Store and the real disk. */
const makeHost = Effect.gen(function* () {
  const root = yield* tempDataDir;
  const install = yield* installFakeAgent;
  const services = yield* Layer.build(
    layerSessionsWithFakeAgent({
      root,
      install,
      projectFolder: process.cwd(),
      folders: layerFolders,
    }).pipe(Layer.provideMerge(Layer.succeed(AgentCatalog, makeAgentCatalog([fakeEntry()])))),
  );
  const serve = Layer.mergeAll(
    layerSessionsHandlersWith,
    layerProjectsHandlersWith,
    layerExecutionSettingsHandlersWith,
    layerFoldersHandlers,
  ).pipe(Layer.provide(Layer.succeedContext(services)));
  const device = yield* makeTestDevice({ serve });
  const run = <A, E>(effect: Effect.Effect<A, E, Projects | Settings>) =>
    Effect.provide(effect, services);
  return { device, run };
});

const connected = Effect.fnUntraced(function* (host: TestDevice, viewer: TestDevice) {
  yield* pairDevices(host, viewer);
  const hostId = (yield* host.identity).id;
  yield* viewer.awaitConnection(hostId, 'Online');
  return hostId;
});

/** A folder tree on disk: `alpha/`, `beta/`, `.hidden/`, a file, and a link to `alpha` (a junction on Windows). */
const makeTree = Effect.gen(function* () {
  const dir = yield* tempDataDir;
  yield* Effect.promise(async () => {
    await mkdir(path.join(dir, 'alpha'));
    await mkdir(path.join(dir, 'beta'));
    await mkdir(path.join(dir, '.hidden'));
    await writeFile(path.join(dir, 'notes.txt'), 'never read');
    await symlink(path.join(dir, 'alpha'), path.join(dir, 'to-alpha'), 'junction');
  });
  return yield* Effect.promise(() => realpath(dir));
});

describe('Remote Projects and execution Settings', () => {
  it.live(
    "a viewer browses the host's folders: folders only, hidden ones on request, links resolved",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost;
        const viewer = yield* makeTestDevice();
        const remote = onDevice(yield* connected(host.device, viewer));
        const api = viewer.desktop;
        const tree = yield* makeTree;

        const listing = yield* remote(api['Folders.browse']({ path: tree, hidden: false }));
        expect(listing.path).toBe(tree);
        expect(listing.parent).toBe(path.dirname(tree));
        expect(listing.entries).toEqual([
          { name: 'alpha', path: path.join(tree, 'alpha'), hidden: false, link: false },
          { name: 'beta', path: path.join(tree, 'beta'), hidden: false, link: false },
          { name: 'to-alpha', path: path.join(tree, 'alpha'), hidden: false, link: true },
        ]);

        const withHidden = yield* remote(api['Folders.browse']({ path: tree, hidden: true }));
        expect(withHidden.entries.map((entry) => entry.name)).toEqual([
          '.hidden',
          'alpha',
          'beta',
          'to-alpha',
        ]);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    "browsing starts at the host's home, with the disk's roots",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost;
        const viewer = yield* makeTestDevice();
        const remote = onDevice(yield* connected(host.device, viewer));

        const listing = yield* remote(
          viewer.desktop['Folders.browse']({ path: null, hidden: false }),
        );
        const home = yield* Effect.promise(() => realpath(homedir()));
        expect(listing.path).toBe(home);
        expect(listing.home).toBe(home);
        expect(listing.roots).toContain(path.parse(home).root);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a missing folder, or a file, fails as Missing',
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost;
        const viewer = yield* makeTestDevice();
        const remote = onDevice(yield* connected(host.device, viewer));
        const tree = yield* makeTree;
        const browse = (at: string) =>
          Effect.flip(remote(viewer.desktop['Folders.browse']({ path: at, hidden: false })));

        expect(yield* browse(path.join(tree, 'gone'))).toMatchObject({
          _tag: 'FoldersError',
          reason: 'Missing',
        });
        expect(yield* browse(path.join(tree, 'notes.txt'))).toMatchObject({
          _tag: 'FoldersError',
          reason: 'Missing',
        });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a viewer adds a Project on the host by a browsed folder, and locates it after it moved',
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost;
        const viewer = yield* makeHost;
        const remote = onDevice(yield* connected(host.device, viewer.device));
        const api = viewer.device.desktop;
        const tree = yield* makeTree;

        const added = yield* remote(api['Projects.addFolder']({ path: path.join(tree, 'alpha') }));
        expect(added).toMatchObject({ name: 'alpha', path: path.join(tree, 'alpha') });
        expect(yield* host.run(Projects.use((projects) => projects.list))).toEqual([added]);
        // The Project is the host's only.
        expect(yield* api['Projects.list']()).toEqual([]);

        const again = yield* Effect.flip(
          remote(api['Projects.addFolder']({ path: path.join(tree, 'to-alpha') })),
        );
        expect(again).toMatchObject({ reason: 'AlreadyAdded', detail: 'alpha' });

        yield* Effect.promise(() => rename(path.join(tree, 'beta'), path.join(tree, 'beta-moved')));
        const gone = yield* Effect.flip(
          remote(api['Projects.addFolder']({ path: path.join(tree, 'beta') })),
        );
        expect(gone).toMatchObject({ reason: 'FolderMissing' });

        const located = yield* remote(
          api['Projects.locateFolder']({ id: added.id, path: path.join(tree, 'beta-moved') }),
        );
        expect(located).toMatchObject({
          id: added.id,
          path: path.join(tree, 'beta-moved'),
          folderMissing: false,
        });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    "a viewer changes the host's execution Settings; its own stay as they were",
    () =>
      Effect.gen(function* () {
        const host = yield* makeHost;
        const viewer = yield* makeHost;
        const remote = onDevice(yield* connected(host.device, viewer.device));
        const api = viewer.device.desktop;

        const changed = yield* remote(
          api['ExecutionSettings.update']({
            patch: { defaultPermissionMode: 'ask', autoArchiveDays: 7 },
          }),
        );
        expect(changed).toMatchObject({ defaultPermissionMode: 'ask', autoArchiveDays: 7 });
        expect(yield* remote(api['ExecutionSettings.get']())).toEqual(changed);

        const onHost = yield* host.run(Settings.use((settings) => settings.get));
        expect(onHost).toMatchObject({ defaultPermissionMode: 'ask', autoArchiveDays: 7 });
        const own = yield* api['ExecutionSettings.get']();
        expect(own).toMatchObject({ defaultPermissionMode: 'auto', autoArchiveDays: null });
        // Only execution Settings cross: no UI preference is in what the host answers.
        expect(Object.keys(changed).sort()).toEqual([
          'agents',
          'autoArchiveDays',
          'defaultAgent',
          'defaultPermissionMode',
          'subagents',
        ]);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
