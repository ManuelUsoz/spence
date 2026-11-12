import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
  ProjectId,
  ProjectsError,
  ProjectsRpcs,
  type Project,
} from '../../shared/projects/projects.rpc';
import { DesktopApi } from './desktop-api';
import { makeDesktopTestLayer } from './desktop-layers';

const app: Project = {
  id: ProjectId.make('p1'),
  name: 'app',
  path: '/work/app',
  addedAt: 1,
  lastUsedAt: 2,
  settings: { defaultPermissionMode: 'ask' },
  folderMissing: true,
};

const handlers = ProjectsRpcs.toLayer({
  'Projects.list': () => Effect.succeed([app]),
  'Projects.add': () => Effect.fail(new ProjectsError({ reason: 'AlreadyAdded', detail: 'app' })),
  'Projects.rename': () => Effect.succeed(app),
  'Projects.remove': () => Effect.void,
  'Projects.locate': () => Effect.succeed(null),
  'Projects.check': () => Effect.succeed(app),
  'Projects.setSettings': ({ patch }) =>
    Effect.succeed({ ...app, settings: patch.defaultPermissionMode === null ? {} : app.settings }),
});

describe('DesktopApi Projects', () => {
  it.effect('serves Projects through the real contract, typed errors included', () =>
    Effect.gen(function* () {
      const api = yield* DesktopApi;
      expect(yield* api['Projects.list']()).toEqual([app]);
      expect(yield* api['Projects.locate']({ id: app.id })).toBeNull();

      const error = yield* Effect.flip(api['Projects.add']());
      expect(error).toMatchObject({ _tag: 'ProjectsError', reason: 'AlreadyAdded', detail: 'app' });

      const cleared = yield* api['Projects.setSettings']({
        id: app.id,
        patch: { defaultPermissionMode: null },
      });
      expect(cleared.settings).toEqual({});
    }).pipe(Effect.provide(makeDesktopTestLayer(handlers))),
  );
});
