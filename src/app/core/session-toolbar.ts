import { Injectable, signal, type Signal } from '@angular/core';

/** The Session operations the top bar's Session actions menu offers. */
export type SessionOperation = 'Compact' | 'Clear' | 'Switch Agent';

export interface SessionToolbarAction {
  readonly id: 'compact' | 'clear' | 'switch-agent';
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

/** What the open Session lends the top bar: live context, the actions it can run now, and how to run them. */
export interface SessionToolbarEntry {
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
