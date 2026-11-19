import { computed, Injectable, signal, type Signal } from '@angular/core';
import type { SessionId } from '../../shared/sessions/sessions.rpc';

/** The Session operations a Panel header's Session actions menu offers. */
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

/** What a Panel header shows for a Worker's Session: where it came from and what it is doing. */
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

/** What a mounted Session lends its Panel header: live context, the actions it can run now, and how to run them. */
export interface SessionToolbarEntry {
  /** Set only while the Session is a Worker. */
  readonly worker?: Signal<WorkerCrumb | null>;
  readonly sessionId: Signal<string>;
  readonly context: Signal<SessionToolbarContext>;
  readonly actions: Signal<ReadonlyArray<SessionToolbarAction>>;
  readonly run: (operation: SessionOperation) => void;
}

/**
 * The seam between each Panel header and its mounted Session view. Features never import each other, so each
 * mounted Session view publishes its live actions here keyed by `SessionId` and the matching Panel header reads them.
 */
@Injectable({ providedIn: 'root' })
export class SessionToolbar {
  private readonly published = signal<ReadonlyArray<SessionToolbarEntry>>([]);

  private readonly bySession = computed((): ReadonlyMap<string, SessionToolbarEntry> => {
    const entries = new Map<string, SessionToolbarEntry>();
    for (const entry of this.published()) {
      entries.set(entry.sessionId(), entry);
    }
    return entries;
  });

  /** Publishes `entry` keyed by its reactive `sessionId()`; the returned function withdraws it. */
  publish(entry: SessionToolbarEntry): () => void {
    this.published.update((list) => [...list.filter((item) => item !== entry), entry]);
    return () => {
      this.published.update((list) => list.filter((item) => item !== entry));
    };
  }

  /** Returns the published entry for `sessionId`, or `null` when none is mounted for it. */
  entryFor(sessionId: SessionId | null): SessionToolbarEntry | null {
    if (sessionId === null) return null;
    return this.bySession().get(sessionId) ?? null;
  }
}
