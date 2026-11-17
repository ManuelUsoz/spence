import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmToasterImports } from '@ui/sonner';
import { Keymap } from '../../core/keymap';
import { SESSION_VIEW } from '../../core/session-view';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';
import { ProjectSettingsSheet } from './project-settings-sheet';
import { ProjectsState } from './projects-state';
import { SessionConfirmDialog } from './session-confirm-dialog';
import { SessionPlaceholder } from './session-placeholder';
import { SettingsDialog } from './settings-dialog';
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
    SettingsDialog,
    ProjectSettingsSheet,
    RouterOutlet,
    TopBar,
    SessionPlaceholder,
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
          @if (tabs.active(); as tab) {
            <app-session-placeholder [tab]="tab" [projectName]="projectName()" />
            @if (sessionView; as view) {
              <ng-container *ngComponentOutlet="view; inputs: { tab }" />
            }
          } @else {
            <router-outlet />
          }
        </div>
      </main>
    </div>
    <app-settings-dialog />
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
  private readonly settings = inject(SettingsState);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.registerShortcuts();
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
