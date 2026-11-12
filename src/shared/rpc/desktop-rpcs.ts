import { AgentsRpcs } from '../agents/agents.rpc';
import { AppInfoRpcs } from '../app-info/app-info.rpc';
import { SettingsRpcs } from '../settings/settings.rpc';

/** The single RPC contract between renderer and main. Merge new domain groups here. */
export const DesktopRpcs = AppInfoRpcs.merge(AgentsRpcs).merge(SettingsRpcs);
