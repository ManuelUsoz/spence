import { DestroyRef, inject, Injectable, computed, signal } from '@angular/core';
import { Effect, Exit, Schedule, Stream } from 'effect';
import type { ProjectId } from '../../shared/projects/projects.rpc';
import type {
  Attention,
  LiveState,
  SessionChange,
  SessionId,
  SessionTitle,
} from '../../shared/sessions/sessions.rpc';
import type { RestoredTabs, TabActivation } from '../../shared/tabs/tabs.rpc';
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
  /** The Session main created for an unprompted draft, if started yet. */
  readonly draftSession?: SessionId;
  /** The Session's title; `null` while untitled (a draft). */
  readonly title: string | null;
  readonly attention?: Attention;
  readonly running?: boolean;
}

/** What a kept Session needs to open in a Tab. */
export interface OpenSession {
  readonly id: SessionId;
  readonly projectId: ProjectId;
  readonly title: string | null;
  readonly attention?: Attention;
  readonly running?: boolean;
}

const RESUBSCRIBE_AFTER = '500 millis';

const restoreTabs = Effect.fnUntraced(function* () {
  const api = yield* DesktopApi;
  return yield* api['Tabs.restore']();
});

const updateTabs = (open: ReadonlyArray<SessionId>, active: SessionId | undefined) =>
  Effect.fnUntraced(function* () {
    const api = yield* DesktopApi;
    yield* api['Tabs.update']({ open, ...(active === undefined ? {} : { active }) });
  });

const followChanges = (onChange: (change: SessionChange) => void) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Session.changes']().pipe(
      Stream.runForEach((change) => Effect.sync(() => onChange(change))),
    );
  }).pipe(Effect.retry(Schedule.spaced(RESUBSCRIBE_AFTER)));

const followActivations = (onActivation: (activation: TabActivation) => void) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Tabs.activations']().pipe(
      Stream.runForEach((activation) => Effect.sync(() => onActivation(activation))),
    );
  }).pipe(Effect.retry(Schedule.spaced(RESUBSCRIBE_AFTER)));

/**
 * The open Tabs, from any Project, and which one is active. Closing a Tab never stops its Session; closing a draft's
 * Tab forgets the draft.
 */
@Injectable({ providedIn: 'root' })
export class Tabs {
  private readonly runtime = inject(EffectRuntime);
  private readonly aborts = new AbortController();
  private readonly liveStates = new Map<SessionId, LiveState>();
  private readonly _tabs = signal<ReadonlyArray<Tab>>([]);
  private readonly _activeId = signal<string | null>(null);
  private nextDraft = 1;

  readonly tabs = this._tabs.asReadonly();
  readonly activeId = this._activeId.asReadonly();
  readonly active = computed(() => this._tabs().find((tab) => tab.id === this._activeId()) ?? null);
  private readonly openSessions = computed(
    () => new Set(this._tabs().flatMap((tab) => (tab.session === null ? [] : [tab.session]))),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    void this.runtime.run(restoreTabs(), { signal: this.aborts.signal }).then((exit) => {
      if (Exit.isSuccess(exit)) this.setRestored(exit.value);
    });
    void this.runtime.run(
      followChanges((change) => this.applyChange(change)),
      { signal: this.aborts.signal },
    );
    void this.runtime.run(
      followActivations((activation) =>
        this.open({
          id: activation.sessionId,
          projectId: activation.projectId,
          title: titleOf(activation.title),
        }),
      ),
      { signal: this.aborts.signal },
    );
  }

