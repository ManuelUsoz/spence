import { AgentsRpcs } from '../agents/agents.rpc';
import { FilesRpcs } from '../files/files.rpc';
import { ProjectsRpcs } from '../projects/projects.rpc';
import { RemoteInfoRpcs } from '../remote/remote.rpc';
import { SessionsRpcs } from '../sessions/sessions.rpc';
import { SourceControlRpcs } from '../source-control/source-control.rpc';
import { WorktreesRpcs } from '../worktrees/worktrees.rpc';

/**
 * The allow-list a Device serves to its Paired devices: groups selected from `DesktopRpcs`, never checks inside
 * handlers. Tabs, Links, Devices, AppInfo and Settings (UI preferences) are left out, so a Remote device cannot
 * reach them. Execution-only Settings join as their own group when they become editable remotely.
 */
export const RemoteRpcs = RemoteInfoRpcs.merge(ProjectsRpcs)
  .merge(SessionsRpcs)
  .merge(FilesRpcs)
  .merge(WorktreesRpcs)
  .merge(SourceControlRpcs)
  .merge(AgentsRpcs);
