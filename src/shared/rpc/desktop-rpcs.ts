import { AgentsRpcs } from '../agents/agents.rpc';
import { AppInfoRpcs } from '../app-info/app-info.rpc';
import { AssetsRpcs } from '../assets/assets.rpc';
import { BrowserRpcs } from '../browser/browser.rpc';
import { DevicesRpcs } from '../devices/devices.rpc';
import { FilesRpcs } from '../files/files.rpc';
import { FoldersRpcs } from '../folders/folders.rpc';
import { LinksRpcs } from '../links/links.rpc';
import { MessagingRpcs } from '../messaging/messaging.rpc';
import { ProjectsRpcs } from '../projects/projects.rpc';
import { RemoteInfoRpcs } from '../remote/remote.rpc';
import { SessionsRpcs } from '../sessions/sessions.rpc';
import { ExecutionSettingsRpcs, SettingsRpcs } from '../settings/settings.rpc';
import { SourceControlRpcs } from '../source-control/source-control.rpc';
import { TabsRpcs } from '../tabs/tabs.rpc';
import { WorktreesRpcs } from '../worktrees/worktrees.rpc';

/** The single RPC contract between renderer and main. Merge new domain groups here. */
export const DesktopRpcs = AppInfoRpcs.merge(AgentsRpcs)
  .merge(BrowserRpcs)
  .merge(ProjectsRpcs)
  .merge(SessionsRpcs)
  .merge(SettingsRpcs)
  .merge(TabsRpcs)
  .merge(LinksRpcs)
  .merge(SourceControlRpcs)
  .merge(WorktreesRpcs)
  .merge(FilesRpcs)
  .merge(DevicesRpcs)
  .merge(RemoteInfoRpcs)
  .merge(FoldersRpcs)
  .merge(ExecutionSettingsRpcs)
  .merge(AssetsRpcs)
  .merge(MessagingRpcs);
