import { DestroyRef, inject, Injectable, Injector, computed, signal } from '@angular/core';
import { Effect, Exit, Schedule, Stream } from 'effect';
import type { DeviceId } from '../../shared/devices/devices.rpc';
import type { ProjectId } from '../../shared/projects/projects.rpc';
import type {
  Attention,
  LiveState,
  SessionChange,
  SessionId,
  SessionTitle,
  TurnId,
} from '../../shared/sessions/sessions.rpc';
import type { RestoredTabs, TabActivation } from '../../shared/tabs/tabs.rpc';
import { DesktopApi } from './desktop-api';
import { onDevice } from './device-scope';
import { EffectRuntime } from './effect-runtime';
import { RemoteDevices } from './remote-devices';

/**
 * A Session open in the window. `session` is `null` for a draft: a new Session that is not kept until its first
 * Message, so it has a Tab but no stored Session yet.
 */
export interface Tab {
  /** Spence's own key for the Tab; a draft's stays the same when it becomes a kept Session. */
  readonly id: string;
  /** The Device the Session runs on; absent for the Local device. */
  readonly device?: DeviceId;
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
  /** The Device it runs on; absent for the Local device. */
  readonly device?: DeviceId;
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

const followChanges = (onChange: (change: SessionChange) => void, device?: DeviceId) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Session.changes']().pipe(
      Stream.runForEach((change) => Effect.sync(() => onChange(change))),
    );
  }).pipe(onDevice(device), Effect.retry(Schedule.spaced(RESUBSCRIBE_AFTER)));

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
  private readonly devices = inject(RemoteDevices);
  private readonly aborts = new AbortController();
  private readonly liveStates = new Map<SessionId, LiveState>();
  /** Bumped whenever `liveStates` changes, so computeds reading `liveState` follow it. */
  private readonly _liveVersion = signal(0);
  private readonly _tabs = signal<ReadonlyArray<Tab>>([]);
  private readonly _activeId = signal<string | null>(null);
  private readonly _activations = signal(0);
  private readonly _sessionsVersion = signal(0);
  private readonly _pendingTurnScroll = signal<{
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
  } | null>(null);
  private nextDraft = 1;

  readonly tabs = this._tabs.asReadonly();
  readonly activeId = this._activeId.asReadonly();
  /** Counts every time a Tab is asked for, even one already active; views that cover the Tabs close on it. */
  readonly activations = this._activations.asReadonly();
  readonly sessionsVersion = this._sessionsVersion.asReadonly();
  readonly pendingTurnScroll = this._pendingTurnScroll.asReadonly();
  readonly active = computed(() => this._tabs().find((tab) => tab.id === this._activeId()) ?? null);
  /**
   * The Session the sidebar highlights: the active Tab's, or, for a Worker (which is never listed), the top-level
   * Session it descends from. Follows the Parent links seen in live state.
   */
  readonly highlighted = computed((): SessionId | null => {
    let id = this.active()?.session ?? null;
    const seen = new Set<SessionId>();
    while (id !== null && !seen.has(id)) {
      seen.add(id);
      const parent = this.liveState(id)?.parentSessionId;
      if (parent === undefined) break;
      id = parent;
    }
    return id;
  });
  private readonly openSessions = computed(
    () => new Set(this._tabs().flatMap((tab) => (tab.session === null ? [] : [tab.session]))),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    // A Remote Session's Tab follows its Device's changes like a Local one.
    this.devices.forEachOnline((device, signal) => {
      void this.runtime.run(
        followChanges((change) => this.applyChange(change), device),
        { signal },
      );
    }, inject(Injector));
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

  /** The last live state seen for a Session (any Project); reading it in a computed follows changes. */
  liveState(id: SessionId): LiveState | undefined {
    this._liveVersion();
    return this.liveStates.get(id);
  }

  /** Records a live state read directly, for a Session no change has been seen for yet. Never overwrites. */
  seedLive(id: SessionId, state: LiveState): void {
    if (this.liveStates.has(id)) return;
    this.liveStates.set(id, state);
    this._liveVersion.update((v) => v + 1);
  }

  /** Activates the Session's Tab, opening one at the end of the strip if it has none. */
  open(session: OpenSession): Tab {
    const existing = this._tabs().find((tab) => tab.session === session.id);
    if (existing !== undefined) {
      this.focus(existing.id);
      this.reportTabs();
      return existing;
    }
    const live = this.liveStates.get(session.id);
    const attention = live !== undefined ? live.attention : session.attention;
    const running = live !== undefined ? live.runningTurn !== undefined : session.running;
    const title = live !== undefined ? (titleOf(live.title) ?? session.title) : session.title;
    const tab: Tab = {
      id: `session:${session.id}`,
      ...(session.device === undefined ? {} : { device: session.device }),
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
  startDraft(projectId: ProjectId, device?: DeviceId): Tab {
    const existing = this.draftOf(projectId);
    if (existing !== null) {
      this.focus(existing.id);
      this.reportTabs();
      return existing;
    }
    const tab: Tab = {
      id: `draft:${this.nextDraft}`,
      ...(device === undefined ? {} : { device }),
      projectId,
      session: null,
      title: null,
    };
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

  setTitle(session: SessionId, title: SessionTitle): void {
    const value = titleOf(title);
    this._tabs.update((tabs) =>
      tabs.some((tab) => tab.session === session && tab.title !== value)
        ? tabs.map((tab) => (tab.session === session ? { ...tab, title: value } : tab))
        : tabs,
    );
  }

  markSessionsChanged(): void {
    this._sessionsVersion.update((v) => v + 1);
  }

  /** Requests that `SessionView` scroll to `turnId` once `sessionId` renders it. */
  requestTurnScroll(sessionId: SessionId, turnId: TurnId): void {
    this._pendingTurnScroll.set({ sessionId, turnId });
  }

  /** Clears a pending turn scroll request once fulfilled. */
  clearTurnScroll(sessionId: SessionId, turnId: TurnId): void {
    const current = this._pendingTurnScroll();
    if (current?.sessionId === sessionId && current.turnId === turnId) {
      this._pendingTurnScroll.set(null);
    }
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

  /** A draft becomes a kept Session when its first Message is sent. Also notifies Session listeners on prompt. */
  keep(id: string, session: SessionId): void {
    this.markSessionsChanged();
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
      this.focus(id);
      this.reportTabs();
    }
  }

  /** Activates the next open Tab, wrapping from the last Tab to the first. */
  next(): void {
    this.step(1);
  }

  /** Activates the previous open Tab, wrapping from the first Tab to the last. */
  prev(): void {
    this.step(-1);
  }

  /** Activates the Tab at 0-based `index`, if one exists. */
  activateIndex(index: number): void {
    const tab = index >= 0 ? this._tabs()[index] : undefined;
    if (tab !== undefined && tab.id !== this._activeId()) this.activate(tab.id);
  }

  /** Activates the last open Tab, if any Tab is open. */
  activateLast(): void {
    const tab = this._tabs().at(-1);
    if (tab !== undefined && tab.id !== this._activeId()) this.activate(tab.id);
  }

  private step(delta: 1 | -1): void {
    const tabs = this._tabs();
    if (tabs.length === 0) return;
    const current = tabs.findIndex((tab) => tab.id === this._activeId());
    const targetIndex =
      current === -1
        ? delta === 1
          ? 0
          : tabs.length - 1
        : (current + delta + tabs.length) % tabs.length;
    this.activateIndex(targetIndex);
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
    this._liveVersion.update((v) => v + 1);
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
    this.focus(tab.id);
    this.reportTabs();
  }

  private focus(id: string): void {
    this._activeId.set(id);
    this._activations.update((count) => count + 1);
  }

  /** Tells main the Local device's Tabs: a Remote Session's Tab is the viewer's own, never the host's. */
  private reportTabs(): void {
    const open = this._tabs()
      .filter((tab) => tab.device === undefined)
      .map((tab) => tab.session ?? tab.draftSession)
      .filter((id): id is SessionId => id !== undefined);
    const activeTab = this.active();
    const active =
      activeTab === null || activeTab.device !== undefined
        ? undefined
        : (activeTab.session ?? activeTab.draftSession);
    void this.runtime.run(updateTabs(open, active)(), { signal: this.aborts.signal });
  }
}

export const titleOf = (title: SessionTitle): string | null => {
  if (title.user !== undefined) return title.user;
  if (title.auto !== undefined) return title.auto;
  const count = title.autoImageCount;
  if (count === undefined) return null;
  return count === 1 ? $localize`Image` : $localize`${count}:count: Images`;
};

const tabId = (sessionId: SessionId): string => `session:${sessionId}`;
