import { inject, Injectable, InjectionToken, type Type } from '@angular/core';
import type { ProjectId } from '../../shared/projects/projects.rpc';
import type { SessionId } from '../../shared/sessions/sessions.rpc';
import type { PaneId, WorkspacePanel } from '../../shared/tabs/tabs.rpc';

/** Context supplied when rendering a Panel body or resolving its header metadata. */
export interface PanelRenderContext {
  readonly panel: WorkspacePanel;
  readonly paneId?: PaneId | null;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly focused: boolean;
}

/** Header display metadata computed for a mounted Panel. */
export interface PanelHeaderMeta {
  readonly title: string;
  /** Whether `title` is a placeholder (shown muted, e.g. untitled "New Session"). */
  readonly untitled?: boolean;
}

/**
 * Registration entry for a Panel type (`Session`, `Changes`, `Workers`, or future custom Panel types).
 * Features never import each other; `app.config.ts` provides definitions via `PANEL_DEFINITION`.
 */
export interface PanelDefinition {
  /** Unique Panel kind key matching `panel.spec._tag` (e.g. `'Session'`, `'Changes'`, `'Workers'`). */
  readonly kind: string;
  /** Standalone component rendered inside `PanelFrame` via `NgComponentOutlet`. */
  readonly component: Type<unknown>;
  /** Static fallback title used when a Panel title is requested outside a render context. */
  readonly defaultTitle?: string;
  /** Computes live header metadata for a rendered Panel; `resolveSessionTitle` resolves Session titles reactively. */
  readonly headerMeta?: (
    context: PanelRenderContext,
    resolveSessionTitle: (sessionId: SessionId) => string | null,
  ) => PanelHeaderMeta;
  /** Maps `PanelRenderContext` to `NgComponentOutlet` inputs; defaults to `{ panel, projectId, projectName, focused }`. */
  readonly inputs?: (context: PanelRenderContext) => Readonly<Record<string, unknown>>;
}

/** Multi-provider token for registering Panel definitions into `PanelRegistry`. */
export const PANEL_DEFINITION = new InjectionToken<PanelDefinition>('PANEL_DEFINITION');

/**
 * Extensible registry mapping Panel kind strings to their component and header metadata definitions.
 * New Panel types can be added via `PANEL_DEFINITION` without modifying Tab, Pane, or Stack models.
 */
@Injectable({ providedIn: 'root' })
export class PanelRegistry {
  private readonly byKind: ReadonlyMap<string, PanelDefinition>;

  constructor() {
    const injected: PanelDefinition | ReadonlyArray<PanelDefinition> | null = inject(
      PANEL_DEFINITION,
      { optional: true },
    );
    const definitions = injected === null ? [] : Array.isArray(injected) ? injected : [injected];
    const map = new Map<string, PanelDefinition>();
    for (const definition of definitions) {
      map.set(definition.kind, definition);
    }
    this.byKind = map;
  }

  /** Returns the registered `PanelDefinition` for `kind`, if any. */
  get(kind: string): PanelDefinition | undefined {
    return this.byKind.get(kind);
  }

  /** Returns `true` if a `PanelDefinition` is registered for `kind`. */
  has(kind: string): boolean {
    return this.byKind.has(kind);
  }

  /** Returns all registered Panel kind keys in registration order. */
  kinds(): ReadonlyArray<string> {
    return [...this.byKind.keys()];
  }
}
