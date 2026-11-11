import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports } from '@ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { SettingsDialog } from './settings-dialog';

/** The window's frame: the sidebar on one side, and whatever view the router shows beside it. */
@Component({
  selector: 'app-shell',
  imports: [HlmSidebarImports, AppSidebar, SettingsDialog, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div hlmSidebarWrapper>
      <app-sidebar />
      <main hlmSidebarInset>
        <header class="flex h-12 items-center gap-2 px-3">
          <button hlmSidebarTrigger></button>
          <h1 class="text-lg font-semibold">Spence</h1>
        </header>
        <div class="flex-1 p-6">
          <router-outlet />
        </div>
      </main>
    </div>
    <app-settings-dialog />
  `,
})
export class Shell {}
