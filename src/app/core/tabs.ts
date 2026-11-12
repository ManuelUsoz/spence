import { Injectable, computed, signal } from '@angular/core';
import type { ProjectId } from '../../shared/projects/projects.rpc';
import type { SessionId } from '../../shared/sessions/sessions.rpc';

/**
 * A Session open in the window. `session` is `null` for a draft: a new Session that is not kept until its first
 * Message, so it has a Tab but no stored Session yet.
 */
export interface Tab {
  /** Spence's own key for the Tab; a draft's stays the same when it becomes a kept Session. */
  readonly id: string;
  readonly projectId: ProjectId;
  readonly session: SessionId | null;
  /** The Session's title; `null` while untitled (a draft). */
  readonly title: string | null;
}

/** What a kept Session needs to open in a Tab. */
export interface OpenSession {
  readonly id: SessionId;
  readonly projectId: ProjectId;
  readonly title: string | null;
}

/**
 * The open Tabs, from any Project, and which one is active. Closing a Tab never stops its Session; closing a draft's
 * Tab forgets the draft.
 */
@Injectable({ providedIn: 'root' })
export class Tabs {
  private readonly _tabs = signal<ReadonlyArray<Tab>>([]);
  private readonly _activeId = signal<string | null>(null);
  private nextDraft = 1;

  readonly tabs = this._tabs.asReadonly();
  readonly activeId = this._activeId.asReadonly();
  readonly active = computed(() => this._tabs().find((tab) => tab.id === this._activeId()) ?? null);
  private readonly openSessions = computed(
    () => new Set(this._tabs().flatMap((tab) => (tab.session === null ? [] : [tab.session]))),
  );

  /** Activates the Session's Tab, opening one at the end of the strip if it has none. */
  open(session: OpenSession): Tab {
    const existing = this._tabs().find((tab) => tab.session === session.id);
    if (existing !== undefined) {
      this._activeId.set(existing.id);
      return existing;
    }
    const tab: Tab = {
      id: `session:${session.id}`,
      projectId: session.projectId,
      session: session.id,
      title: session.title,
    };
    this.add(tab);
    return tab;
  }

  /** Activates the Project's draft, starting one in a new Tab if it has none. */
  startDraft(projectId: ProjectId): Tab {
    const existing = this.draftOf(projectId);
    if (existing !== null) {
      this._activeId.set(existing.id);
      return existing;
    }
    const tab: Tab = { id: `draft:${this.nextDraft}`, projectId, session: null, title: null };
    this.nextDraft += 1;
    this.add(tab);
    return tab;
  }

  /** The Project's draft Tab, if it has one. */
  draftOf(projectId: ProjectId): Tab | null {
    return this._tabs().find((tab) => tab.session === null && tab.projectId === projectId) ?? null;
  }

  isOpen(session: SessionId): boolean {
    return this.openSessions().has(session);
  }

  activate(id: string): void {
    if (this._tabs().some((tab) => tab.id === id)) this._activeId.set(id);
  }

  /** Closes the Tab; when it was active, the Tab that takes its place in the strip becomes active. */
  close(id: string): void {
    const tabs = this._tabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const rest = tabs.filter((tab) => tab.id !== id);
    this._tabs.set(rest);
    if (this._activeId() === id) {
      this._activeId.set((rest[index] ?? rest[index - 1])?.id ?? null);
    }
  }

  private add(tab: Tab): void {
    this._tabs.update((tabs) => [...tabs, tab]);
    this._activeId.set(tab.id);
  }
}
