import { AgentsRpcs } from '../agents/agents.rpc';
import { AppInfoRpcs } from '../app-info/app-info.rpc';
import { BrowserRpcs } from '../browser/browser.rpc';
import { FilesRpcs } from '../files/files.rpc';
import { LinksRpcs } from '../links/links.rpc';
import { ProjectsRpcs } from '../projects/projects.rpc';
import { SessionsRpcs } from '../sessions/sessions.rpc';
import { SettingsRpcs } from '../settings/settings.rpc';
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
  .merge(FilesRpcs);
