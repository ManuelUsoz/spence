import { Effect, Layer } from 'effect';
import {
  ProjectPickerRpcs,
  ProjectsOnDeviceRpcs,
  type ProjectId,
} from '../../src/shared/projects/projects.rpc';
import { layerProjectsLive, Projects } from '../projects/projects';
import { Sessions } from '../sessions/sessions';
import { layerSessionsLive } from './sessions';

/** Unbound: needs `Projects` and `Sessions`, so a test Device can serve it over its own Store. */
export const layerProjectsHandlersWith = ProjectsOnDeviceRpcs.toLayer({
  'Projects.list': () => Projects.use((projects) => projects.list),
  'Projects.addFolder': ({ path }) => Projects.use((projects) => projects.addFolder(path)),
  'Projects.rename': ({ id, name }) => Projects.use((projects) => projects.rename(id, name)),
  'Projects.remove': Effect.fnUntraced(function* ({ id }: { readonly id: ProjectId }) {
    const projects = yield* Projects;
    const sessions = yield* Sessions;
    yield* projects.remove(id);
    yield* sessions.cancelProject(id);
  }),
  'Projects.locateFolder': ({ id, path }) =>
    Projects.use((projects) => projects.locateFolder(id, path)),
  'Projects.check': ({ id }) => Projects.use((projects) => projects.check(id)),
  'Projects.setSettings': ({ id, patch }) =>
    Projects.use((projects) => projects.setSettings(id, patch)),
});

export const layerProjectsHandlers = layerProjectsHandlersWith.pipe(
  Layer.provide(Layer.mergeAll(layerProjectsLive, layerSessionsLive)),
);

/** The native folder picker: the Local window only, never served to a Paired device. */
export const layerProjectPickerHandlers = ProjectPickerRpcs.toLayer({
  'Projects.add': () => Projects.use((projects) => projects.add),
  'Projects.locate': ({ id }) => Projects.use((projects) => projects.locate(id)),
}).pipe(Layer.provide(layerProjectsLive));
