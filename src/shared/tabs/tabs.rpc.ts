import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { ProjectId } from '../projects/projects.rpc';
import { SessionId, SessionTitle } from '../sessions/sessions.rpc';

/** A Tab open when Spence last ran, with what the strip needs to show it before its Session is followed. */
export const RestoredTab = Schema.Struct({
  id: SessionId,
  projectId: ProjectId,
  title: SessionTitle,
}).annotate({ identifier: 'RestoredTab' });
export type RestoredTab = typeof RestoredTab.Type;

export const RestoredTabs = Schema.Struct({
  /** In strip order. */
  tabs: Schema.Array(RestoredTab),
  /** The Tab that was active, if it is among `tabs`. */
  active: Schema.optionalKey(SessionId),
}).annotate({ identifier: 'RestoredTabs' });
export type RestoredTabs = typeof RestoredTabs.Type;

/**
 * The window's Tabs as main sees them. Main decides from them when a Session's Agent connects (only for a shown Tab)
 * and lets go (no Tab and no running Turn), and remembers them for the next launch.
 */
export const TabsRpcs = RpcGroup.make(
  /** The Tabs to open at launch; only the active one connects, once it is shown. */
  Rpc.make('Tabs.restore', { success: RestoredTabs }),
  /** The Sessions open in Tabs (drafts included), in strip order, and the active one. Sent on every change. */
  Rpc.make('Tabs.update', {
    payload: { open: Schema.Array(SessionId), active: Schema.optionalKey(SessionId) },
  }),
);
