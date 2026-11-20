import { Injectable, signal, type Signal } from '@angular/core';
import type { SessionId } from '../../shared/sessions/sessions.rpc';

/** The Session operations the top bar's Session actions menu offers. */
export type SessionOperation = 'Compact' | 'Clear' | 'Coordinate' | 'Switch Agent';

export interface SessionToolbarAction {
  readonly id: 'compact' | 'clear' | 'coordinate' | 'switch-agent';
  readonly operation: SessionOperation;
  readonly label: string;
  /** The slash command that does the same, shown as a hint. */
  readonly command?: string;
  readonly disabled: boolean;
  /** Why the action is unavailable right now. */
  readonly reason?: string;
}

/** What the menu shows about context use: a line of text and, when measurable, how full it is (0 to 1). */
export interface SessionToolbarContext {
  readonly label: string;
  readonly fraction: number | null;
}

/** What the top bar shows for a Worker's Session: where it came from and what it is doing. */
export interface WorkerCrumb {
  readonly parentId: SessionId;
  readonly agentId: string;
  readonly agentName: string;
  /** The Model's display name; null when the Agent has none. */
  readonly modelName: string | null;
  /** A Turn is running in the Worker. */
  readonly working: boolean;
  /** The nearest ancestor (the Parent first) waiting for Permission, if any. */
  readonly waitingAncestorId: SessionId | null;
}

/** What the open Session lends the top bar: live context, the actions it can run now, and how to run them. */
export interface SessionToolbarEntry {
  /** Set only while the open Session is a Worker. */
  readonly worker?: Signal<WorkerCrumb | null>;
  readonly sessionId: Signal<string>;
  readonly context: Signal<SessionToolbarContext>;
  readonly actions: Signal<ReadonlyArray<SessionToolbarAction>>;
  readonly run: (operation: SessionOperation) => void;
}

/**
 * The seam between the shell's top bar and the Session view. Features never import each other, so the view
 * publishes its live Session actions here and the top bar renders and runs them.
 */
@Injectable({ providedIn: 'root' })
export class SessionToolbar {
  private readonly current = signal<SessionToolbarEntry | null>(null);

  readonly entry = this.current.asReadonly();

  /** Makes `entry` the open Session's; the returned function withdraws it (unless another view took over). */
  publish(entry: SessionToolbarEntry): () => void {
    this.current.set(entry);
    return () => {
      if (this.current() === entry) this.current.set(null);
    };
  }
}
