import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { HlmButtonImports } from '@ui/button';
import { toast } from '@ui/toast';
import { Effect, Exit } from 'effect';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmToasterImports } from '@ui/sonner';
import { AppSidebar } from './app-sidebar';
import { ProjectsState } from './projects-state';
import { SettingsDialog } from './settings-dialog';

const createSession = Effect.fnUntraced(function* (projectId: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Session.create']({ projectId });
});

/** The window's frame: the sidebar on one side, and whatever view the router shows beside it. */
@Component({
  selector: 'app-shell',
  imports: [
    HlmButtonImports,
    HlmSidebarImports,
    HlmToasterImports,
    AppSidebar,
    SettingsDialog,
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
          <!-- Temporary: the sidebar's New Session replaces it. Starts a Session in the first Project. -->
          <button
            hlmBtn
            size="sm"
            variant="outline"
            class="ml-auto"
            data-testid="new-session"
            [disabled]="firstProject() === null"
            (click)="newSession()"
            i18n
          >
            New Session
          </button>
        </header>
        <div class="flex-1 p-6">
          <router-outlet />
        </div>
      </main>
    </div>
    <app-settings-dialog />
    <!-- prefers-color-scheme follows the Theme Setting: main sets nativeTheme.themeSource. -->
    <hlm-toaster theme="system" />
  `,
})
export class Shell {
  private readonly runtime = inject(EffectRuntime);
  private readonly router = inject(Router);
  private readonly projects = inject(ProjectsState);

  protected readonly firstProject = computed(() => {
    const state = this.projects.state();
    return state.status === 'loaded' ? (state.projects[0] ?? null) : null;
  });

  protected async newSession(): Promise<void> {
    const project = this.firstProject();
    if (project === null) return;
    const exit = await this.runtime.run(createSession(project.id));
    if (Exit.isFailure(exit)) {
      toast.error($localize`Could not start a Session.`);
      return;
    }
    await this.router.navigate(['/sessions', exit.value]);
  }
}
