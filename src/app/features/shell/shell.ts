import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmToasterImports } from '@ui/sonner';
import { SESSION_VIEW } from '../../core/session-view';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';
import { ProjectsState } from './projects-state';
import { SessionPlaceholder } from './session-placeholder';
import { SettingsDialog } from './settings-dialog';
import { TabStrip } from './tab-strip';

/**
 * The window's frame: the sidebar on one side; beside it the Tab strip and the active Tab's Session, or whatever
 * view the router shows when no Tab is open.
 */
@Component({
  selector: 'app-shell',
  imports: [
    HlmSidebarImports,
    HlmToasterImports,
    AppSidebar,
    SettingsDialog,
    RouterOutlet,
    TabStrip,
    SessionPlaceholder,
    NgComponentOutlet,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div hlmSidebarWrapper>
      <app-sidebar />
      <main hlmSidebarInset class="min-w-0">
        <header class="flex h-12 min-w-0 items-center gap-2 px-3">
          <button hlmSidebarTrigger srOnlyText="Toggle sidebar" i18n-srOnlyText></button>
          <app-tab-strip />
        </header>
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
    <!-- prefers-color-scheme follows the Theme Setting: main sets nativeTheme.themeSource. -->
    <hlm-toaster theme="system" />
  `,
})
export class Shell {
  protected readonly tabs = inject(Tabs);
  protected readonly sessionView = inject(SESSION_VIEW);
  private readonly projects = inject(ProjectsState);

  protected readonly projectName = computed(() => {
    const projectId = this.tabs.active()?.projectId;
    return this.projects.ordered().find((project) => project.id === projectId)?.name ?? '';
  });
}
