import {
  DestroyRef,
  inject,
  Injectable,
  Injector,
  computed,
  effect,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Exit, Schedule, Stream } from 'effect';
import type { DeviceId } from '../../shared/devices/devices.rpc';
import type { ProjectId } from '../../shared/projects/projects.rpc';
import type {
  LiveState,
  SessionChange,
  SessionId,
  SessionStatus,
  SessionTitle,
  TurnId,
} from '../../shared/sessions/sessions.rpc';
import {
  PaneId,
  PanelId,
  TabId,
  type PanelSpec,
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
  allReferencedSessionIds,
  allTabLeaves,
  allTabPanels,
  allWorkspaceSessionIds,
  attachDraftSession,
  canSplitDrop,
  closePanel as closePanelLayout,
  closeTab as closeTabLayout,
  findDraftPanel,
  findPane,
  findPanel,
  findProject,
  findSessionPanel,
  findTab,
  focusPanel as focusPanelLayout,
  focusedPanelOf,
  movePanelToSplit as movePanelToSplitLayout,
  normalizeWorkspace,
  openDraftTab,
  openSessionInSplit as openSessionInSplitLayout,
  openSessionTab,
  MAX_PANES_PER_TAB,
  paneCount as paneCountOfTab,
  promoteDraftSession,
  pruneProject,
  pruneSession,
  pruneSessions,
  renameTab as renameTabLayout,
  reorderTabs as reorderTabsLayout,
  resetDraftSession,
  setSessionWallpaperInWorkspace,
  setSplitRatio as setSplitRatioLayout,
  splitPane as splitPaneLayout,
  swapPanelToPane as swapPanelToPaneLayout,
  switchProject as switchProjectLayout,
  type SplitIdsFactory,
  type SplitSide,
  type TabIdsFactory,
} from '../../shared/tabs/workspace-layout';
import { ChatBackgrounds, type WallpaperItem } from './chat-backgrounds';
import { DesktopApi } from './desktop-api';
import { onDevice } from './device-scope';
import { EffectRuntime } from './effect-runtime';
import { PanelRegistry } from './panel-registry';
import { RemoteDevices } from './remote-devices';

/** Full-Tab overlay (`Changes` or `Workers`) temporarily covering a Tab's Panes without altering its Pane tree. */
export interface TabOverlay {
  readonly kind: 'Changes' | 'Workers';
  readonly sessionId: SessionId;
  readonly sourcePaneId?: PaneId;
}

/**
 * Active Session projection for sidebar highlight.
 * `session` is `null` for an unprompted draft Panel.
 */
export interface Tab {
  readonly id: TabId;
  readonly panelId: PanelId;
  /** The Device the Session runs on; absent for the Local device. */
  readonly device?: DeviceId;
  readonly projectId: ProjectId;
  readonly session: SessionId | null;
  readonly draftSession?: SessionId;
  readonly title: string | null;
  readonly status?: SessionStatus;
}

interface ThreadPosition {
  readonly top: number;
  readonly lastSeq: number;
  readonly showAllUpdates: boolean;
}

