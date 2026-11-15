import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from 'effect';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  ProjectId,
  ProjectSettings,
  ProjectsError,
  Timestamp,
  type Project,
  type ProjectSettingsPatch,
} from '../../src/shared/projects/projects.rpc';
import { layerSessionStoreLive, SessionStore } from '../sessions/session-store';
import { layerStoreUserData, Store, type VersionedFile } from '../store/store';
import { folderKey } from './folder-key';
import { FolderPicker, Folders, layerFolderPicker, layerFolders } from './folders';

/** A Project as stored in `projects.json`; a removed one keeps its record with `removedAt`. */
const StoredProject = Schema.Struct({
  id: ProjectId,
  name: Schema.String,
  path: Schema.String,
  addedAt: Timestamp,
  lastUsedAt: Timestamp,
  removedAt: Schema.optionalKey(Timestamp),
  settings: Schema.optionalKey(ProjectSettings),
});
type StoredProject = typeof StoredProject.Type;

type ProjectsFile = { readonly projects: ReadonlyArray<StoredProject> };

export const projectsFile: VersionedFile<ProjectsFile> = {
  file: 'projects.json',
  version: 1,
  migrations: [],
  schema: Schema.Struct({ projects: Schema.Array(StoredProject) }),
  initial: () => ({ projects: [] }),
};

export interface ProjectsShape {
  /** Active Projects, each folder checked now. */
  readonly list: Effect.Effect<ReadonlyArray<Project>>;
  /** Asks for a folder and adds it, or revives the removed Project it belonged to; `null` when cancelled. */
  readonly add: Effect.Effect<Project | null, ProjectsError>;
  /** A blank name falls back to the folder name. */
  readonly rename: (id: ProjectId, name: string) => Effect.Effect<Project, ProjectsError>;
  /** Tombstones the Project; its Sessions are kept. */
  readonly remove: (id: ProjectId) => Effect.Effect<void, ProjectsError>;
  /** Asks for the Project's moved folder and points the Project and its Sessions there; `null` when cancelled. */
  readonly locate: (id: ProjectId) => Effect.Effect<Project | null, ProjectsError>;
  /** The Project with its folder checked now. */
  readonly check: (id: ProjectId) => Effect.Effect<Project, ProjectsError>;
  readonly setSettings: (
    id: ProjectId,
    patch: ProjectSettingsPatch,
  ) => Effect.Effect<Project, ProjectsError>;
  /** Marks the Project used now; Sessions call it when a Turn starts. An unknown id is ignored. */
  readonly touch: (id: ProjectId) => Effect.Effect<void>;
}

/** The Project list in `<userData>/spence/projects.json`. Main is the only writer; changes run one at a time. */
export class Projects extends Context.Service<Projects, ProjectsShape>()('projects/Projects') {}

const notFound = (id: ProjectId) => new ProjectsError({ reason: 'NotFound', detail: id });
const alreadyAdded = (project: StoredProject) =>
  new ProjectsError({ reason: 'AlreadyAdded', detail: project.name });
const removedProjectFolder = (project: StoredProject) =>
  new ProjectsError({ reason: 'RemovedProjectFolder', detail: project.name });

const isActive = (project: StoredProject): boolean => project.removedAt === undefined;

const applyOptionalSetting = <T>(
  current: T | undefined,
  next: T | null | undefined,
): T | undefined => (next === undefined ? current : next === null ? undefined : next);

const applyPatch = (settings: ProjectSettings, patch: ProjectSettingsPatch): ProjectSettings => {
  const defaultPermissionMode = applyOptionalSetting(
    settings.defaultPermissionMode,
    patch.defaultPermissionMode,
  );
  const showIgnoredFiles = applyOptionalSetting(settings.showIgnoredFiles, patch.showIgnoredFiles);
  return {
    ...(defaultPermissionMode === undefined ? {} : { defaultPermissionMode }),
    ...(showIgnoredFiles === undefined ? {} : { showIgnoredFiles }),
  };
};

