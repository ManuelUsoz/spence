import { inject, Injectable, computed, signal } from '@angular/core';
import { Effect, Exit } from 'effect';
import type { ProjectId } from '../../shared/projects/projects.rpc';
import type { SessionId, SessionTitle } from '../../shared/sessions/sessions.rpc';
import type { RestoredTabs } from '../../shared/tabs/tabs.rpc';
import { DesktopApi } from './desktop-api';
import { EffectRuntime } from './effect-runtime';

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

const restoreTabs = Effect.fnUntraced(function* () {
  const api = yield* DesktopApi;
  return yield* api['Tabs.restore']();
});

const updateTabs = (open: ReadonlyArray<SessionId>, active: SessionId | undefined) =>
  Effect.fnUntraced(function* () {
    const api = yield* DesktopApi;
    yield* api['Tabs.update']({ open, ...(active === undefined ? {} : { active }) });
  });

/**
 * The open Tabs, from any Project, and which one is active. Closing a Tab never stops its Session; closing a draft's
 * Tab forgets the draft.
 */
@Injectable({ providedIn: 'root' })
export class Tabs {
  private readonly runtime = inject(EffectRuntime);
  private readonly _tabs = signal<ReadonlyArray<Tab>>([]);
  private readonly _activeId = signal<string | null>(null);
  private readonly _sessionsVersion = signal(0);
  private nextDraft = 1;

  readonly tabs = this._tabs.asReadonly();
  readonly activeId = this._activeId.asReadonly();
  readonly sessionsVersion = this._sessionsVersion.asReadonly();
  readonly active = computed(() => this._tabs().find((tab) => tab.id === this._activeId()) ?? null);
  private readonly openSessions = computed(
    () => new Set(this._tabs().flatMap((tab) => (tab.session === null ? [] : [tab.session]))),
  );

  constructor() {
    void this.runtime.run(restoreTabs()).then((exit) => {
      if (Exit.isSuccess(exit)) this.setRestored(exit.value);
    });
  }

  /** Activates the Session's Tab, opening one at the end of the strip if it has none. */
  open(session: OpenSession): Tab {
    const existing = this._tabs().find((tab) => tab.session === session.id);
    if (existing !== undefined) {
      this._activeId.set(existing.id);
      this.reportTabs();
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
      this.reportTabs();
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

  markSessionsChanged(): void {
    this._sessionsVersion.update((v) => v + 1);
  }

  /** A draft becomes a kept Session when its first Message is sent. Also notifies Session listeners on prompt. */
  keep(id: string, session: SessionId): void {
    this.markSessionsChanged();
    if (!this._tabs().some((tab) => tab.id === id && tab.session === null)) return;
    this._tabs.update((tabs) => tabs.map((tab) => (tab.id === id ? { ...tab, session } : tab)));
    this.reportTabs();
  }

  activate(id: string): void {
    if (this._tabs().some((tab) => tab.id === id)) {
      this._activeId.set(id);
      this.reportTabs();
    }
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
    this.reportTabs();
  }

  /** Closes any Tab showing `sessionId`. */
  closeSession(sessionId: SessionId): void {
    const tab = this._tabs().find((candidate) => candidate.session === sessionId);
    if (tab !== undefined) this.close(tab.id);
  }

  /** Closes all Tabs belonging to `projectId`. */
  closeProject(projectId: ProjectId): void {
    const tabs = this._tabs();
    if (!tabs.some((tab) => tab.projectId === projectId)) return;
    const rest = tabs.filter((tab) => tab.projectId !== projectId);
    this._tabs.set(rest);
    if (!rest.some((tab) => tab.id === this._activeId())) {
      this._activeId.set(rest[0]?.id ?? null);
    }
    this.reportTabs();
  }

  private setRestored(restored: RestoredTabs): void {
    const tabs = restored.tabs.map((tab): Tab => ({
      id: tabId(tab.id),
      projectId: tab.projectId,
      session: tab.id,
      title: titleOf(tab.title),
    }));
    this._tabs.set(tabs);
    const active = restored.active;
    if (active !== undefined) {
      const tab = tabs.find((candidate) => candidate.session === active);
      this._activeId.set(tab?.id ?? tabs[0]?.id ?? null);
    } else {
      this._activeId.set(tabs[0]?.id ?? null);
    }
    this.reportTabs();
  }

  private add(tab: Tab): void {
    this._tabs.update((tabs) => [...tabs, tab]);
    this._activeId.set(tab.id);
    this.reportTabs();
  }

  private reportTabs(): void {
    const open = this._tabs()
      .map((tab) => tab.session)
      .filter((id): id is SessionId => id !== null);
    const active = this.active()?.session ?? undefined;
    void this.runtime.run(updateTabs(open, active)());
  }
}

const titleOf = (title: SessionTitle): string | null => title.user ?? title.auto ?? null;

const tabId = (sessionId: SessionId): string => `session:${sessionId}`;
