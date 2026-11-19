import type { Effect } from 'effect';
import type { PermissionMode } from '../../src/shared/projects/projects.rpc';
import type { ChainLink, SessionId } from '../../src/shared/sessions/sessions.rpc';
import type { ToolOutcome } from './delegation-server';

/** What a cross-device send asks the user (or the Permission mode) to allow, as the sending Session shows it. */
export type CrossDeviceAsk =
  | { readonly kind: 'send'; readonly session: string; readonly device: string }
  | { readonly kind: 'start'; readonly project: string; readonly device: string };

/**
 * The Session whose Agent calls a cross-device tool, as `Sessions` hands it over: who it is, where its running Turn
 * came from (hops and chain), and how to ask before sending.
 */
export interface AgentCaller {
  readonly sessionId: SessionId;
  readonly title: string;
  readonly projectName: string;
  /** Session-to-Session hops behind the running Turn's Message; 0 for the user's own. */
  readonly hops: number;
  /** The Sessions the running Turn's Message came through (a Cross-device message's chain); empty otherwise. */
  readonly chain: ReadonlyArray<ChainLink>;
  /** The sending Session's Permission mode now: shown to the receiver, never applied there. */
  readonly permissionMode: PermissionMode;
  /**
   * Shows the send as a Step in the sending Session and, under Ask, raises a Permission request for it; Auto allows it
   * at once. True once allowed; a denied, cancelled or ended Turn is false.
   */
  readonly confirm: (ask: CrossDeviceAsk) => Effect.Effect<boolean>;
}

/**
 * The four Spence-owned cross-device tools an Agent gets (`list_targets`, `send_message` to a target handle,
 * `start_session`, `await_result`). Implemented over the Devices and Inbox in `electron/messaging`, which are built
 * after `Sessions`; attached to it at start (`Sessions.attachCrossDeviceTools`). Targets are opaque handles: an Agent
 * never sees addresses, tokens, ids or ACP.
 */
export interface CrossDeviceTools {
  readonly listTargets: (caller: AgentCaller) => Effect.Effect<ToolOutcome>;
  readonly sendMessage: (
    caller: AgentCaller,
    input: { readonly to: string; readonly text: string },
  ) => Effect.Effect<ToolOutcome>;
  readonly startSession: (
    caller: AgentCaller,
    input: { readonly project: string; readonly text: string },
  ) => Effect.Effect<ToolOutcome>;
  readonly awaitResult: (
    caller: AgentCaller,
    input: { readonly handle: string; readonly timeoutSeconds: number },
  ) => Effect.Effect<ToolOutcome>;
  /** Whether `to` is a target handle this caller was given, so `send_message` goes to another Device. */
  readonly isTarget: (caller: AgentCaller, to: string) => boolean;
}
