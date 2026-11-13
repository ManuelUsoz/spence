import { Effect, Layer } from 'effect';
import { ProjectsRpcs, type ProjectId } from '../../src/shared/projects/projects.rpc';
import { layerProjectsLive, Projects } from '../projects/projects';
import { Sessions } from '../sessions/sessions';
import { layerSessionsLive } from './sessions';

export const layerProjectsHandlers = ProjectsRpcs.toLayer({
  'Projects.list': () => Projects.use((projects) => projects.list),
  'Projects.add': () => Projects.use((projects) => projects.add),
  'Projects.rename': ({ id, name }) => Projects.use((projects) => projects.rename(id, name)),
  'Projects.remove': Effect.fnUntraced(function* ({ id }: { readonly id: ProjectId }) {
    const projects = yield* Projects;
    const sessions = yield* Sessions;
    yield* projects.remove(id);
    yield* sessions.cancelProject(id);
  }),
  'Projects.locate': ({ id }) => Projects.use((projects) => projects.locate(id)),
  'Projects.check': ({ id }) => Projects.use((projects) => projects.check(id)),
  'Projects.setSettings': ({ id, patch }) =>
    Projects.use((projects) => projects.setSettings(id, patch)),
}).pipe(Layer.provide(Layer.mergeAll(layerProjectsLive, layerSessionsLive)));
