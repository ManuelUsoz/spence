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
import { MAX_PANES_PER_TAB } from '../../../shared/tabs/workspace-layout';
import { Keymap } from '../../core/keymap';
import { RemoteDevices } from '../../core/remote-devices';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';
import { EmptyWorkspace } from './empty-workspace';
import { FolderBrowserDialog } from './folder-browser-dialog';
import { HostChip } from './host-chip';
import { PaneTree } from './pane-tree';
import { type DeviceProject, ProjectsState } from './projects-state';
import { SendToSessionDialog } from './send-to-session-dialog';
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
    PaneTree,
    SettingsPage,
    FolderBrowserDialog,
    HostChip,
    RouterOutlet,
    TabStrip,
    SessionConfirmDialog,
    SendToSessionDialog,
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
            <app-host-chip />
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto p-6">
            <app-settings-page />
          </div>
        } @else if (activeProject(); as project) {
          <app-tab-strip />
          @if (tabs.activeTab(); as activeTab) {
            <div class="flex min-h-0 flex-1 overflow-hidden">
              <app-pane-tree
                [tabId]="activeTab.id"
                [layout]="activeTab.layout"
                [projectId]="project.id"
                [projectName]="project.name"
                [focusedPanelId]="activeTab.focusedPanelId"
                [canSplit]="canSplitActiveTab()"
              />
            </div>
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
            <div class="flex-1"></div>
            <app-host-chip />
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto p-6">
            <router-outlet />
          </div>
        }
      </main>
    </div>
    <app-folder-browser-dialog />
    <app-session-confirm-dialog />
    <app-send-to-session-dialog />
    <!-- prefers-color-scheme follows the Theme Setting: main sets nativeTheme.themeSource. -->
    <hlm-toaster theme="system" />
  `,
})
export class Shell {
  protected readonly tabs = inject(Tabs);
  private readonly projects = inject(ProjectsState);
  private readonly devices = inject(RemoteDevices);
  private readonly keymap = inject(Keymap);
  protected readonly settings = inject(SettingsState);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly activeProject = computed((): DeviceProject | null => {
    const ordered = this.projects.ordered();
    const activeId = this.tabs.activeProjectId();
    if (activeId !== null) {
      const matched = this.projects.known(activeId);
      if (matched !== undefined) return matched;
      const device = this.tabs.projectDevice(activeId);
      if (device !== undefined) {
        return {
          id: activeId,
          name: this.devices.nameOf(device) ?? '',
          path: '',
          addedAt: 0,
          lastUsedAt: 0,
          settings: {},
          folderMissing: false,
          device,
        };
      }
    }
    return this.projects.lastUsed() ?? ordered[0] ?? null;
  });

  protected readonly canSplitActiveTab = computed((): boolean => {
    const tab = this.tabs.activeTab();
    return tab !== null && this.tabs.paneCount(tab) < MAX_PANES_PER_TAB;
  });

  protected readonly settingsBackLabel = computed((): string => {
    const activeTab = this.tabs.activeTab();
    if (activeTab !== null) return this.tabs.tabTitle(activeTab).label;
    return this.activeProject()?.name ?? 'Spence';
  });

  constructor() {
    this.registerShortcuts();
    // Asking for a Tab (a Session row, a new Session, a shortcut) leaves the Settings page.
    effect(() => {
      this.tabs.activations();
      untracked(() => {
        this.settings.set(false);
      });
    });
    effect(() => {
      const state = this.projects.state();
      if (state.status !== 'loaded') return;
      const listed = new Set(state.projects.map((project) => project.id));
      for (const project of this.tabs.workspace().projects) {
        // A Remote Project's workspace is not the Local device's to close here.
        if (project.device === undefined && !listed.has(project.projectId)) {
          this.tabs.closeProject(project.projectId);
        }
      }
      const activeId = this.tabs.activeProjectId();
      if (
        activeId !== null &&
        this.tabs.projectDevice(activeId) === undefined &&
        this.projects.deviceOf(activeId) === undefined &&
        !listed.has(activeId)
      ) {
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
        if (project !== null) this.tabs.newTab(project.id, project.device);
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