  /** Activates the Session's Tab, opening one at the end of the strip if it has none. */
  open(session: OpenSession): Tab {
    const existing = this._tabs().find((tab) => tab.session === session.id);
    if (existing !== undefined) {
      this._activeId.set(existing.id);
      this.reportTabs();
      return existing;
    }
    const live = this.liveStates.get(session.id);
    const attention = live !== undefined ? live.attention : session.attention;
    const running = live !== undefined ? live.runningTurn !== undefined : session.running;
    const title = live !== undefined ? (titleOf(live.title) ?? session.title) : session.title;
    const tab: Tab = {
      id: `session:${session.id}`,
      projectId: session.projectId,
      session: session.id,
      title,
      ...(attention === undefined ? {} : { attention }),
      ...(running ? { running: true } : {}),
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

  /** Records the Session main created for an unprompted draft Tab so it survives language reload. */
  attachDraft(id: string, sessionId: SessionId): void {
    if (
      !this._tabs().some(
        (tab) => tab.id === id && tab.session === null && tab.draftSession !== sessionId,
      )
    ) {
      return;
    }
    this._tabs.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, draftSession: sessionId } : tab)),
    );
    this.reportTabs();
  }

  /** A draft becomes a kept Session when its first Message is sent. */
  keep(id: string, session: SessionId): void {
    if (!this._tabs().some((tab) => tab.id === id && tab.session === null)) return;
    const live = this.liveStates.get(session);
    this._tabs.update((tabs) =>
      tabs.map((tab) => {
        if (tab.id !== id) return tab;
        const { draftSession: _draft, ...rest } = tab;
        return {
          ...rest,
          session,
          ...(live === undefined
            ? {}
            : {
                title: titleOf(live.title) ?? tab.title,
                ...(live.attention === undefined ? {} : { attention: live.attention }),
                ...(live.runningTurn === undefined ? {} : { running: true }),
              }),
        };
      }),
    );
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

  /** Closes all open Tabs belonging to `projectId` (e.g. when a Project is removed). */
  closeProject(projectId: ProjectId): void {
    const tabs = this._tabs();
    const rest = tabs.filter((tab) => tab.projectId !== projectId);
    if (rest.length === tabs.length) return;
    this._tabs.set(rest);
    const activeId = this._activeId();
    if (activeId !== null && !rest.some((tab) => tab.id === activeId)) {
      this._activeId.set(rest[0]?.id ?? null);
    }
    this.reportTabs();
  }

  private applyChange(change: SessionChange): void {
    this.liveStates.set(change.sessionId, change.state);
    this._tabs.update((tabs) =>
      tabs.map((tab) => {
        if ((tab.session ?? tab.draftSession) !== change.sessionId) return tab;
        const nextTitle =
          tab.session === null ? tab.title : (titleOf(change.state.title) ?? tab.title);
        const { attention: _attention, running: _running, ...rest } = tab;
        return {
          ...rest,
          title: nextTitle,
          ...(change.state.attention === undefined ? {} : { attention: change.state.attention }),
          ...(change.state.runningTurn === undefined ? {} : { running: true }),
        };
      }),
    );
  }

  private setRestored(restored: RestoredTabs): void {
    const existing = this._tabs();
    const existingSessions = new Set(
      existing.map((tab) => tab.session ?? tab.draftSession).filter((id) => id !== undefined),
    );
    const restoredTabs = restored.tabs
      .filter((tab) => !existingSessions.has(tab.id))
      .map((tab): Tab => {
        const live = this.liveStates.get(tab.id);
        const attention = live !== undefined ? live.attention : tab.attention;
        const running = live !== undefined ? live.runningTurn !== undefined : tab.running;
        if (tab.draft) {
          const id = `draft:${this.nextDraft}`;
          this.nextDraft += 1;
          return {
            id,
            projectId: tab.projectId,
            session: null,
            draftSession: tab.id,
            title: null,
            ...(attention === undefined ? {} : { attention }),
            ...(running ? { running: true } : {}),
          };
        }
        return {
          id: tabId(tab.id),
          projectId: tab.projectId,
          session: tab.id,
          title:
            live !== undefined ? (titleOf(live.title) ?? titleOf(tab.title)) : titleOf(tab.title),
          ...(attention === undefined ? {} : { attention }),
          ...(running ? { running: true } : {}),
        };
      });
    if (restoredTabs.length === 0) return;
    const tabs = [...restoredTabs, ...existing];
    this._tabs.set(tabs);
    if (this._activeId() === null) {
      const active = restored.active;
      if (active !== undefined) {
        const tab = tabs.find(
          (candidate) => (candidate.session ?? candidate.draftSession) === active,
        );
        this._activeId.set(tab?.id ?? tabs[0]?.id ?? null);
      } else {
        this._activeId.set(tabs[0]?.id ?? null);
      }
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
      .map((tab) => tab.session ?? tab.draftSession)
      .filter((id): id is SessionId => id !== undefined);
    const activeTab = this.active();
    const active = activeTab === null ? undefined : (activeTab.session ?? activeTab.draftSession);
    void this.runtime.run(updateTabs(open, active)(), { signal: this.aborts.signal });
  }
}

const titleOf = (title: SessionTitle): string | null => title.user ?? title.auto ?? null;

const tabId = (sessionId: SessionId): string => `session:${sessionId}`;
