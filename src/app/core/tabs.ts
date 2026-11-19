import { DestroyRef, inject, Injectable, computed, signal } from '@angular/core';
import { Effect, Exit, Schedule, Stream } from 'effect';
import type { ProjectId } from '../../shared/projects/projects.rpc';
import type {
  Attention,
  LiveState,
  SessionChange,
  SessionId,
  SessionTitle,
  TurnId,
} from '../../shared/sessions/sessions.rpc';
import {
  PaneId,
  PanelId,
  TabId,
  type RestoredSessionInfo,
  type RestoredWorkspace,
  type TabActivation,
  type WorkspacePanel,
  type WorkspaceState,
  type WorkspaceTab,
} from '../../shared/tabs/tabs.rpc';
import {
  EMPTY_WORKSPACE,
  activateTab as activateTabLayout,
  activeProjectWorkspace,
  activeTabOf,
  allTabPanels,
  allWorkspaceSessionIds,
  attachDraftSession,
  closePanel as closePanelLayout,
  closeTab as closeTabLayout,
  findDraftPanel,
  findTab,
  focusPanel as focusPanelLayout,
  focusedPanelOf,
  normalizeWorkspace,
  openDraftTab,
  openSessionTab,
  promoteDraftSession,
  pruneProject,
  pruneSession,
  renameTab as renameTabLayout,
  switchProject as switchProjectLayout,
  type TabIdsFactory,
} from '../../shared/tabs/workspace-layout';
import { DesktopApi } from './desktop-api';
import { EffectRuntime } from './effect-runtime';
import { PanelRegistry } from './panel-registry';

/**
 * Active Session projection for sidebar highlight and legacy `ChangesState` lookups.
 * `session` is `null` for an unprompted draft Panel.
 */
