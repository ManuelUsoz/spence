import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { DeviceId } from '../devices/devices.rpc';
import { ProjectId } from '../projects/projects.rpc';
import { Attention, SessionId, SessionTitle } from '../sessions/sessions.rpc';

/** A Tab open when Spence last ran, with what the strip needs to show it before its Session is followed. */
export const RestoredTab = Schema.Struct({
  id: SessionId,
  projectId: ProjectId,
  title: SessionTitle,
  draft: Schema.optionalKey(Schema.Boolean),
  attention: Schema.optionalKey(Attention),
  running: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'RestoredTab' });
export type RestoredTab = typeof RestoredTab.Type;

/**
 * A Remote Session's Tab as the viewer remembers it: only what the strip needs, never its Transcript (that stays on
 * the Device it runs on). Restored Offline until the Device connects.
 */
export const RemoteTabStub = Schema.Struct({
  deviceId: DeviceId,
  /** The Session, or for a draft the Session the Device started for it. */
  sessionId: SessionId,
  projectId: ProjectId,
  /** `null` while untitled. */
  title: Schema.NullOr(Schema.String),
  /** A draft: a Session not kept until its first Message. One that vanished meanwhile starts over. */
  draft: Schema.optionalKey(Schema.Boolean),
  /** Its place in the whole strip, Local Tabs included. */
  index: Schema.Int,
}).annotate({ identifier: 'RemoteTabStub' });
export type RemoteTabStub = typeof RemoteTabStub.Type;

/** The Remote Sessions' Tabs, in strip order, and the active one if it is among them. */
export const RemoteTabs = Schema.Struct({
  tabs: Schema.Array(RemoteTabStub),
  active: Schema.optionalKey(SessionId),
}).annotate({ identifier: 'RemoteTabs' });
export type RemoteTabs = typeof RemoteTabs.Type;

export const RestoredTabs = Schema.Struct({
  /** In strip order. */
  tabs: Schema.Array(RestoredTab),
  /** The Tab that was active, if it is among `tabs`. */
  active: Schema.optionalKey(SessionId),
  /** Remote Sessions' Tabs, each at its `index` in the strip. */
  remote: Schema.optionalKey(RemoteTabs),
}).annotate({ identifier: 'RestoredTabs' });
export type RestoredTabs = typeof RestoredTabs.Type;

/** A request from main to open or activate a Session's Tab (e.g. from clicking an OS notification). */
export const TabActivation = Schema.Struct({
  /** The Remote device the Session runs on; absent for a Local Session. */
  device: Schema.optionalKey(DeviceId),
  sessionId: SessionId,
  projectId: ProjectId,
  title: SessionTitle,
}).annotate({ identifier: 'TabActivation' });
export type TabActivation = typeof TabActivation.Type;

/**
 * The window's Tabs as main sees them. Main decides from them when a Session's Agent connects (only for a shown Tab)
 * and lets go (no Tab and no running Turn), and remembers them for the next launch.
 */
export const TabsRpcs = RpcGroup.make(
  /** The Tabs to open at launch; only the active one connects, once it is shown. */
  Rpc.make('Tabs.restore', { success: RestoredTabs }),
  /**
   * The Sessions open in Tabs (drafts included), in strip order, and the active one. Sent on every change. Remote
   * Sessions' Tabs come apart, as stubs: main only remembers them, it never connects them.
   */
  Rpc.make('Tabs.update', {
    payload: {
      open: Schema.Array(SessionId),
      active: Schema.optionalKey(SessionId),
      remote: Schema.optionalKey(RemoteTabs),
    },
  }),
  /** Streams Tab activation requests from main (e.g. OS notification clicks). */
  Rpc.make('Tabs.activations', { success: TabActivation, stream: true }),
);
