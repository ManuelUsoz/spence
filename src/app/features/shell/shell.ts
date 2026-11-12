import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmToasterImports } from '@ui/sonner';
import { AppSidebar } from './app-sidebar';
import { ProjectSettingsSheet } from './project-settings-sheet';
import { SettingsDialog } from './settings-dialog';

/** The window's frame: the sidebar on one side, and whatever view the router shows beside it. */
@Component({
  selector: 'app-shell',
  imports: [
    HlmSidebarImports,
    HlmToasterImports,
    AppSidebar,
    SettingsDialog,
    ProjectSettingsSheet,
    RouterOutlet,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div hlmSidebarWrapper>
      <app-sidebar />
      <main hlmSidebarInset>
        <header class="flex h-12 items-center gap-2 px-3">
          <button hlmSidebarTrigger srOnlyText="Toggle sidebar" i18n-srOnlyText></button>
          <h1 class="text-lg font-semibold">Spence</h1>
        </header>
        <div class="flex-1 p-6">
          <router-outlet />
        </div>
      </main>
    </div>
    <app-settings-dialog />
    <app-project-settings-sheet />
    <!-- prefers-color-scheme follows the Theme Setting: main sets nativeTheme.themeSource. -->
    <hlm-toaster theme="system" />
  `,
})
export class Shell {}
