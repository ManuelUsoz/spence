import { AgentsRpcs } from '../agents/agents.rpc';
import { FilesRpcs } from '../files/files.rpc';
import { InboxRpcs } from '../messaging/messaging.rpc';
import { ProjectsRpcs } from '../projects/projects.rpc';
import { RemoteInfoRpcs } from '../remote/remote.rpc';
import { SessionsRpcs } from '../sessions/sessions.rpc';
import { SourceControlRpcs } from '../source-control/source-control.rpc';
import { WorktreesRpcs } from '../worktrees/worktrees.rpc';

/**
 * The calls that act on one Device's data: the window sends them to any Device by naming it in the
 * `DEVICE_SCOPE_HEADER`, and main routes them (no header: the Local device).
 */
export const DeviceScopedRpcs = ProjectsRpcs.merge(SessionsRpcs)
  .merge(FilesRpcs)
  .merge(WorktreesRpcs)
  .merge(SourceControlRpcs)
  .merge(AgentsRpcs);

/**
 * The allow-list a Device serves to its Paired devices: groups selected from `DesktopRpcs`, never checks inside
 * handlers. Tabs, Links, Devices, AppInfo and Settings (UI preferences) are left out, so a Remote device cannot
 * reach them. Execution-only Settings join as their own group when they become editable remotely. `InboxRpcs` is the
 * receiving side of Cross-device messages; the window sends them through the Local-only `MessagingRpcs` instead.
 */
export const RemoteRpcs = RemoteInfoRpcs.merge(DeviceScopedRpcs).merge(InboxRpcs);
