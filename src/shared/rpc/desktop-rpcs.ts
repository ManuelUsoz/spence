import { AgentsRpcs } from '../agents/agents.rpc';
import { AppInfoRpcs } from '../app-info/app-info.rpc';
import { LinksRpcs } from '../links/links.rpc';
import { ProjectsRpcs } from '../projects/projects.rpc';
import { SessionsRpcs } from '../sessions/sessions.rpc';
import { SettingsRpcs } from '../settings/settings.rpc';
import { TabsRpcs } from '../tabs/tabs.rpc';

/** The single RPC contract between renderer and main. Merge new domain groups here. */
export const DesktopRpcs = AppInfoRpcs.merge(AgentsRpcs)
  .merge(ProjectsRpcs)
  .merge(SessionsRpcs)
  .merge(SettingsRpcs)
  .merge(TabsRpcs)
  .merge(LinksRpcs);
