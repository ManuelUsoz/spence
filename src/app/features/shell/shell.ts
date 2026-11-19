import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmToasterImports } from '@ui/sonner';
import type { Project } from '../../../shared/projects/projects.rpc';
import { Keymap } from '../../core/keymap';
import { CHANGES_VIEW, ChangesState, changesSessionOf } from '../../core/changes-view';
import { SESSION_VIEW } from '../../core/session-view';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';
import { EmptyWorkspace } from './empty-workspace';
import { ProjectSettingsSheet } from './project-settings-sheet';
import { ProjectsState } from './projects-state';
import { SessionConfirmDialog } from './session-confirm-dialog';
import { SettingsPage } from './settings/settings-page';
import { SettingsState } from './settings-state';
import { TabStrip } from './tab-strip';
import { TopBar } from './top-bar';

/**
 * The window's frame: the sidebar on one side; beside it the per-Project Tab strip, TopBar, active Session/view
 * or empty workspace state, or Settings / app-info router views.
 */
@Component({
  selector: 'app-shell',
  imports: [
    HlmSidebarImports,
    HlmToasterImports,
    AppSidebar,
    EmptyWorkspace,
    SettingsPage,
    ProjectSettingsSheet,
    RouterOutlet,
    TabStrip,
    TopBar,
    SessionConfirmDialog,
    NgComponentOutlet,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div hlmSidebarWrapper>
      <app-sidebar />
      <main hlmSidebarInset class="min-w-0">
        @if (settings.open()) {
          <app-top-bar />
        } @else if (activeProject(); as project) {
          <app-tab-strip />
          @if (tabs.active()) {
            <app-top-bar [showSidebarTrigger]="false" />
          }
        } @else {
          <app-top-bar />
        }
        <div class="flex-1 p-6">
          @if (settings.open()) {
            <app-settings-page />
          } @else if (tabs.active(); as tab) {
            @if (changes.open() && changesView && changesSessionOf(tab); as sessionId) {
              <ng-container
                *ngComponentOutlet="
                  changesView;
                  inputs: { sessionId, running: tab.running ?? false }
                "
              />
            } @else if (sessionView; as view) {
              <ng-container
                *ngComponentOutlet="view; inputs: { tab, projectName: projectName() }"
              />
            }
          } @else if (activeProject(); as project) {
            <app-empty-workspace [project]="project" />
          } @else {
            <router-outlet />
          }
        </div>
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
  protected readonly sessionView = inject(SESSION_VIEW);
  private readonly projects = inject(ProjectsState);
  private readonly keymap = inject(Keymap);
  protected readonly settings = inject(SettingsState);
  protected readonly changes = inject(ChangesState);
  protected readonly changesView = inject(CHANGES_VIEW);
  protected readonly changesSessionOf = changesSessionOf;
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

  protected readonly projectName = computed(() => {
    const projectId = this.tabs.active()?.projectId ?? this.activeProject()?.id;
    return this.projects.ordered().find((project) => project.id === projectId)?.name ?? '';
  });
}
