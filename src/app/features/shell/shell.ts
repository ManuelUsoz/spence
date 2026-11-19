import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmBreadcrumbImports } from '@ui/breadcrumb';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmToasterImports } from '@ui/sonner';
import type { Project } from '../../../shared/projects/projects.rpc';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { LeafPaneNode } from '../../../shared/tabs/tabs.rpc';
import { allTabLeaves } from '../../../shared/tabs/workspace-layout';
import { CHANGES_VIEW, ChangesState } from '../../core/changes-view';
import { Keymap } from '../../core/keymap';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';
import { EmptyWorkspace } from './empty-workspace';
import { PaneView } from './pane-view';
import { ProjectSettingsSheet } from './project-settings-sheet';
import { ProjectsState } from './projects-state';
import { SessionConfirmDialog } from './session-confirm-dialog';
import { SettingsPage } from './settings/settings-page';
import { SettingsState } from './settings-state';
import { TabStrip } from './tab-strip';

/**
 * The window's frame: the sidebar on one side; beside it the per-Project Tab strip and active Tab's
 * Pane/Panel views (each Panel carrying its own compact PanelHeader), empty workspace state, or
 * Settings / no-Project router views.
 */
@Component({
  selector: 'app-shell',
  imports: [
    HlmBreadcrumbImports,
    HlmSidebarImports,
    HlmToasterImports,
    AppSidebar,
    EmptyWorkspace,
    PaneView,
    SettingsPage,
    ProjectSettingsSheet,
    RouterOutlet,
    TabStrip,
    SessionConfirmDialog,
    NgComponentOutlet,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div hlmSidebarWrapper>
      <app-sidebar />
      <main hlmSidebarInset class="h-svh min-w-0 overflow-hidden">
        @if (settings.open()) {
          <header
            class="border-border/60 flex h-11 min-w-0 shrink-0 items-center gap-2 border-b px-3"
            data-testid="settings-header"
          >
            <button hlmSidebarTrigger srOnlyText="Toggle sidebar" i18n-srOnlyText></button>
            <nav hlmBreadcrumb aria-label="Breadcrumb" i18n-aria-label class="min-w-0 flex-1">
              <ol hlmBreadcrumbList class="flex-nowrap text-sm">
                <li hlmBreadcrumbItem class="min-w-0">
                  <button
                    type="button"
                    class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-2 h-7 max-w-64 truncate rounded-lg px-2 outline-none focus-visible:ring-2"
                    data-testid="settings-back"
                    (click)="settings.set(false)"
                  >
                    {{ settingsBackLabel() }}
                  </button>
                </li>
                <li hlmBreadcrumbSeparator></li>
                <li hlmBreadcrumbItem>
                  <h1 hlmBreadcrumbPage class="font-medium" i18n>Settings</h1>
                </li>
              </ol>
            </nav>
            <span class="text-muted-foreground hidden shrink-0 text-xs sm:inline" i18n
              >Changes apply at once</span
            >
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto p-6">
            <app-settings-page />
          </div>
        } @else if (activeProject(); as project) {
          <app-tab-strip />
          @if (tabs.activeTab(); as activeTab) {
            @if (changes.open() && changesView && activeChangesSession(); as sessionId) {
              <header
                class="border-border/60 flex h-9 min-w-0 shrink-0 items-center gap-1.5 border-b px-3"
                data-testid="changes-header"
              >
                <button
                  type="button"
                  class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring -ms-1.5 flex h-7 max-w-64 items-center gap-1 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2"
                  data-testid="changes-back"
                  (click)="changes.set(false)"
                >
                  <svg
                    aria-hidden="true"
                    class="size-[13px] shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                  <span class="truncate">{{ activeChangesTitle() }}</span>
                </button>
                <span aria-hidden="true" class="text-muted-foreground/60 text-xs select-none"
                  >/</span
                >
                <span class="text-sm font-medium" i18n>Changes</span>
              </header>
              <div class="min-h-0 flex-1 overflow-y-auto p-6">
                <ng-container
                  *ngComponentOutlet="
                    changesView;
                    inputs: { sessionId, running: activeChangesRunning() }
                  "
                />
              </div>
            } @else {
              <div class="flex min-h-0 flex-1 overflow-hidden">
                @for (leaf of activeLeaves(); track leaf.id) {
                  <app-pane-view
                    [pane]="leaf"
                    [projectId]="project.id"
                    [projectName]="project.name"
                    [focusedPanelId]="activeTab.focusedPanelId"
                  />
                }
              </div>
            }
          } @else {
            <div class="min-h-0 flex-1 overflow-y-auto">
              <app-empty-workspace [project]="project" />
            </div>
          }
        } @else {
          <header
            class="border-border/60 flex h-11 min-w-0 shrink-0 items-center gap-2 border-b px-3"
          >
            <button hlmSidebarTrigger srOnlyText="Toggle sidebar" i18n-srOnlyText></button>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto p-6">
            <router-outlet />
          </div>
        }
      </main>
    </div>
    <app-project-settings-sheet />
    <app-session-confirm-dialog />
    <!-- prefers-color-scheme follows the Theme Setting: main sets nativeTheme.themeSource. -->
    <hlm-toaster theme="system" />
  `,
})
export class Shell {
  protected readonly tabs = inject(Tabs);
  private readonly projects = inject(ProjectsState);
  private readonly keymap = inject(Keymap);
  protected readonly settings = inject(SettingsState);
  protected readonly changes = inject(ChangesState);
  protected readonly changesView = inject(CHANGES_VIEW);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly activeProject = computed((): Project | null => {
    const ordered = this.projects.ordered();
    const activeId = this.tabs.activeProjectId();
    if (activeId !== null) {
      const matched = ordered.find((project) => project.id === activeId);
      if (matched !== undefined) return matched;
    }
    return this.projects.lastUsed();
  });

  protected readonly activeLeaves = computed((): ReadonlyArray<LeafPaneNode> => {
    const tab = this.tabs.activeTab();
    return tab === null ? [] : allTabLeaves(tab);
  });

  protected readonly settingsBackLabel = computed((): string => {
    const activeTab = this.tabs.activeTab();
    if (activeTab !== null) return this.tabs.tabTitle(activeTab).label;
    return this.activeProject()?.name ?? 'Spence';
  });

  /** Temporary ChangesState target SessionId until #206 turns Changes into a Panel type. */
  protected readonly activeChangesSession = computed((): SessionId | null => {
    const panel = this.tabs.focusedPanel();
    if (panel === null || panel.spec._tag !== 'Session') return null;
    return panel.spec.sessionId ?? null;
  });

  protected readonly activeChangesRunning = computed((): boolean => {
    const id = this.activeChangesSession();
    return id !== null && (this.tabs.sessionStatus(id)?.running ?? false);
  });

  protected readonly activeChangesTitle = computed((): string => {
    const panel = this.tabs.focusedPanel();
    if (panel === null) return $localize`New Session`;
    return this.tabs.panelTitle(panel) ?? $localize`New Session`;
  });

  constructor() {
    this.registerShortcuts();
    // Asking for a Tab (a Session row, a new Session, a shortcut) leaves the Settings page.
    effect(() => {
      this.tabs.activations();
      untracked(() => {
        this.settings.set(false);
        this.changes.set(false);
      });
    });
    effect(() => {
      const state = this.projects.state();
      if (state.status !== 'loaded') return;
      const listed = new Set(state.projects.map((project) => project.id));
      for (const project of this.tabs.workspace().projects) {
        if (!listed.has(project.projectId)) this.tabs.closeProject(project.projectId);
      }
      const activeId = this.tabs.activeProjectId();
      if (activeId !== null && !listed.has(activeId)) {
        this.tabs.closeProject(activeId);
      }
    });
  }

  private registerShortcuts(): void {
    const destroyRef = this.destroyRef;

    this.keymap.register({
      binding: { mod: true, key: ',' },
      run: () => this.settings.show(),
      destroyRef,
    });

    this.keymap.register({
      binding: { mod: true, key: 't' },
      when: () => this.activeProject() !== null,
      run: () => {
        const project = this.activeProject();
        if (project !== null) this.tabs.newTab(project.id);
      },
      destroyRef,
    });

    this.keymap.register({
      binding: { mod: true, key: 'w' },
      when: () => !this.settings.open() && this.tabs.focusedPanel() !== null,
      run: () => {
        const panel = this.tabs.focusedPanel();
        if (panel !== null) this.tabs.closePanel(panel.id);
      },
      destroyRef,
    });

    this.keymap.register({
      binding: { ctrl: true, code: 'Tab' },
      when: () => !this.settings.open() && this.tabs.tabs().length > 0,
      run: () => this.tabs.next(),
      destroyRef,
    });

    this.keymap.register({
      binding: { ctrl: true, shift: true, code: 'Tab' },
      when: () => !this.settings.open() && this.tabs.tabs().length > 0,
      run: () => this.tabs.prev(),
      destroyRef,
    });

    for (let index = 0; index < 8; index += 1) {
      this.keymap.register({
        binding: { mod: true, code: `Digit${index + 1}` },
        when: () => this.tabs.tabs().length > index,
        run: () => this.tabs.activateIndex(index),
        destroyRef,
      });
    }

    this.keymap.register({
      binding: { mod: true, code: 'Digit9' },
      when: () => this.tabs.tabs().length > 0,
      run: () => this.tabs.activateLast(),
      destroyRef,
    });
  }
}
