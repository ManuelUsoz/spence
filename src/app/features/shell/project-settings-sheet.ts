import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmLabelImports } from '@ui/label';
import { HlmSheetImports } from '@ui/sheet';
import { HlmSwitchImports } from '@ui/switch';
import { toast } from '@ui/toast';
import { HlmToggleGroupImports } from '@ui/toggle-group';
import { Effect, Schema } from 'effect';
import {
  PermissionMode,
  type Project,
  type ProjectSettingsPatch,
} from '../../../shared/projects/projects.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Keymap } from '../../core/keymap';
import { ProjectSettingsState } from './project-settings-state';
import { ProjectsState } from './projects-state';

const getSettings = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['Settings.get']();
});

const setSettings = Effect.fnUntraced(function* (project: Project, patch: ProjectSettingsPatch) {
  const api = yield* DesktopApi;
  return yield* api['Projects.setSettings']({ id: project.id, patch });
});

const isPermissionMode = Schema.is(PermissionMode);

type Inherited =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly mode: PermissionMode };

/**
 * A Project's settings sheet, opened by `ProjectSettingsState.show(project)`. Its one row, Default permission mode,
 * shows the value inherited from Settings greyed until the Project overrides it, and can clear the override.
 */
@Component({
  selector: 'app-project-settings-sheet',
  imports: [
    HlmSheetImports,
    HlmButtonImports,
    HlmLabelImports,
    HlmSwitchImports,
    HlmToggleGroupImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-sheet
      side="right"
      [state]="state.project() === null ? 'closed' : 'open'"
      (stateChanged)="onState($event)"
    >
      <hlm-sheet-content
        *hlmSheetPortal="let ctx"
        data-testid="project-settings"
        closeLabel="Close"
        i18n-closeLabel
      >
        @if (state.project(); as project) {
          <hlm-sheet-header>
            <h2 hlmSheetTitle i18n>Project settings</h2>
            <p hlmSheetDescription>{{ project.name }}</p>
          </hlm-sheet-header>

          <div class="flex flex-col gap-3 px-4">
            @if (inherited(); as fromSettings) {
              @switch (fromSettings.status) {
                @case ('loading') {
                  <p class="text-muted-foreground" data-testid="project-settings-loading" i18n>
                    Loading…
                  </p>
                }
                @case ('failed') {
                  <p class="text-destructive" data-testid="project-settings-failed" i18n>
                    Could not load Settings.
                  </p>
                }
                @case ('loaded') {
                  @let override = project.settings.defaultPermissionMode;
                  <div
                    class="flex flex-col gap-2"
                    data-testid="project-permission"
                    [attr.data-inherited]="override === undefined"
                  >
                    <span hlmLabel id="project-permission-label" i18n>Default permission mode</span>
                    <div
                      hlmToggleGroup
                      variant="outline"
                      size="sm"
                      aria-labelledby="project-permission-label"
                      [class.opacity-50]="override === undefined"
                      [nullable]="false"
                      [value]="override ?? fromSettings.mode"
                      (valueChange)="onMode(project, $event)"
                    >
                      <button
                        hlmToggleGroupItem
                        value="ask"
                        data-testid="project-permission-ask"
                        i18n
                      >
                        Ask
                      </button>
                      <button
                        hlmToggleGroupItem
                        value="auto"
                        data-testid="project-permission-auto"
                        i18n
                      >
                        Auto
                      </button>
                    </div>
                    @if (override === undefined) {
                      <p class="text-muted-foreground text-xs" i18n>From Settings</p>
                    } @else {
                      <div>
                        <button
                          hlmBtn
                          variant="link"
                          size="sm"
                          class="px-0"
                          data-testid="project-permission-clear"
                          (click)="change(project, { defaultPermissionMode: null })"
                          i18n
                        >
                          Use the Settings default
                        </button>
                      </div>
                    }
                  </div>
                }
              }
            }

            <div class="flex items-start justify-between gap-4 border-t pt-4">
              <div class="flex flex-col gap-1">
                <label hlmLabel for="project-show-ignored" i18n>Show Git-ignored files</label>
                <p class="text-muted-foreground text-xs" i18n>
                  Show ignored files in the Files browser. Visibility never includes them in commits
                  or captured context.
                </p>
              </div>
              <hlm-switch
                inputId="project-show-ignored"
                data-testid="project-show-ignored"
                [checked]="project.settings.showIgnoredFiles ?? false"
                (checkedChange)="onShowIgnoredFiles(project, $event)"
              />
            </div>
          </div>
        }
      </hlm-sheet-content>
    </hlm-sheet>
  `,
})
export class ProjectSettingsSheet {
  protected readonly state = inject(ProjectSettingsState);
  private readonly projects = inject(ProjectsState);
  private readonly runtime = inject(EffectRuntime);
  private readonly keymap = inject(Keymap);
  private readonly open = computed(() => this.state.project() !== null);

  /** The Default permission mode from Settings; read each time the sheet opens. */
  protected readonly inherited = signal<Inherited>({ status: 'loading' });

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const release = this.keymap.pushModal({ onEscape: () => this.state.close() });
      onCleanup(release);
    });
    effect(() => {
      if (this.state.project() !== null) untracked(() => void this.loadInherited());
    });
  }

  private async loadInherited(): Promise<void> {
    this.inherited.set({ status: 'loading' });
    const exit = await this.runtime.run(getSettings);
    this.inherited.set(
      exit._tag === 'Success'
        ? { status: 'loaded', mode: exit.value.defaultPermissionMode }
        : { status: 'failed' },
    );
  }

  protected onState(state: 'open' | 'closed'): void {
    if (state === 'closed') this.state.close();
  }

  protected onMode(project: Project, value: unknown): void {
    if (isPermissionMode(value) && value !== project.settings.defaultPermissionMode) {
      void this.change(project, { defaultPermissionMode: value });
    }
  }

  protected onShowIgnoredFiles(project: Project, checked: boolean): void {
    if (checked !== (project.settings.showIgnoredFiles ?? false)) {
      void this.change(project, { showIgnoredFiles: checked });
    }
  }

  protected async change(project: Project, patch: ProjectSettingsPatch): Promise<void> {
    const exit = await this.runtime.run(setSettings(project, patch));
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not change the Project settings.`);
      return;
    }
    this.state.changed(exit.value);
    this.projects.changed(exit.value);
  }
}
