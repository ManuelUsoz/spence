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
import { Keymap } from '../../core/keymap';
import { CHANGES_VIEW, ChangesState, changesSessionOf } from '../../core/changes-view';
import { SESSION_VIEW } from '../../core/session-view';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';
import { ProjectSettingsSheet } from './project-settings-sheet';
import { ProjectsState } from './projects-state';
import { SessionConfirmDialog } from './session-confirm-dialog';
import { SettingsPage } from './settings/settings-page';
import { SettingsState } from './settings-state';
import { TopBar } from './top-bar';

/**
 * The window's frame: the sidebar on one side; beside it the top bar and the open Session, or whatever view the
 * router shows when no Session is open.
 */
@Component({
  selector: 'app-shell',
  imports: [
    HlmSidebarImports,
    HlmToasterImports,
    AppSidebar,
    SettingsPage,
    ProjectSettingsSheet,
    RouterOutlet,
    TopBar,
    SessionConfirmDialog,
    NgComponentOutlet,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div hlmSidebarWrapper>
      <app-sidebar />
      <main hlmSidebarInset class="min-w-0">
        <app-top-bar />
        <div class="flex-1 p-6">
          @if (settings.open()) {
            <app-settings-page />
          } @else if (tabs.active(); as tab) {
            @if (changes.open() && changesView && changesSessionOf(tab); as sessionId) {
              <ng-container
                *ngComponentOutlet="
                  changesView;
                  inputs: { sessionId, running: tab.running ?? false, draft: tab.session === null }
                "
              />
            } @else if (sessionView; as view) {
              <ng-container
                *ngComponentOutlet="view; inputs: { tab, projectName: projectName() }"
              />
            }
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
      for (const tab of this.tabs.tabs()) {
        if (!listed.has(tab.projectId)) this.tabs.closeProject(tab.projectId);
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
  }

  protected readonly projectName = computed(() => {
    const projectId = this.tabs.active()?.projectId;
    return this.projects.ordered().find((project) => project.id === projectId)?.name ?? '';
  });
}