export const layerProjects = Layer.effect(
  Projects,
  Effect.gen(function* () {
    const store = yield* Store;
    const folders = yield* Folders;
    const picker = yield* FolderPicker;
    const sessions = yield* SessionStore;
    const lock = yield* Semaphore.make(1);

    const key = (folder: string) => folderKey(folder, folders.platform);
    const folderName = (folder: string) => {
      const base = (folders.platform === 'win32' ? path.win32 : path.posix).basename(folder);
      return base === '' ? folder : base;
    };

    // A projects.json Spence cannot read is not something the renderer can act on.
    const read = store.readVersioned(projectsFile).pipe(
      Effect.map((file) => file.projects),
      Effect.orDie,
    );
    const write = (projects: ReadonlyArray<StoredProject>) =>
      store.writeVersioned(projectsFile, { projects });

    const toProject = (stored: StoredProject): Effect.Effect<Project> =>
      folders.exists(stored.path).pipe(
        Effect.map((exists): Project => ({
          id: stored.id,
          name: stored.name,
          path: stored.path,
          addedAt: stored.addedAt,
          lastUsedAt: stored.lastUsedAt,
          settings: stored.settings ?? {},
          folderMissing: !exists,
        })),
      );

    const findActive = (projects: ReadonlyArray<StoredProject>, id: ProjectId) =>
      Option.fromUndefinedOr(projects.find((p) => p.id === id && isActive(p))).pipe(
        Option.match({
          onNone: () => Effect.fail(notFound(id)),
          onSome: Effect.succeed,
        }),
      );

    const replace = (projects: ReadonlyArray<StoredProject>, next: StoredProject) =>
      projects.map((p) => (p.id === next.id ? next : p));

    /** Applies `change` to one active Project and stores it. */
    const update = (
      id: ProjectId,
      change: (project: StoredProject, now: number) => StoredProject,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const projects = yield* read;
          const project = yield* findActive(projects, id);
          const next = change(project, yield* Clock.currentTimeMillis);
          yield* write(replace(projects, next));
          return next;
        }),
      );

    /** The real path of a picked folder; none when cancelled or already gone. */
    const pickFolder = picker.pick.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: folders.realPath,
        }),
      ),
    );

    const list = read.pipe(
      Effect.flatMap((projects) => Effect.forEach(projects.filter(isActive), toProject)),
    );

    const addFolder = (folder: string) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const projects = yield* read;
            const now = yield* Clock.currentTimeMillis;
            const same = projects.find((p) => key(p.path) === key(folder));
            if (same !== undefined && isActive(same)) return yield* alreadyAdded(same);

            const { removedAt: _removedAt, ...revived } = same ?? {
              id: ProjectId.make(randomUUID()),
              name: folderName(folder),
              addedAt: now,
            };
            const next: StoredProject = { ...revived, path: folder, lastUsedAt: now };
            yield* write(same === undefined ? [...projects, next] : replace(projects, next));
            return next;
          }),
        )
        .pipe(Effect.flatMap(toProject));

    const add = Effect.fn('Projects.add')(function* () {
      const folder = yield* pickFolder;
      if (Option.isNone(folder)) return null;
      return yield* addFolder(folder.value);
    });

    const rename = Effect.fn('Projects.rename')(function* (id: ProjectId, name: string) {
      const next = yield* update(id, (project) => ({
        ...project,
        name: name.trim() === '' ? folderName(project.path) : name.trim(),
      }));
      return yield* toProject(next);
    });

    const remove = Effect.fn('Projects.remove')(function* (id: ProjectId) {
      yield* update(id, (project, now) => ({ ...project, removedAt: now }));
    });

    const locate = Effect.fn('Projects.locate')(function* (id: ProjectId) {
      yield* findActive(yield* read, id);
      const folder = yield* pickFolder;
      if (Option.isNone(folder)) return null;
      const moved = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const projects = yield* read;
          const project = yield* findActive(projects, id);
          // A folder never maps to two Project records: a removed Project still owns its folder (adding it revives it).
          const taken = projects.find((p) => p.id !== id && key(p.path) === key(folder.value));
          if (taken !== undefined) {
            return yield* isActive(taken) ? alreadyAdded(taken) : removedProjectFolder(taken);
          }
          yield* write(replace(projects, { ...project, path: folder.value }));
          const oldKey = key(project.path);
          yield* sessions.relocate((cwd) => key(cwd) === oldKey, folder.value);
          return { ...project, path: folder.value };
        }),
      );
      return yield* toProject(moved);
    });

    const check = Effect.fn('Projects.check')(function* (id: ProjectId) {
      return yield* toProject(yield* findActive(yield* read, id));
    });

    const setSettings = Effect.fn('Projects.setSettings')(function* (
      id: ProjectId,
      patch: ProjectSettingsPatch,
    ) {
      const next = yield* update(id, (project) => {
        const { settings: _settings, ...rest } = project;
        const settings = applyPatch(project.settings ?? {}, patch);
        return Object.keys(settings).length === 0 ? rest : { ...rest, settings };
      });
      return yield* toProject(next);
    });

    const touch = (id: ProjectId) =>
      update(id, (project, now) => ({ ...project, lastUsedAt: now })).pipe(
        Effect.asVoid,
        Effect.catchTag('ProjectsError', () => Effect.void),
      );

    return { list, add: add(), rename, remove, locate, check, setSettings, touch };
  }),
);

/**
 * Projects over `<userData>/spence/` and the real disk and folder picker. Provide this one layer wherever main needs
 * `Projects` (handlers, Sessions calling `touch`) so they share one instance.
 */
export const layerProjectsLive = layerProjects.pipe(
  Layer.provide(
    Layer.mergeAll(layerSessionStoreLive, layerStoreUserData, layerFolders, layerFolderPicker),
  ),
);