/** What a kept Session needs to open in a Tab. */
export interface OpenSession {
  readonly id: SessionId;
  /** The Device it runs on; absent for the Local device. */
  readonly device?: DeviceId;
  readonly projectId: ProjectId;
  readonly title: string | null;
  readonly status?: SessionStatus;
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

const updateTabs = (
  workspace: WorkspaceState,
  remoteSessions: ReadonlyArray<RestoredSessionInfo>,
  obscured: boolean,
) =>
  Effect.fnUntraced(function* () {
    const api = yield* DesktopApi;
    yield* api['Tabs.update']({
      workspace,
      ...(remoteSessions.length === 0 ? {} : { remoteSessions }),
      obscured,
    });
  });

const setTabsVisibility = (obscured: boolean) =>
  Effect.fnUntraced(function* () {
    const api = yield* DesktopApi;
    yield* api['Tabs.setVisibility']({ obscured });
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
  private readonly devices = inject(RemoteDevices);
  private readonly backgrounds = inject(ChatBackgrounds);
  private readonly aborts = new AbortController();
  private readonly liveStates = new Map<SessionId, LiveState>();
  private readonly threadPositions = new Map<SessionId, ThreadPosition>();
  /** Bumped whenever `liveStates` changes, so computeds reading `liveState` follow it. */
  private readonly _liveVersion = signal(0);
  private readonly _sessionMeta = signal<ReadonlyMap<SessionId, RestoredSessionInfo>>(new Map());
  private readonly _workspace = signal<WorkspaceState>(EMPTY_WORKSPACE);
  private readonly _tabOverlays = signal<ReadonlyMap<TabId, TabOverlay>>(new Map());
  private readonly _settingsOpen = signal(false);
  private lastReportedObscured = false;
  private readonly _mruByProject = signal<ReadonlyMap<ProjectId, ReadonlyArray<TabId>>>(new Map());
  private readonly _panelWallpapers = signal<ReadonlyMap<PanelId, string>>(new Map());
  private lastAssignedWallpaper: string | undefined;
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
  /** The active Project's Tabs ordered most-recently-used first (active Tab at index 0). */
  readonly mruTabs = computed((): ReadonlyArray<WorkspaceTab> => {
    const projectId = this.activeProjectId();
    const currentTabs = this.tabs();
    if (projectId === null || currentTabs.length === 0) return [];
    const byId = new Map(currentTabs.map((tab) => [tab.id, tab]));
    const recorded = this._mruByProject().get(projectId) ?? [];
    const ordered: Array<WorkspaceTab> = [];
    const seen = new Set<TabId>();
    const activeId = this.activeTab()?.id;
    if (activeId !== undefined) {
      const activeTab = byId.get(activeId);
      if (activeTab !== undefined) {
        ordered.push(activeTab);
        seen.add(activeId);
      }
    }
    for (const id of recorded) {
      if (seen.has(id)) continue;
      const tab = byId.get(id);
      if (tab !== undefined) {
        ordered.push(tab);
        seen.add(id);
      }
    }
    for (const tab of currentTabs) {
      if (!seen.has(tab.id)) {
        ordered.push(tab);
        seen.add(tab.id);
      }
    }
    return ordered;
  });
  /** All Tabs across all Projects. */
  readonly allTabs = computed((): ReadonlyArray<WorkspaceTab> =>
    this._workspace().projects.flatMap((project) => project.tabs),
  );
  readonly activeTab = computed((): WorkspaceTab | null => activeTabOf(this._workspace()) ?? null);
  readonly activeTabOverlay = computed((): TabOverlay | null => {
    const tab = this.activeTab();
    return tab === null ? null : (this._tabOverlays().get(tab.id) ?? null);
  });
  private readonly isObscured = computed(
    () => this._settingsOpen() || this.activeTabOverlay() !== null,
  );
  readonly focusedPanel = computed((): WorkspacePanel | null => {
    const tab = this.activeTab();
    return tab === null ? null : (focusedPanelOf(tab) ?? null);
  });
  readonly activeDevice = computed(
    (): DeviceId | undefined => activeProjectWorkspace(this._workspace())?.device,
  );

  tabOverlay(tabId: TabId): TabOverlay | null {
    return this._tabOverlays().get(tabId) ?? null;
  }

  /** Resolves the wallpaper for `panel` under the current `ChatBackgrounds` mode, or `null` when hidden. */
  panelWallpaper(panel: WorkspacePanel): WallpaperItem | null {
    if (panel.spec._tag !== 'Session') return null;
    const assigned =
      (panel.spec.sessionId !== undefined
        ? this._workspace().sessionWallpapers?.[panel.spec.sessionId]
        : undefined) ?? this._panelWallpapers().get(panel.id);
    return this.backgrounds.resolve(assigned);
  }

  /** Returns the assigned wallpaper ID for `panel`, if any. */
  panelWallpaperId(panel: WorkspacePanel): string | undefined {
    if (panel.spec._tag !== 'Session') return undefined;
    if (this.backgrounds.mode() === 'same') return this.backgrounds.selectedId();
    return (
      (panel.spec.sessionId !== undefined
        ? this._workspace().sessionWallpapers?.[panel.spec.sessionId]
        : undefined) ??
      this._panelWallpapers().get(panel.id) ??
      this.backgrounds.resolve()?.id
    );
  }

  /** Assigns a custom or gallery wallpaper to a Session Panel (persisting on its `SessionId` when kept). */
  setPanelWallpaper(panelId: PanelId, wallpaperId: string): void {
    const found = findPanel(this._workspace(), panelId);
    if (found === undefined || found.panel.spec._tag !== 'Session') return;
    this._panelWallpapers.update((current) => {
      const next = new Map(current);
      next.set(panelId, wallpaperId);
      return next;
    });
    const sessionId = found.panel.spec.sessionId;
    if (sessionId !== undefined) {
      const current = this._workspace();
      const next = setSessionWallpaperInWorkspace(current, sessionId, wallpaperId);
      if (next !== current) {
        this._workspace.set(next);
        this.reportTabs();
      }
    }
  }

  projectDevice(projectId: ProjectId): DeviceId | undefined {
    return this._workspace().projects.find((project) => project.projectId === projectId)?.device;
  }

  /** Active Session Panel projection for sidebar highlight and callers reading the focused Session. */
  readonly active = computed((): Tab | null => {
    const project = activeProjectWorkspace(this._workspace());
    const tab = this.activeTab();
    const panel = this.focusedPanel();
    if (project === undefined || tab === null || panel === null || panel.spec._tag !== 'Session') {
      return null;
    }
    const sid = panel.spec.sessionId;
    const isDraft = panel.spec.draft === true || sid === undefined;
    const summary = sid === undefined ? undefined : this.sessionStatus(sid);
    return {
      id: tab.id,
      panelId: panel.id,
      ...(project.device === undefined ? {} : { device: project.device }),
      projectId: project.projectId,
      session: isDraft ? null : sid,
      ...(isDraft && sid !== undefined ? { draftSession: sid } : {}),
      title: isDraft ? null : (summary?.title ?? null),
      ...(summary?.status === undefined ? {} : { status: summary.status }),
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
    effect(() => {
      this.backgrounds.gallery();
      untracked(() => {
        const workspace = this._workspace();
        const withWallpapers = this.ensureWallpapers(workspace);
        if (withWallpapers === workspace) return;
        this._workspace.set(withWallpapers);
        this.reportTabs();
      });
    });
    // A Remote Session's Tab follows its Device's changes like a Local one.
    this.devices.forEachOnline((device, signal) => {
      void this.runtime.run(
        followChanges((change) => this.applyChange(change), device),
        { signal },
      );
    }, inject(Injector));
    const background = new Map<SessionId, OpenSession>();
    void this.runtime.run(restoreTabs(), { signal: this.aborts.signal }).then((exit) => {
      if (Exit.isSuccess(exit)) this.setRestored(exit.value);
      else this._restored.set(true);
      for (const session of background.values()) this.openInBackground(session);
      background.clear();
    });
    void this.runtime.run(
      followChanges((change) => this.applyChange(change)),
      { signal: this.aborts.signal },
    );
    void this.runtime.run(
      followActivations((activation) => {
        const session = {
          id: activation.sessionId,
          ...(activation.device === undefined ? {} : { device: activation.device }),
          projectId: activation.projectId,
          title: titleOf(activation.title),
        };
        if (activation.background !== true) {
          this.open(session);
          if (activation.turnId !== undefined) {
            this.requestTurnScroll(activation.sessionId, activation.turnId);
          }
        } else if (this._restored()) this.openInBackground(session);
        else background.set(session.id, session);
      }),
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

  /** Applies the latest `LiveState` received from a `Session.events` stream. */
  applyLive(id: SessionId, state: LiveState): void {
    this.liveStates.set(id, state);
    this._liveVersion.update((v) => v + 1);
  }

  /** Returns restored and open Session metadata known for `projectId`. */
  sessionsInProject(projectId: ProjectId): ReadonlyArray<RestoredSessionInfo> {
    this._liveVersion();
    const byId = new Map<SessionId, RestoredSessionInfo>();
    for (const info of this._sessionMeta().values()) {
      if (info.projectId === projectId) byId.set(info.id, info);
    }
    const projectWorkspace = this._workspace().projects.find((p) => p.projectId === projectId);
    if (projectWorkspace !== undefined) {
      for (const tab of projectWorkspace.tabs) {
        for (const panel of allTabPanels(tab)) {
          const sid = panel.spec.sessionId;
          if (sid === undefined || byId.has(sid)) continue;
          const live = this.liveStates.get(sid);
          byId.set(sid, {
            id: sid,
            projectId,
            title: live?.title ?? { autoIsPlaceholder: false },
            status: live?.status ?? 'idle',
          });
        }
      }
    }
    return [...byId.values()];
  }

  /** Resolves a Session's current title and unified status from live state or restored metadata. */
  sessionStatus(id: SessionId):
    | {
        readonly title: string | null;
        readonly status: SessionStatus;
      }
    | undefined {
    this._liveVersion();
    const live = this.liveStates.get(id);
    if (live !== undefined) {
      return {
        title: titleOf(live.title),
        status: live.status,
      };
    }
    const meta = this._sessionMeta().get(id);
    if (meta !== undefined) {
      return {
        title: titleOf(meta.title),
        status: meta.status,
      };
    }
    return undefined;
  }

  /** Resolves the title of a single Panel (`null` for an untitled Session). */
  panelTitle(panel: WorkspacePanel): string | null {
    if (panel.spec._tag === 'Session') {
      if (panel.spec.draft === true || panel.spec.sessionId === undefined) return null;
      return this.sessionStatus(panel.spec.sessionId)?.title ?? null;
    }
    const kind: string = panel.spec._tag;
    return this.registry.get(kind)?.defaultTitle ?? kind;
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

  /** Resolves non-idle status for a single Panel (`null` for non-Session or idle Panels). */
  panelActivity(panel: WorkspacePanel): Exclude<SessionStatus, 'idle'> | null {
    if (panel.spec._tag !== 'Session' || panel.spec.sessionId === undefined) return null;
    const status = this.sessionStatus(panel.spec.sessionId)?.status;
    return status === undefined || status === 'idle' ? null : status;
  }

  /** Aggregates activity across all Session Panels in `tab` with priority `blocked > error > working`. */
  tabActivity(tab: WorkspaceTab): Exclude<SessionStatus, 'idle'> | null {
    let activity: 'error' | 'working' | null = null;
    for (const panel of allTabPanels(tab)) {
      const current = this.panelActivity(panel);
      if (current === 'blocked') return 'blocked';
      if (current === 'error') activity = 'error';
      else if (current === 'working' && activity === null) activity = 'working';
    }
    return activity;
  }

  /** Activates a Session or returns to it in the Pane showing one of its Workers. */
  open(session: OpenSession): WorkspaceTab {
    const source = this.sessionPane(session.projectId, session.id)?.panel;
    const ancestors = this.workerAncestors(source);
    const index = ancestors.indexOf(session.id);
    return this.navigateSession(session, source, index < 0 ? [] : ancestors.slice(0, index));
  }

  returnToParent(session: OpenSession, workerPanelId: PanelId): WorkspaceTab {
    const workspace = this._workspace();
    const source = findPanel(workspace, workerPanelId)?.panel;
    const ancestors = this.workerAncestors(source);
    const index = ancestors.indexOf(session.id);
    const closeWorker =
      index < 0 && source !== undefined && findSessionPanel(workspace, session.id) !== undefined;
    const next = closeWorker ? closePanelLayout(workspace, source.id) : workspace;
    if (closeWorker) {
      const tab = findPanel(workspace, source.id)?.tab;
      if (tab !== undefined && findTab(next, tab.id) === undefined) {
        this.clearOverlayForTab(tab.id, false);
      }
    }
    return this.navigateSession(session, source, index < 0 ? [] : ancestors.slice(0, index), next);
  }

  /** Reports whether the global Settings view is currently obscuring the workspace Tabs. */
  setSettingsOpen(open: boolean): void {
    if (this._settingsOpen() === open) return;
    this._settingsOpen.set(open);
    this.reportVisibilityIfChanged();
  }

  private navigateSession(
    session: OpenSession,
    source: WorkspacePanel | undefined,
    workerAncestors: ReadonlyArray<SessionId>,
    workspace = this._workspace(),
  ): WorkspaceTab {
    this.rememberSessionMeta(session);
    const result = openSessionTab(workspace, {
      projectId: session.projectId,
      ...(session.device === undefined ? {} : { device: session.device }),
      ...(source === undefined ? {} : { replacePanelId: source.id }),
      workerAncestors,
      sessionId: session.id,
      createIds: () => this.createIds(),
    });
    this.clearOverlayForTab(result.tabId, false);
    this.commitWorkspace(result.workspace);
    this.bumpActivation();
    return result.tab;
  }

  private workerAncestors(panel: WorkspacePanel | undefined): ReadonlyArray<SessionId> {
    return panel?.spec._tag === 'Session' ? (panel.spec.workerAncestors ?? []) : [];
  }

  private sessionPane(projectId: ProjectId, sessionId: SessionId) {
    const workspace = this._workspace();
    const direct = findSessionPanel(workspace, sessionId);
    if (direct !== undefined) return direct;
    const project = findProject(workspace, projectId);
    for (const tab of project?.tabs ?? []) {
      for (const pane of allTabLeaves(tab)) {
        const panel = pane.panels[0];
        if (panel !== undefined && this.workerAncestors(panel).includes(sessionId)) {
          return { projectId, tab, pane, panel };
        }
      }
    }
    return undefined;
  }

  private openInBackground(session: OpenSession): void {
    if (this.openSessions().has(session.id)) return;
    this.rememberSessionMeta(session);
    const result = openSessionTab(this._workspace(), {
      projectId: session.projectId,
      sessionId: session.id,
      createIds: () => this.createIds(),
      activateProject: false,
      background: true,
    });
    this.commitWorkspace(result.workspace);
  }

  /** Always opens a brand-new Tab starting with a fresh draft Session Panel in `projectId`. */
  newTab(projectId: ProjectId, device?: DeviceId): WorkspaceTab {
    const result = openDraftTab(this._workspace(), {
      projectId,
      ...(device === undefined ? {} : { device }),
      createIds: () => this.createIds(),
      reuseExisting: false,
    });
    this.commitWorkspace(result.workspace);
    this.bumpActivation();
    return result.tab;
  }

  /** Activates `projectId`'s existing draft Tab if one exists, otherwise opens a new draft Tab. */
  startDraft(projectId: ProjectId, device?: DeviceId): WorkspaceTab {
    const result = openDraftTab(this._workspace(), {
      projectId,
      ...(device === undefined ? {} : { device }),
      createIds: () => this.createIds(),
      reuseExisting: true,
    });
    this.clearOverlayForTab(result.tabId, false);
    this.commitWorkspace(result.workspace);
    this.bumpActivation();
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
    this.commitWorkspace(switchProjectLayout(current, projectId));
  }

  /** Renames a Tab (`customTitle`), or clears `customTitle` when blank. */
  renameTab(tabId: TabId, customTitle: string): void {
    const current = this._workspace();
    const next = renameTabLayout(current, tabId, customTitle);
    if (next === current) return;
    this.commitWorkspace(next);
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
    this.commitWorkspace(next);
  }

  /**
   * A draft whose Session is gone (a Remote draft that vanished on its Device) starts over: the Panel stays, and a
   * fresh Session is started for it the next time it is shown.
   */
  resetDraft(panelId: PanelId): void {
    const current = this._workspace();
    const next = resetDraftSession(current, panelId);
    if (next === current) return;
    this.commitWorkspace(next);
  }

  /** A draft Panel becomes a kept Session when its first Message is sent. Also notifies Session listeners. */
  keep(panelId: PanelId, sessionId: SessionId): void {
    this.markSessionsChanged();
    const current = this._workspace();
    const next = promoteDraftSession(current, panelId, sessionId);
    if (next === current) return;
    this.commitWorkspace(next);
  }

  /** Activates `tabId` and its owning Project, closing transient overlays such as Settings. */
  activateTab(tabId: TabId): void {
    const current = this._workspace();
    const found = findTab(current, tabId);
    if (found === undefined) return;
    const alreadyActive =
      current.activeProjectId === found.projectId &&
      findProject(current, found.projectId)?.activeTabId === tabId;
    if (!alreadyActive) {
      this.commitWorkspace(activateTabLayout(current, tabId));
    }
    this.bumpActivation();
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
    if (tab !== undefined) this.activateTab(tab.id);
  }

  /** Activates the last Tab in the active Project, if any Tab is open. */
  activateLast(): void {
    const tab = this.tabs().at(-1);
    if (tab !== undefined) this.activateTab(tab.id);
  }

  /** Closes `tabId` in its Project, shifting that Project's active Tab to a neighbor. */
  closeTab(tabId: TabId): void {
    const current = this._workspace();
    const next = closeTabLayout(current, tabId);
    if (next === current) {
      this.clearOverlayForTab(tabId);
      return;
    }
    this.clearOverlayForTab(tabId, false);
    this.commitWorkspace(next);
  }

  /** Returns the number of Leaf Panes in `tab`. */
  paneCount(tab: WorkspaceTab): number {
    return paneCountOfTab(tab);
  }

  /**
   * Splits `paneId` along `side`, placing a new Pane holding `spec` (a fresh draft Session by default)
   * beside it. Respects `MAX_PANES_PER_TAB` (4) and max-1-Panel-per-Session uniqueness.
   */
  splitPane(
    paneId: PaneId,
    side: SplitSide,
    spec: PanelSpec = { _tag: 'Session', draft: true },
  ): PanelId | null {
    const current = this._workspace();
    const result = splitPaneLayout(current, {
      paneId,
      side,
      spec,
      createIds: () => this.createSplitIds(),
    });
    if (result.panelId === undefined) return null;
    if (result.workspace !== current) {
      this.commitWorkspace(result.workspace);
    }
    this.bumpActivation();
    return result.panelId;
  }

  /**
   * Opens `session` in a split of its Project's active Tab (or focuses it if already open).
   * Returns `null` without mutating when the active Tab already has 4 Panes and `session` is not open.
   */
  openSessionInSplit(session: OpenSession, side: SplitSide = 'right'): WorkspaceTab | null {
    this.rememberSessionMeta(session);
    const result = openSessionInSplitLayout(this._workspace(), {
      projectId: session.projectId,
      sessionId: session.id,
      side,
      createTabIds: () => this.createIds(),
      createSplitIds: () => this.createSplitIds(),
    });
    if (result.capped || result.tab === undefined) return null;
    this.clearOverlayForTab(result.tab.id, false);
    this.commitWorkspace(result.workspace);
    this.bumpActivation();
    return result.tab;
  }

  /** Updates `splitPaneId`'s ratio in `tabId` (clamped to `[0.15, 0.85]`) and persists via `Tabs.update`. */
  setSplitRatio(tabId: TabId, splitPaneId: PaneId, ratio: number): void {
    const current = this._workspace();
    const next = setSplitRatioLayout(current, tabId, splitPaneId, ratio);
    if (next === current) return;
    this.commitWorkspace(next);
  }

  /** Returns whether dropping a Panel from `sourcePaneId` onto a split edge of `targetPaneId` is allowed. */
  canDropSplit(tabId: TabId, sourcePaneId: PaneId, targetPaneId: PaneId): boolean {
    const tab = findTab(this._workspace(), tabId)?.tab;
    return tab !== undefined && canSplitDrop(tab, sourcePaneId, targetPaneId);
  }

  /** Moves `panelId` into a new split on `side` of `targetPaneId` within its Tab and persists via `Tabs.update`. */
  movePanelToSplit(panelId: PanelId, targetPaneId: PaneId, side: SplitSide): boolean {
    const current = this._workspace();
    const next = movePanelToSplitLayout(current, {
      panelId,
      targetPaneId,
      side,
      createSplitIds: () => this.createSplitIds(),
    });
    if (next === current) return false;
    this.commitWorkspace(next);
    this.bumpActivation();
    return true;
  }

  /** Swaps `panelId`'s Pane contents with `targetPaneId` within its Tab and persists via `Tabs.update`. */
  swapPanelToPane(panelId: PanelId, targetPaneId: PaneId): boolean {
    const current = this._workspace();
    const next = swapPanelToPaneLayout(current, { panelId, targetPaneId });
    if (next === current) return false;
    this.commitWorkspace(next);
    this.bumpActivation();
    return true;
  }

  /** Reorders `fromTabId` to `toTabId`'s position within `projectId`'s Tab strip and persists via `Tabs.update`. */
  reorderTabs(projectId: ProjectId, fromTabId: TabId, toTabId: TabId): boolean {
    const current = this._workspace();
    const next = reorderTabsLayout(current, projectId, fromTabId, toTabId);
    if (next === current) return false;
    this.commitWorkspace(next);
    return true;
  }

  /** Focuses `panelId` inside its Tab/Project. */
  focusPanel(panelId: PanelId): void {
    const current = this._workspace();
    const activeTab = activeTabOf(current);
    const currentFocused = activeTab === undefined ? undefined : focusedPanelOf(activeTab);
    if (currentFocused?.id === panelId) return;
    const next = focusPanelLayout(current, panelId);
    if (next === current) return;
    this.commitWorkspace(next);
  }

  /** Closes `panelId`, collapsing empty Panes or Tabs cleanly. */
  closePanel(panelId: PanelId): void {
    const current = this._workspace();
    const found = findPanel(current, panelId);
    const next = closePanelLayout(current, panelId);
    if (next === current) return;
    if (found !== undefined && findTab(next, found.tab.id) === undefined) {
      this.clearOverlayForTab(found.tab.id, false);
    }
    this.commitWorkspace(next);
  }

  /** Opens a full-Tab `Changes` view for `sessionId`, replacing the Tab's Panes until Back / Esc. */
  openChangesPanel(
    sessionId: SessionId,
    sourcePaneId?: PaneId,
    projectId?: ProjectId,
  ): TabId | null {
    return this.openTabOverlay('Changes', sessionId, sourcePaneId, projectId);
  }

  /** Opens a full-Tab `Workers` view for `sessionId`, replacing the Tab's Panes until Back / Esc. */
  openWorkersPanel(
    sessionId: SessionId,
    sourcePaneId?: PaneId,
    projectId?: ProjectId,
  ): TabId | null {
    return this.openTabOverlay('Workers', sessionId, sourcePaneId, projectId);
  }

  /** Dismisses the full-Tab `Changes`/`Workers` overlay on `tabId` (defaulting to the active Tab). */
  closeTabOverlay(tabId?: TabId): void {
    const targetId = tabId ?? this.activeTab()?.id;
    if (targetId === undefined) return;
    this.clearOverlayForTab(targetId);
  }

  /** Re-binds the full-Tab `Changes`/`Workers` overlay on `tabId` to inspect `sessionId`. */
  rebindTabOverlaySession(tabId: TabId, sessionId: SessionId): void {
    const current = this._tabOverlays();
    const existing = current.get(tabId);
    if (existing === undefined || existing.sessionId === sessionId) return;
    const next = new Map(current);
    next.set(tabId, { ...existing, sessionId });
    this._tabOverlays.set(next);
  }

  /** Opens a Worker in the Pane of its parent Session, or focuses an existing Worker Panel. */
  openWorkerFromPanel(
    worker: OpenSession,
    ancestors: ReadonlyArray<SessionId>,
    sourcePaneId?: PaneId,
  ): WorkspaceTab {
    const fromPane =
      sourcePaneId === undefined ? undefined : findPane(this._workspace(), sourcePaneId);
    const parentId = ancestors.at(-1);
    const source = this.workerSource(worker.projectId, ancestors)?.panel;
    const currentPath = this.workerAncestors(source);
    const path =
      source?.spec._tag === 'Session' &&
      source.spec.sessionId === parentId &&
      ancestors.length === 1
        ? [...currentPath, ...ancestors]
        : ancestors;
    if (fromPane !== undefined) this.clearOverlayForTab(fromPane.tab.id, false);
    return this.navigateSession(worker, source, path);
  }

  private workerSource(projectId: ProjectId, ancestors: ReadonlyArray<SessionId>) {
    for (const id of [...ancestors].reverse()) {
      const source = this.sessionPane(projectId, id);
      if (source !== undefined) return source;
    }
    return undefined;
  }

  canOpenWorkerInSplit(
    worker: SessionId,
    projectId: ProjectId,
    ancestors: ReadonlyArray<SessionId>,
  ): boolean {
    const source = this.workerSource(projectId, ancestors);
    return (
      this.isOpen(worker) ||
      (source !== undefined && this.paneCount(source.tab) < MAX_PANES_PER_TAB)
    );
  }

  openWorkerInSplit(worker: OpenSession, ancestors: ReadonlyArray<SessionId>): void {
    if (this.isOpen(worker.id)) {
      this.open(worker);
      return;
    }
    const source = this.workerSource(worker.projectId, ancestors);
    if (source === undefined || this.paneCount(source.tab) >= MAX_PANES_PER_TAB) return;
    this.rememberSessionMeta(worker);
    this.clearOverlayForTab(source.tab.id, false);
    this.splitPane(source.pane.id, 'right', { _tag: 'Session', sessionId: worker.id });
  }

  saveThreadPosition(sessionId: SessionId, position: ThreadPosition): void {
    this.threadPositions.set(sessionId, position);
  }

  threadPosition(sessionId: SessionId): ThreadPosition | undefined {
    return this.threadPositions.get(sessionId);
  }

  private openTabOverlay(
    kind: 'Changes' | 'Workers',
    sessionId: SessionId,
    sourcePaneId?: PaneId,
    projectId?: ProjectId,
  ): TabId | null {
    const current = this._workspace();
    const fromPane = sourcePaneId === undefined ? undefined : findPane(current, sourcePaneId);
    const fromSession = fromPane === undefined ? findSessionPanel(current, sessionId) : undefined;
    const fallbackTab =
      fromPane === undefined && fromSession === undefined
        ? activeTabOf(current, projectId ?? current.activeProjectId)
        : undefined;
    const existingTab = fromPane?.tab ?? fromSession?.tab ?? fallbackTab;
    const resolvedPaneId = sourcePaneId ?? fromSession?.pane.id;

    if (existingTab !== undefined) {
      const next = activateTabLayout(current, existingTab.id);
      const foundTab = findTab(current, existingTab.id);
      const currentActiveTabId =
        foundTab === undefined ? undefined : findProject(current, foundTab.projectId)?.activeTabId;
      const changed =
        next.activeProjectId !== current.activeProjectId || currentActiveTabId !== existingTab.id;
      this.setOverlayForTab(
        existingTab.id,
        {
          kind,
          sessionId,
          ...(resolvedPaneId === undefined ? {} : { sourcePaneId: resolvedPaneId }),
        },
        !changed,
      );
      if (changed) {
        this.commitWorkspace(next);
      }
      this.bumpActivation();
      return existingTab.id;
    }

    const targetProjectId =
      projectId ?? current.activeProjectId ?? this._sessionMeta().get(sessionId)?.projectId;
    if (targetProjectId === undefined) return null;
    const opened = openSessionTab(current, {
      projectId: targetProjectId,
      sessionId,
      createIds: () => this.createIds(),
    });
    const paneId = allTabLeaves(opened.tab)[0]?.id;
    this.setOverlayForTab(
      opened.tabId,
      {
        kind,
        sessionId,
        ...(paneId === undefined ? {} : { sourcePaneId: paneId }),
      },
      false,
    );
    this.commitWorkspace(opened.workspace);
    this.bumpActivation();
    return opened.tabId;
  }

  /** Closes any Panels and Tab overlays bound to `sessionId` across all Projects. */
  closeSession(sessionId: SessionId): void {
    const current = this._workspace();
    const next = pruneSession(current, sessionId);
    if (next === current) {
      this.clearOverlaysWhere((overlay) => overlay.sessionId === sessionId);
      return;
    }
    this.clearOverlaysWhere((overlay) => overlay.sessionId === sessionId, false);
    this.commitWorkspace(next);
  }

  /**
   * Closes any Panels and Tab overlays bound to `targets` and any open Worker descendants whose
   * `parentSessionId` chain traces back to any target, persisting once via `Tabs.update`.
   */
  closeSessionWithDescendants(targets: SessionId | ReadonlyArray<SessionId>): void {
    const roots = new Set(Array.isArray(targets) ? targets : [targets]);
    if (roots.size === 0) return;
    const current = this._workspace();
    const toPrune = new Set<SessionId>();
    const tracesToRoot = (id: SessionId): boolean => {
      const seen = new Set<SessionId>();
      let cursor: SessionId | undefined = id;
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        if (roots.has(cursor)) return true;
        cursor = this.liveStates.get(cursor)?.parentSessionId;
      }
      return false;
    };
    for (const id of allReferencedSessionIds(current)) {
      if (tracesToRoot(id)) toPrune.add(id);
    }
    for (const tab of this.allTabs()) {
      for (const panel of allTabPanels(tab)) {
        if (
          panel.spec.sessionId !== undefined &&
          this.workerAncestors(panel).some((id) => roots.has(id))
        ) {
          toPrune.add(panel.spec.sessionId);
        }
      }
    }
    for (const overlay of this._tabOverlays().values()) {
      if (tracesToRoot(overlay.sessionId)) toPrune.add(overlay.sessionId);
    }
    if (toPrune.size === 0) return;
    this.clearOverlaysWhere((overlay) => toPrune.has(overlay.sessionId), false);
    this.commitWorkspace(pruneSessions(current, (id) => toPrune.has(id)));
  }

  /** Closes all open Tabs belonging to `projectId` (e.g. when a Project is removed). */
  closeProject(projectId: ProjectId): void {
    const current = this._workspace();
    const project = findProject(current, projectId);
    const hasProject =
      current.projects.some((p) => p.projectId === projectId) ||
      current.activeProjectId === projectId;
    if (project !== undefined) {
      const tabIds = new Set(project.tabs.map((tab) => tab.id));
      this.clearOverlaysWhere((_overlay, tabId) => tabIds.has(tabId), !hasProject);
    }
    if (!hasProject) {
      return;
    }
    this.commitWorkspace(pruneProject(current, projectId));
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
        status: session.status ?? existing?.status ?? 'idle',
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
      const normalized = normalizeWorkspace(restored.workspace);
      const shouldReport =
        normalized.projects.length > 0 || normalized.activeProjectId !== undefined;
      this.commitWorkspace(normalized, { report: shouldReport });
      this._restored.set(true);
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
      const device = existing.device ?? prior.device;
      mergedProjects.set(existing.projectId, {
        projectId: existing.projectId,
        ...(device === undefined ? {} : { device }),
        tabs: mergedTabs,
        ...(existing.activeTabId !== undefined
          ? { activeTabId: existing.activeTabId }
          : prior.activeTabId !== undefined
            ? { activeTabId: prior.activeTabId }
            : {}),
      });
    }
    const activeProjectId = current.activeProjectId ?? restored.workspace.activeProjectId;
    const mergedWallpapers = {
      ...(restored.workspace.sessionWallpapers ?? {}),
      ...(current.sessionWallpapers ?? {}),
    };
    const merged = normalizeWorkspace({
      projects: [...mergedProjects.values()],
      ...(activeProjectId === undefined ? {} : { activeProjectId }),
      ...(Object.keys(mergedWallpapers).length === 0
        ? {}
        : { sessionWallpapers: mergedWallpapers }),
    });
    this.commitWorkspace(merged);
    this._restored.set(true);
  }

  private commitWorkspace(next: WorkspaceState, options?: { readonly report?: boolean }): void {
    const withWallpapers = this.ensureWallpapers(next);
    this._workspace.set(withWallpapers);
    this.recordMru(withWallpapers);
    if (options?.report !== false) {
      this.reportTabs();
    } else {
      this.reportVisibilityIfChanged();
    }
  }

  private ensureWallpapers(workspace: WorkspaceState): WorkspaceState {
    const gallery = new Set(this.backgrounds.gallery().map((item) => item.id));
    if (gallery.size === 0) return workspace;
    const existingSession = workspace.sessionWallpapers ?? {};
    let nextSession: Record<SessionId, string> | null = null;
    const nextPanels = new Map(this._panelWallpapers());
    let panelsChanged = false;

    const used = new Set<string>(Object.values(existingSession));
    for (const value of nextPanels.values()) used.add(value);

    for (const project of workspace.projects) {
      for (const tab of project.tabs) {
        for (const panel of allTabPanels(tab)) {
          if (panel.spec._tag !== 'Session') continue;
          const sid = panel.spec.sessionId;
          if (sid !== undefined) {
            const currentAssigned = (nextSession ?? existingSession)[sid];
            if (currentAssigned === undefined || !gallery.has(currentAssigned)) {
              const fromPanel = nextPanels.get(panel.id);
              const chosen =
                fromPanel !== undefined && gallery.has(fromPanel)
                  ? fromPanel
                  : this.backgrounds.pickNext(used, this.lastAssignedWallpaper);
              if (chosen === undefined) continue;
              if (nextSession === null) nextSession = { ...existingSession };
              nextSession[sid] = chosen;
              used.add(chosen);
              this.lastAssignedWallpaper = chosen;
            }
            if (nextPanels.delete(panel.id)) panelsChanged = true;
          } else {
            const currentAssigned = nextPanels.get(panel.id);
            if (currentAssigned !== undefined && gallery.has(currentAssigned)) continue;
            const chosen = this.backgrounds.pickNext(used, this.lastAssignedWallpaper);
            if (chosen === undefined) continue;
            nextPanels.set(panel.id, chosen);
            used.add(chosen);
            this.lastAssignedWallpaper = chosen;
            panelsChanged = true;
          }
        }
      }
    }

    if (panelsChanged) {
      this._panelWallpapers.set(nextPanels);
    }
    if (nextSession === null) return workspace;
    return { ...workspace, sessionWallpapers: nextSession };
  }

  private recordMru(workspace: WorkspaceState): void {
    const activeProjectId = workspace.activeProjectId;
    if (activeProjectId === undefined) return;
    const project = findProject(workspace, activeProjectId);
    if (project === undefined || project.activeTabId === undefined) return;
    const activeTabId = project.activeTabId;
    if (!project.tabs.some((tab) => tab.id === activeTabId)) return;
    const validIds = new Set(project.tabs.map((tab) => tab.id));

    this._mruByProject.update((current) => {
      const prior = current.get(activeProjectId) ?? [];
      if (prior[0] === activeTabId && prior.every((id) => validIds.has(id))) {
        return current;
      }
      const next = new Map(current);
      next.set(activeProjectId, [
        activeTabId,
        ...prior.filter((id) => id !== activeTabId && validIds.has(id)),
      ]);
      return next;
    });
  }

  private setOverlayForTab(tabId: TabId, overlay: TabOverlay, reportVisibility = true): void {
    this._tabOverlays.update((current) => {
      const next = new Map(current);
      next.set(tabId, overlay);
      return next;
    });
    if (reportVisibility) this.reportVisibilityIfChanged();
  }

  private clearOverlayForTab(tabId: TabId, reportVisibility = true): void {
    if (!this._tabOverlays().has(tabId)) return;
    this._tabOverlays.update((current) => {
      const next = new Map(current);
      next.delete(tabId);
      return next;
    });
    if (reportVisibility) this.reportVisibilityIfChanged();
  }

  private clearOverlaysWhere(
    predicate: (overlay: TabOverlay, tabId: TabId) => boolean,
    reportVisibility = true,
  ): void {
    const current = this._tabOverlays();
    let changed = false;
    const next = new Map<TabId, TabOverlay>();
    for (const [tabId, overlay] of current) {
      if (predicate(overlay, tabId)) {
        changed = true;
      } else {
        next.set(tabId, overlay);
      }
    }
    if (changed) {
      this._tabOverlays.set(next);
      if (reportVisibility) this.reportVisibilityIfChanged();
    }
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

  private createSplitIds(): SplitIdsFactory {
    const seq = this.nextId;
    this.nextId += 1;
    const suffix = `${seq}-${createUuid()}`;
    return {
      splitPaneId: PaneId.make(`split:${suffix}`),
      newPaneId: PaneId.make(`pane:${suffix}`),
      panelId: PanelId.make(`panel:${suffix}`),
    };
  }

  private bumpActivation(): void {
    this._activations.update((count) => count + 1);
  }

  private reportVisibilityIfChanged(): void {
    const obscured = this.isObscured();
    if (obscured === this.lastReportedObscured) return;
    this.lastReportedObscured = obscured;
    void this.runtime.run(setTabsVisibility(obscured)(), { signal: this.aborts.signal });
  }

  /**
   * Tells main the window's Workspace. A Remote Project's workspace is the viewer's own, never the host's:
   * main only remembers its layout and cached Session summaries, and never connects them.
   */
  private reportTabs(): void {
    const workspace = this._workspace();
    const obscured = this.isObscured();
    this.lastReportedObscured = obscured;
    const remoteSessions = workspace.projects
      .filter((project) => project.device !== undefined)
      .flatMap((project) => this.sessionsInProject(project.projectId));
    void this.runtime.run(updateTabs(workspace, remoteSessions, obscured)(), {
      signal: this.aborts.signal,
    });
  }
}

export const titleOf = (title: SessionTitle): string | null => {
  if (title.user !== undefined) return title.user;
  if (title.auto !== undefined) return title.auto;
  const count = title.autoImageCount;
  if (count === undefined) return null;
  return count === 1 ? $localize`Image` : $localize`${count}:count: Images`;
};
