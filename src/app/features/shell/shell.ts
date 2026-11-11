import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';
import { ProtoSidebar } from '../sidebar-prototype/sidebar-prototype';
import { HlmSidebarImports } from '@ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { SettingsDialog } from './settings-dialog';

/** The window's frame: the sidebar on one side, and whatever view the router shows beside it. */
@Component({
  selector: 'app-shell',
  imports: [HlmSidebarImports, AppSidebar, SettingsDialog, RouterOutlet, ProtoSidebar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div hlmSidebarWrapper>
      <!-- PROTOTYPE (branch prototype/project-sidebar): issue #19 -->
      @if (protoSidebar()) {
        <proto-sidebar />
      } @else {
        <app-sidebar />
      }
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
export class Shell {
  private readonly router = inject(Router);
  protected readonly protoSidebar = toSignal(
    this.router.events.pipe(map(() => this.router.url.startsWith('/prototype/sidebar'))),
    { initialValue: false },
  );
}
