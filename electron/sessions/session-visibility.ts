import { Context, Effect, Layer, Stream, SubscriptionRef } from 'effect';
import type { WorkspaceState } from '../../src/shared/tabs/tabs.rpc';
import {
  visibleSessionTargets,
  type VisibleSessionTarget,
} from '../../src/shared/tabs/workspace-layout';

interface VisibilityState {
  readonly workspaceVisible: ReadonlyArray<VisibleSessionTarget>;
  readonly obscured: boolean;
}

const effectiveTargets = (state: VisibilityState): ReadonlyArray<VisibleSessionTarget> =>
  state.obscured ? [] : state.workspaceVisible;

export interface SessionVisibilityShape {
  /** Updates visible Sessions from the full workspace (Local and Remote Projects) and optional obscured flag. */
  readonly setWorkspace: (workspace: WorkspaceState, obscured?: boolean) => Effect.Effect<void>;
  /** Updates whether full-Tab overlays (`Changes` / `Workers`) or global Settings obscure the active Tab. */
  readonly setObscured: (obscured: boolean) => Effect.Effect<void>;
  /** Currently visible Session targets (`[]` when obscured). */
  readonly current: Effect.Effect<ReadonlyArray<VisibleSessionTarget>>;
  /** Stream of visible Session target snapshots as workspace or obscured state changes. */
  readonly changes: Stream.Stream<ReadonlyArray<VisibleSessionTarget>>;
}

/**
 * Authoritative main-process view of which Local and Remote Sessions are currently visible on screen
 * in the active Project's active Tab, accounting for full-Tab overlays and global Settings.
 */
export class SessionVisibility extends Context.Service<SessionVisibility, SessionVisibilityShape>()(
  'sessions/SessionVisibility',
) {}

export const layerSessionVisibility = Layer.effect(
  SessionVisibility,
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<VisibilityState>({
      workspaceVisible: [],
      obscured: false,
    });

    return SessionVisibility.of({
      setWorkspace: (workspace, obscured) =>
        SubscriptionRef.update(ref, (prev) => ({
          workspaceVisible: visibleSessionTargets(workspace),
          obscured: obscured ?? prev.obscured,
        })),
      setObscured: (obscured) =>
        SubscriptionRef.update(ref, (prev) =>
          prev.obscured === obscured ? prev : { ...prev, obscured },
        ),
      current: SubscriptionRef.get(ref).pipe(Effect.map(effectiveTargets)),
      changes: SubscriptionRef.changes(ref).pipe(Stream.map(effectiveTargets)),
    });
  }),
);
