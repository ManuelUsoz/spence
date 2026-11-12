import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

/** A point in time, as milliseconds since the epoch. Every domain that records time uses it. */
export const Timestamp = Schema.Number.annotate({ identifier: 'Timestamp' });
export type Timestamp = typeof Timestamp.Type;

/** Identifies a Project; stored on every Session. Stays the same when a removed Project is added again. */
export const ProjectId = Schema.String.pipe(Schema.brand('ProjectId')).annotate({
  identifier: 'ProjectId',
});
export type ProjectId = typeof ProjectId.Type;

/** How much a Session may do without asking. */
export const PermissionMode = Schema.Literals(['auto', 'ask']).annotate({
  identifier: 'PermissionMode',
});
export type PermissionMode = typeof PermissionMode.Type;

/** A Project's overrides of Spence's Settings; a key it does not set comes from Settings. */
export const ProjectSettings = Schema.Struct({
  defaultPermissionMode: Schema.optionalKey(PermissionMode),
}).annotate({ identifier: 'ProjectSettings' });
export type ProjectSettings = typeof ProjectSettings.Type;

/** A sparse change to Project settings: a missing key is kept, `null` clears it. */
export const ProjectSettingsPatch = Schema.Struct({
  defaultPermissionMode: Schema.optionalKey(Schema.NullOr(PermissionMode)),
}).annotate({ identifier: 'ProjectSettingsPatch' });
export type ProjectSettingsPatch = typeof ProjectSettingsPatch.Type;

/** An active Project as the renderer sees it. */
export const Project = Schema.Struct({
  id: ProjectId,
  name: Schema.String,
  /** The folder's real path. */
  path: Schema.String,
  addedAt: Timestamp,
  /** Set on add and when a Turn starts in any of its Sessions. */
  lastUsedAt: Timestamp,
  settings: ProjectSettings,
  /** The folder was not found the last time it was checked. */
  folderMissing: Schema.Boolean,
}).annotate({ identifier: 'Project' });
export type Project = typeof Project.Type;

export class ProjectsError extends Schema.TaggedError<ProjectsError>()('ProjectsError', {
  /**
   * `AlreadyAdded`: the folder is an active Project, named in `detail`. `RemovedProjectFolder`: the folder belongs to a
   * removed Project, named in `detail`; adding the folder brings that Project back. `NotFound`: no active Project has
   * the id.
   */
  reason: Schema.Literals(['AlreadyAdded', 'RemovedProjectFolder', 'NotFound']),
  detail: Schema.String,
}) {}

const ById = { id: ProjectId };

export const ProjectsRpcs = RpcGroup.make(
  /** Active Projects, each folder checked now. */
  Rpc.make('Projects.list', { success: Schema.Array(Project) }),
  /** Opens the folder picker; `null` when the user cancels. */
  Rpc.make('Projects.add', { success: Schema.NullOr(Project), error: ProjectsError }),
  /** A blank name falls back to the folder name. */
  Rpc.make('Projects.rename', {
    payload: { ...ById, name: Schema.String },
    success: Project,
    error: ProjectsError,
  }),
  /** Forgets the Project; its Sessions are kept and come back if the folder is added again. */
  Rpc.make('Projects.remove', { payload: ById, error: ProjectsError }),
  /** Opens the folder picker to point the Project at its moved folder; `null` when the user cancels. */
  Rpc.make('Projects.locate', {
    payload: ById,
    success: Schema.NullOr(Project),
    error: ProjectsError,
  }),
  /** Checks the folder now; call on Tab activation and before a new Session. */
  Rpc.make('Projects.check', { payload: ById, success: Project, error: ProjectsError }),
  Rpc.make('Projects.setSettings', {
    payload: { ...ById, patch: ProjectSettingsPatch },
    success: Project,
    error: ProjectsError,
  }),
);