export interface Tab {
  readonly id: TabId;
  readonly panelId: PanelId;
  readonly projectId: ProjectId;
  readonly session: SessionId | null;
  readonly draftSession?: SessionId;
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

export interface TabTitleDisplay {
  readonly label: string;
  readonly untitled: boolean;
  readonly custom: boolean;
}

const RESUBSCRIBE_AFTER = '500 millis';

const restoreTabs = Effect.fnUntraced(function* () {
  const api = yield* DesktopApi;
  return yield* api['Tabs.restore']();
});

const updateTabs = (workspace: WorkspaceState) =>
  Effect.fnUntraced(function* () {
    const api = yield* DesktopApi;
    yield* api['Tabs.update']({ workspace });
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

const createUuid = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Per-Project workspace Tabs and active Project/Tab/Panel state. Closing a Tab never stops non-draft Sessions;
 * closing a draft forgets the draft.
 */
@Injectable({ providedIn: 'root' })
export class Tabs {
  private readonly runtime = inject(EffectRuntime);
  private readonly registry = inject(PanelRegistry);
  private readonly aborts = new AbortController();
  private readonly liveStates = new Map<SessionId, LiveState>();
  /** Bumped whenever `liveStates` changes, so computeds reading `liveState` follow it. */
  private readonly _liveVersion = signal(0);
  private readonly _sessionMeta = signal<ReadonlyMap<SessionId, RestoredSessionInfo>>(new Map());
  private readonly _workspace = signal<WorkspaceState>(EMPTY_WORKSPACE);
  private readonly _restored = signal(false);
  private readonly _activations = signal(0);
  private readonly _sessionsVersion = signal(0);
  private readonly _pendingTurnScroll = signal<{
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
  } | null>(null);
  private nextId = 1;

  readonly workspace = this._workspace.asReadonly();
  readonly restored = this._restored.asReadonly();
  readonly activeProjectId = computed(
    (): ProjectId | null => this._workspace().activeProjectId ?? null,
  );
  /** The active Project's Tabs in strip order. */
  readonly tabs = computed(
    (): ReadonlyArray<WorkspaceTab> => activeProjectWorkspace(this._workspace())?.tabs ?? [],
  );
  /** All Tabs across all Projects. */
  readonly allTabs = computed((): ReadonlyArray<WorkspaceTab> =>
    this._workspace().projects.flatMap((project) => project.tabs),
  );
  readonly activeTab = computed((): WorkspaceTab | null => activeTabOf(this._workspace()) ?? null);
  readonly focusedPanel = computed((): WorkspacePanel | null => {
    const tab = this.activeTab();
    return tab === null ? null : (focusedPanelOf(tab) ?? null);
  });
  /** Active Session Panel projection for sidebar highlight and callers reading the focused Session. */
  readonly active = computed((): Tab | null => {
    const projectId = this.activeProjectId();
    const tab = this.activeTab();
    const panel = this.focusedPanel();
    if (projectId === null || tab === null || panel === null || panel.spec._tag !== 'Session') {
      return null;
    }
    const sid = panel.spec.sessionId;
    const isDraft = panel.spec.draft === true || sid === undefined;
    const summary = sid === undefined ? undefined : this.sessionStatus(sid);
    return {
      id: tab.id,
      panelId: panel.id,
      projectId,
      session: isDraft ? null : sid,
      ...(isDraft && sid !== undefined ? { draftSession: sid } : {}),
      title: isDraft ? null : (summary?.title ?? null),
      ...(summary?.attention === undefined ? {} : { attention: summary.attention }),
      ...(summary?.running === true ? { running: true } : {}),
    };
  });

  /** Counts every time a Tab is asked for, even one already active; views that cover the Tabs close on it. */
  readonly activations = this._activations.asReadonly();
  readonly sessionsVersion = this._sessionsVersion.asReadonly();
  readonly pendingTurnScroll = this._pendingTurnScroll.asReadonly();

  /**
   * The Session the sidebar highlights: the active Tab's focused Session, or, for a Worker (which is never listed),
   * the top-level Session it descends from.
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

  private readonly openSessions = computed(() => allWorkspaceSessionIds(this._workspace()));

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    void this.runtime.run(restoreTabs(), { signal: this.aborts.signal }).then((exit) => {
      if (Exit.isSuccess(exit)) this.setRestored(exit.value);
      else this._restored.set(true);
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

  /** Resolves a Session's current title, attention, and running status from live state or restored metadata. */
  sessionStatus(id: SessionId):
    | {
        readonly title: string | null;
        readonly attention?: Attention;
        readonly running: boolean;
      }
    | undefined {
    this._liveVersion();
    const live = this.liveStates.get(id);
    if (live !== undefined) {
      return {
        title: titleOf(live.title),
        ...(live.attention === undefined ? {} : { attention: live.attention }),
        running: live.runningTurn !== undefined,
      };
    }
    const meta = this._sessionMeta().get(id);
    if (meta !== undefined) {
      return {
        title: titleOf(meta.title),
        ...(meta.attention === undefined ? {} : { attention: meta.attention }),
        running: meta.running === true,
      };
    }
    return undefined;
  }

  /** Resolves the title of a single Panel (`null` for an untitled Session). */
  panelTitle(panel: WorkspacePanel): string | null {
    const kind: string = panel.spec._tag;
    if (kind !== 'Session' && kind !== 'Changes' && kind !== 'Workers') {
      return this.registry.get(kind)?.defaultTitle ?? kind;
    }
    switch (panel.spec._tag) {
      case 'Session': {
        if (panel.spec.draft === true || panel.spec.sessionId === undefined) return null;
        return this.sessionStatus(panel.spec.sessionId)?.title ?? null;
      }
      case 'Changes':
        return $localize`Changes`;
      case 'Workers':
        return $localize`Workers`;
    }
  }

  /** Resolves the display title for `tab`: `customTitle`, else its focused/first Panel title, else "New Session". */
  tabTitle(tab: WorkspaceTab): TabTitleDisplay {
    const custom = tab.customTitle?.trim();
    if (custom !== undefined && custom !== '') {
      return { label: custom, untitled: false, custom: true };
    }
    const panel = focusedPanelOf(tab) ?? allTabPanels(tab)[0];
    const resolved = panel === undefined ? null : this.panelTitle(panel);
    if (resolved !== null) return { label: resolved, untitled: false, custom: false };
    return { label: $localize`New Session`, untitled: true, custom: false };
  }

  /** Aggregates Attention (priority over Working) across all Session Panels in `tab`. */
  tabActivity(tab: WorkspaceTab): Attention | 'running' | null {
    let attention: Attention | undefined;
    let running = false;
    for (const panel of allTabPanels(tab)) {
      if (panel.spec._tag !== 'Session' || panel.spec.sessionId === undefined) continue;
      const status = this.sessionStatus(panel.spec.sessionId);
      if (status === undefined) continue;
      if (status.running) running = true;
      if (status.attention === 'needsAnswer') return 'needsAnswer';
      if (status.attention === 'error') attention = 'error';
    }
    if (attention !== undefined) return attention;
    return running ? 'running' : null;
  }

  /** Activates the Session's existing Tab/Panel (switching Project and expanding if collapsed), or opens a new Tab. */
  open(session: OpenSession): WorkspaceTab {
    this.rememberSessionMeta(session);
    const result = openSessionTab(this._workspace(), {
      projectId: session.projectId,
      sessionId: session.id,
      createIds: () => this.createIds(),
    });
    this._workspace.set(result.workspace);
    this.bumpActivation();
    this.reportTabs();
    return result.tab;
  }

  /** Always opens a brand-new Tab starting with a fresh draft Session Panel in `projectId`. */
  newTab(projectId: ProjectId): WorkspaceTab {
    const result = openDraftTab(this._workspace(), {
      projectId,
      createIds: () => this.createIds(),
      reuseExisting: false,
    });
    this._workspace.set(result.workspace);
    this.bumpActivation();
    this.reportTabs();
    return result.tab;
  }

  /** Activates `projectId`'s existing draft Tab if one exists, otherwise opens a new draft Tab. */
  startDraft(projectId: ProjectId): WorkspaceTab {
    const result = openDraftTab(this._workspace(), {
      projectId,
      createIds: () => this.createIds(),
      reuseExisting: true,
    });
    this._workspace.set(result.workspace);
    this.bumpActivation();
    this.reportTabs();
    return result.tab;
  }

  /** The Project's first draft Tab, if it has one. */
  draftOf(projectId: ProjectId): WorkspaceTab | null {
    return findDraftPanel(this._workspace(), projectId)?.tab ?? null;
  }

  isOpen(session: SessionId): boolean {
    return this.openSessions().has(session);
  }

  /** Switches the active Project without closing other Projects' Tabs or mutating layouts. */
  switchProject(projectId: ProjectId): void {
    const current = this._workspace();
    if (current.activeProjectId === projectId) return;
    this._workspace.set(switchProjectLayout(current, projectId));
    this.reportTabs();
  }

  /** Renames a Tab (`customTitle`), or clears `customTitle` when blank. */
  renameTab(tabId: TabId, customTitle: string): void {
    const current = this._workspace();
    const next = renameTabLayout(current, tabId, customTitle);
    if (next === current) return;
    this._workspace.set(next);
    this.reportTabs();
  }

  setTitle(session: SessionId, title: SessionTitle): void {
    this._sessionMeta.update((current) => {
      const existing = current.get(session);
      if (existing === undefined) return current;
      const next = new Map(current);
      next.set(session, { ...existing, title });
      return next;
    });
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

  /** Records the Session main created for an unprompted draft Panel so it survives language reload. */
  attachDraft(panelId: PanelId, sessionId: SessionId): void {
    const current = this._workspace();
    const next = attachDraftSession(current, panelId, sessionId);
    if (next === current) return;
    this._workspace.set(next);
    this.reportTabs();
  }

  /** A draft Panel becomes a kept Session when its first Message is sent. Also notifies Session listeners. */
  keep(panelId: PanelId, sessionId: SessionId): void {
    this.markSessionsChanged();
    const current = this._workspace();
    const next = promoteDraftSession(current, panelId, sessionId);
    if (next === current) return;
    this._workspace.set(next);
    this.reportTabs();
  }

  /** Activates `tabId` and its owning Project, closing transient overlays such as Settings. */
  activateTab(tabId: TabId): void {
    const current = this._workspace();
    if (findTab(current, tabId) === undefined) return;
    this._workspace.set(activateTabLayout(current, tabId));
    this.bumpActivation();
    this.reportTabs();
  }

  /** Activates the next Tab in the active Project, wrapping from last to first. */
  next(): void {
    this.step(1);
  }

  /** Activates the previous Tab in the active Project, wrapping from first to last. */
  prev(): void {
    this.step(-1);
  }

  /** Activates the Tab at 0-based `index` in the active Project, if one exists. */
  activateIndex(index: number): void {
    const tab = index >= 0 ? this.tabs()[index] : undefined;
    if (tab !== undefined && tab.id !== this.activeTab()?.id) this.activateTab(tab.id);
  }

  /** Activates the last Tab in the active Project, if any Tab is open. */
  activateLast(): void {
    const tab = this.tabs().at(-1);
    if (tab !== undefined && tab.id !== this.activeTab()?.id) this.activateTab(tab.id);
  }

  /** Closes `tabId` in its Project, shifting that Project's active Tab to a neighbor. */
  closeTab(tabId: TabId): void {
    const current = this._workspace();
    const next = closeTabLayout(current, tabId);
    if (next === current) return;
    this._workspace.set(next);
    this.reportTabs();
  }

  /** Focuses `panelId` inside its Tab/Project (auto-expanding it if collapsed). */
  focusPanel(panelId: PanelId): void {
    const current = this._workspace();
    const activeTab = activeTabOf(current);
    const currentFocused = activeTab === undefined ? undefined : focusedPanelOf(activeTab);
    if (currentFocused?.id === panelId && !currentFocused.collapsed) return;
    const next = focusPanelLayout(current, panelId);
    if (next === current) return;
    this._workspace.set(next);
    this.reportTabs();
  }

  /** Closes `panelId`, collapsing empty Panes or Tabs cleanly. */
  closePanel(panelId: PanelId): void {
    const current = this._workspace();
    const next = closePanelLayout(current, panelId);
    if (next === current) return;
    this._workspace.set(next);
    this.reportTabs();
  }

  /** Closes any Panels bound to `sessionId` (including pinned auxiliary Panels) across all Projects. */
  closeSession(sessionId: SessionId): void {
    const current = this._workspace();
    const next = pruneSession(current, sessionId);
    if (next === current) return;
    this._workspace.set(next);
    this.reportTabs();
  }

  /** Closes all open Tabs belonging to `projectId` (e.g. when a Project is removed). */
  closeProject(projectId: ProjectId): void {
    const current = this._workspace();
    if (
      !current.projects.some((project) => project.projectId === projectId) &&
      current.activeProjectId !== projectId
    ) {
      return;
    }
    this._workspace.set(pruneProject(current, projectId));
    this.reportTabs();
  }

  private step(delta: 1 | -1): void {
    const tabs = this.tabs();
    if (tabs.length === 0) return;
    const activeId = this.activeTab()?.id;
    const current = tabs.findIndex((tab) => tab.id === activeId);
    const targetIndex =
      current === -1
        ? delta === 1
          ? 0
          : tabs.length - 1
        : (current + delta + tabs.length) % tabs.length;
    this.activateIndex(targetIndex);
  }

  private rememberSessionMeta(session: OpenSession): void {
    this._sessionMeta.update((current) => {
      const existing = current.get(session.id);
      const next = new Map(current);
      const nextTitle: SessionTitle =
        session.title !== null
          ? { auto: session.title, autoIsPlaceholder: false }
          : (existing?.title ?? { autoIsPlaceholder: false });
      next.set(session.id, {
        id: session.id,
        projectId: session.projectId,
        title: nextTitle,
        ...(session.attention !== undefined
          ? { attention: session.attention }
          : existing?.attention !== undefined
            ? { attention: existing.attention }
            : {}),
        ...(session.running !== undefined
          ? { running: session.running }
          : existing?.running !== undefined
            ? { running: existing.running }
            : {}),
      });
      return next;
    });
  }

  private applyChange(change: SessionChange): void {
    this.liveStates.set(change.sessionId, change.state);
    this._liveVersion.update((v) => v + 1);
  }

  private setRestored(restored: RestoredWorkspace): void {
    this._sessionMeta.update((current) => {
      const next = new Map(current);
      for (const info of restored.sessions) next.set(info.id, info);
      return next;
    });
    const current = this._workspace();
    if (current.projects.length === 0 && current.activeProjectId === undefined) {
      this._workspace.set(restored.workspace);
      this._restored.set(true);
      if (
        restored.workspace.projects.length > 0 ||
        restored.workspace.activeProjectId !== undefined
      ) {
        this.reportTabs();
      }
      return;
    }

    // Merge restored Tabs behind any user Tabs opened before `Tabs.restore` resolved.
    const mergedProjects = new Map(
      restored.workspace.projects.map((project) => [project.projectId, project]),
    );
    for (const existing of current.projects) {
      const prior = mergedProjects.get(existing.projectId);
      if (prior === undefined) {
        mergedProjects.set(existing.projectId, existing);
        continue;
      }
      const existingIds = new Set(existing.tabs.map((tab) => tab.id));
      const mergedTabs = [
        ...prior.tabs.filter((tab) => !existingIds.has(tab.id)),
        ...existing.tabs,
      ];
      mergedProjects.set(existing.projectId, {
        projectId: existing.projectId,
        tabs: mergedTabs,
        ...(existing.activeTabId !== undefined
          ? { activeTabId: existing.activeTabId }
          : prior.activeTabId !== undefined
            ? { activeTabId: prior.activeTabId }
            : {}),
      });
    }
    const activeProjectId = current.activeProjectId ?? restored.workspace.activeProjectId;
    const merged = normalizeWorkspace({
      projects: [...mergedProjects.values()],
      ...(activeProjectId === undefined ? {} : { activeProjectId }),
    });
    this._workspace.set(merged);
    this._restored.set(true);
    this.reportTabs();
  }

  private createIds(): TabIdsFactory {
    const seq = this.nextId;
    this.nextId += 1;
    const suffix = `${seq}-${createUuid()}`;
    return {
      tabId: TabId.make(`tab:${suffix}`),
      paneId: PaneId.make(`pane:${suffix}`),
      panelId: PanelId.make(`panel:${suffix}`),
    };
  }

  private bumpActivation(): void {
    this._activations.update((count) => count + 1);
  }

  private reportTabs(): void {
    void this.runtime.run(updateTabs(this._workspace())(), { signal: this.aborts.signal });
  }
}

export const titleOf = (title: SessionTitle): string | null => {
  if (title.user !== undefined) return title.user;
  if (title.auto !== undefined) return title.auto;
  const count = title.autoImageCount;
  if (count === undefined) return null;
  return count === 1 ? $localize`Image` : $localize`${count}:count: Images`;
};
