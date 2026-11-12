import { Layer } from 'effect';
import { ProjectsRpcs } from '../../src/shared/projects/projects.rpc';
import { layerProjectsLive, Projects } from '../projects/projects';

export const layerProjectsHandlers = ProjectsRpcs.toLayer({
  'Projects.list': () => Projects.use((projects) => projects.list),
  'Projects.add': () => Projects.use((projects) => projects.add),
  'Projects.rename': ({ id, name }) => Projects.use((projects) => projects.rename(id, name)),
  'Projects.remove': ({ id }) => Projects.use((projects) => projects.remove(id)),
  'Projects.locate': ({ id }) => Projects.use((projects) => projects.locate(id)),
  'Projects.check': ({ id }) => Projects.use((projects) => projects.check(id)),
  'Projects.setSettings': ({ id, patch }) =>
    Projects.use((projects) => projects.setSettings(id, patch)),
}).pipe(Layer.provide(layerProjectsLive));
