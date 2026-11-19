import { AgentsRpcs } from '../agents/agents.rpc';
import { FilesRpcs } from '../files/files.rpc';
import { FoldersRpcs } from '../folders/folders.rpc';
import { ProjectsOnDeviceRpcs } from '../projects/projects.rpc';
import { RemoteInfoRpcs } from '../remote/remote.rpc';
import { SessionsRpcs } from '../sessions/sessions.rpc';
import { ExecutionSettingsRpcs } from '../settings/settings.rpc';
import { SourceControlRpcs } from '../source-control/source-control.rpc';
import { WorktreesRpcs } from '../worktrees/worktrees.rpc';

/**
 * The calls that act on one Device's data: the window sends them to any Device by naming it in the
 * `DEVICE_SCOPE_HEADER`, and main routes them (no header: the Local device).
 */
export const DeviceScopedRpcs = ProjectsOnDeviceRpcs.merge(SessionsRpcs)
  .merge(FilesRpcs)
  .merge(WorktreesRpcs)
  .merge(SourceControlRpcs)
  .merge(AgentsRpcs)
  .merge(FoldersRpcs)
  .merge(ExecutionSettingsRpcs);

/**
 * The allow-list a Device serves to its Paired devices: groups selected from `DesktopRpcs`, never checks inside
 * handlers. Tabs, Links, Devices, AppInfo, Settings (UI preferences) and the native folder picker (`Projects.add`,
 * `Projects.locate`) are left out, so a Remote device cannot reach them; its execution Settings are reachable
 * (`ExecutionSettingsRpcs`).
 */
export const RemoteRpcs = RemoteInfoRpcs.merge(DeviceScopedRpcs);
