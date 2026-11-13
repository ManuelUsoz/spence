import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { HlmButtonImports } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmInputImports } from '@ui/input';
import { HlmLabelImports } from '@ui/label';
import { HlmNativeSelectImports } from '@ui/native-select';
import { HlmSeparatorImports } from '@ui/separator';
import { HlmSwitchImports } from '@ui/switch';
import { toast } from '@ui/toast';
import { HlmToggleGroupImports } from '@ui/toggle-group';
import { Effect, Schema } from 'effect';
import type { Agent } from '../../../shared/agents/agents.rpc';
import { PermissionMode } from '../../../shared/projects/projects.rpc';
import {
  AUTO_ARCHIVE_DAYS_ON,
  EffortDefault,
  Language,
  ProjectOrder,
  SidebarLayout,
  Theme,
  type AgentSettings,
  type Settings,
  type SettingsPatch,
} from '../../../shared/settings/settings.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { ProjectsState } from './projects-state';
import { SettingsState } from './settings-state';

type View =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'loaded';
      readonly settings: Settings;
      readonly agents: ReadonlyArray<Agent>;
    };

const load = Effect.gen(function* () {
  const api = yield* DesktopApi;
  const [settings, agents] = yield* Effect.all([api['Settings.get'](), api['Agents.list']()], {
    concurrency: 'unbounded',
  });
  return { settings, agents };
});

const update = Effect.fnUntraced(function* (patch: SettingsPatch) {
  const api = yield* DesktopApi;
  return yield* api['Settings.update']({ patch });
});

const isLanguage = Schema.is(Language);
const isTheme = Schema.is(Theme);
const isSidebarLayout = Schema.is(SidebarLayout);
const isOrderBy = Schema.is(ProjectOrder.fields.by);
const isOrderDirection = Schema.is(ProjectOrder.fields.direction);
const isPermissionMode = Schema.is(PermissionMode);
const isEffortDefault = Schema.is(EffortDefault);
const isAutoArchiveDays = (days: number): boolean => Number.isInteger(days) && days > 0;

const NEVER_RUN: AgentSettings = {
  model: 'lastUsed',
  effort: 'lastUsed',
  models: [],
  ran: false,
};

/**
 * The Settings dialog, opened by `SettingsState.show()`. Every change applies at once through `Settings.update`;
 * there is no Save button.
 */
@Component({
  selector: 'app-settings-dialog',
  imports: [
    NgComponentOutlet,
    HlmDialogImports,
    HlmInputImports,
    HlmButtonImports,
    HlmLabelImports,
    HlmNativeSelectImports,
    HlmSeparatorImports,
    HlmSwitchImports,
    HlmToggleGroupImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-dialog
      [state]="state.open() ? 'open' : 'closed'"
      (stateChanged)="state.set($event === 'open')"
    >
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[85vh] overflow-y-auto sm:max-w-lg"
        data-testid="settings-dialog"
        closeLabel="Close"
        i18n-closeLabel
      >
        <hlm-dialog-header>
          <h2 hlmDialogTitle class="font-display text-xl font-normal" i18n>Settings</h2>
          <p hlmDialogDescription class="sr-only" i18n>Changes apply at once.</p>
        </hlm-dialog-header>

        @switch (view().status) {
          @case ('loading') {
            <p class="text-muted-foreground" i18n>Loading…</p>
          }
          @case ('failed') {
            <p class="text-destructive" data-testid="settings-failed" i18n>
              Could not load Settings.
            </p>
          }
        }

        @if (loaded(); as current) {
          <section class="flex flex-col gap-4" data-testid="settings-general">
            <h3 class="text-muted-foreground text-xs font-medium" i18n>General</h3>
            <hlm-separator />

            <div class="flex items-center justify-between gap-4">
              <label hlmLabel for="settings-language" i18n>Language</label>
              <hlm-native-select
                data-testid="settings-language"
                selectId="settings-language"
                [value]="current.settings.language"
                (valueChange)="onLanguage($event)"
              >
                <option value="system" i18n>System default</option>
                <option value="en">English</option>
                <option value="es">Español</option>
              </hlm-native-select>
            </div>

            <div class="flex items-center justify-between gap-4">
              <span hlmLabel id="settings-theme-label" i18n>Theme</span>
              <div
                hlmToggleGroup
                variant="outline"
                size="sm"
                aria-labelledby="settings-theme-label"
                [nullable]="false"
                [value]="current.settings.theme"
                (valueChange)="onTheme($event)"
              >
                <button hlmToggleGroupItem value="system" data-testid="theme-system" i18n>
                  System default
                </button>
                <button hlmToggleGroupItem value="light" data-testid="theme-light" i18n>
                  Light
                </button>
                <button hlmToggleGroupItem value="dark" data-testid="theme-dark" i18n>Dark</button>
              </div>
            </div>

            <div class="flex items-center justify-between gap-4">
              <label hlmLabel for="settings-notifications" i18n>
                Notify me when a Session needs me
              </label>
              <hlm-switch
                inputId="settings-notifications"
                data-testid="settings-notifications"
                [checked]="current.settings.notifications"
                (checkedChange)="change({ notifications: $event })"
              />
            </div>

            <div class="flex items-center justify-between gap-4">
              <span hlmLabel id="settings-sidebar-label" i18n>Sidebar layout</span>
              <div
                hlmToggleGroup
                variant="outline"
                size="sm"
                aria-labelledby="settings-sidebar-label"
                [nullable]="false"
                [value]="current.settings.sidebarLayout"
                (valueChange)="onSidebarLayout($event)"
              >
                <button hlmToggleGroupItem value="oneProject" data-testid="sidebar-oneProject" i18n>
                  One Project
                </button>
                <button
                  hlmToggleGroupItem
                  value="allProjects"
                  data-testid="sidebar-allProjects"
                  i18n
                >
                  All Projects
                </button>
              </div>
            </div>

            <div class="flex items-center justify-between gap-4">
              <label hlmLabel for="settings-project-order-by" i18n>Project order</label>
              <div class="flex gap-2">
                <hlm-native-select
                  data-testid="settings-project-order-by"
                  selectId="settings-project-order-by"
                  [value]="current.settings.projectOrder.by"
                  (valueChange)="onOrderBy(current.settings, $event)"
                >
                  <option value="lastUsed" i18n>Last used</option>
                  <option value="name" i18n>Name</option>
                </hlm-native-select>
                <hlm-native-select
                  data-testid="settings-project-order-direction"
                  aria-label="Direction"
                  i18n-aria-label
                  [value]="current.settings.projectOrder.direction"
                  (valueChange)="onOrderDirection(current.settings, $event)"
                >
                  <option value="desc" i18n>Descending</option>
                  <option value="asc" i18n>Ascending</option>
                </hlm-native-select>
              </div>
            </div>
          </section>

          <section class="mt-4 flex flex-col gap-4" data-testid="settings-sessions">
            <h3 class="text-muted-foreground text-xs font-medium" i18n>Sessions</h3>
            <hlm-separator />

            <div class="flex items-center justify-between gap-4">
              <span hlmLabel id="settings-permission-label" i18n>Default permission mode</span>
              <div
                hlmToggleGroup
                variant="outline"
                size="sm"
                aria-labelledby="settings-permission-label"
                [nullable]="false"
                [value]="current.settings.defaultPermissionMode"
                (valueChange)="onPermissionMode($event)"
              >
                <button hlmToggleGroupItem value="ask" data-testid="permission-ask" i18n>
                  Ask
                </button>
                <button hlmToggleGroupItem value="auto" data-testid="permission-auto" i18n>
                  Auto
                </button>
              </div>
            </div>

            <div class="flex items-center justify-between gap-4">
              <label hlmLabel for="settings-auto-archive" i18n>Archive idle Sessions</label>
              <div class="flex items-center gap-3">
                @if (current.settings.autoArchiveDays !== null) {
                  <span class="flex items-center gap-2">
                    <input
                      hlmInput
                      type="number"
                      min="1"
                      step="1"
                      class="h-8 w-20 tabular-nums"
                      data-testid="settings-auto-archive-days"
                      aria-label="Days idle before archiving"
                      i18n-aria-label
                      [value]="current.settings.autoArchiveDays"
                      (change)="onAutoArchiveDays($event)"
                    />
                    <span class="text-muted-foreground" i18n>days</span>
                  </span>
                }
                <hlm-switch
                  inputId="settings-auto-archive"
                  data-testid="settings-auto-archive"
                  [checked]="current.settings.autoArchiveDays !== null"
                  (checkedChange)="change({ autoArchiveDays: $event ? autoArchiveOn : null })"
                />
              </div>
            </div>
          </section>

          <section class="mt-4 flex flex-col gap-4" data-testid="settings-agents">
            <h3 class="text-muted-foreground text-xs font-medium" i18n>Agents</h3>
            <hlm-separator />

            @for (agent of current.agents; track agent.id) {
              @let defaults = agentSettings(current.settings, agent);
              @let neverRun = !defaults.ran;
              <div class="flex flex-col gap-3" [attr.data-testid]="'agent-' + agent.id">
                <div class="flex items-center justify-between gap-4">
                  <span class="font-medium">{{ agent.name }}</span>
                  <span
                    class="text-muted-foreground text-xs"
                    [attr.data-testid]="'agent-' + agent.id + '-status'"
                  >
                    @if (agent.installed) {
                      <ng-container i18n>Installed</ng-container>
                    } @else {
                      <ng-container i18n>Not installed</ng-container>
                    }
                  </span>
                </div>

                @if (!agent.installed) {
                  <ng-container
                    [ngComponentOutlet]="installOffer"
                    [ngComponentOutletInputs]="{ agent }"
                  />
                }

                <div class="flex items-center justify-between gap-4">
                  <label hlmLabel [for]="'agent-' + agent.id + '-model-select'" i18n>Model</label>
                  <hlm-native-select
                    [attr.data-testid]="'agent-' + agent.id + '-model'"
                    [selectId]="'agent-' + agent.id + '-model-select'"
                    [disabled]="defaults.models.length === 0"
                    [value]="defaults.model"
                    (valueChange)="onModel(agent, $event)"
                  >
                    <option value="lastUsed" i18n>Last used</option>
                    @for (model of defaults.models; track model.id) {
                      <option [value]="model.id">{{ model.name }}</option>
                    }
                  </hlm-native-select>
                </div>

                <div class="flex items-center justify-between gap-4">
                  <label hlmLabel [for]="'agent-' + agent.id + '-effort-select'" i18n>Effort</label>
                  <hlm-native-select
                    [attr.data-testid]="'agent-' + agent.id + '-effort'"
                    [selectId]="'agent-' + agent.id + '-effort-select'"
                    [disabled]="neverRun"
                    [value]="defaults.effort"
                    (valueChange)="onEffort(agent, $event)"
                  >
                    <option value="lastUsed" i18n>Last used</option>
                    @if (!neverRun) {
                      <option value="low" i18n>Low</option>
                      <option value="medium" i18n>Medium</option>
                      <option value="high" i18n>High</option>
                      <option value="max" i18n>Max</option>
                    }
                  </hlm-native-select>
                </div>

                @if (neverRun) {
                  <p class="text-muted-foreground text-xs" i18n>
                    Start a Session to see its Models
                  </p>
                }
              </div>
            } @empty {
              <p class="text-muted-foreground" i18n>No Agents.</p>
            }
          </section>
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class SettingsDialog {
  protected readonly state = inject(SettingsState);
  private readonly runtime = inject(EffectRuntime);
  private readonly projects = inject(ProjectsState);
  protected readonly installOffer = inject(AGENT_INSTALL_OFFER);
  protected readonly autoArchiveOn = AUTO_ARCHIVE_DAYS_ON;

  protected readonly view = signal<View>({ status: 'loading' });
  protected readonly loaded = computed(() => {
    const view = this.view();
    return view.status === 'loaded' ? view : null;
  });

  constructor() {
    effect(() => {
      if (this.state.open()) untracked(() => void this.load());
    });
  }

  private async load(): Promise<void> {
    this.view.set({ status: 'loading' });
    const exit = await this.runtime.run(load);
    if (exit._tag === 'Success') {
      this.view.set({ status: 'loaded', ...exit.value });
      this.state.sidebarLayoutChanged(exit.value.settings.sidebarLayout);
      this.projects.orderChanged(exit.value.settings.projectOrder);
    } else {
      this.view.set({ status: 'failed' });
    }
  }

  /** Applies one change at once; the dialog then shows what main resolved. */
  protected async change(patch: SettingsPatch): Promise<void> {
    const exit = await this.runtime.run(update(patch));
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not change the setting.`);
      await this.load();
      return;
    }
    const settings = exit.value;
    this.view.update((view) => (view.status === 'loaded' ? { ...view, settings } : view));
    if (patch.projectOrder !== undefined) this.projects.orderChanged(settings.projectOrder);
    if (patch.sidebarLayout !== undefined) this.state.sidebarLayoutChanged(settings.sidebarLayout);
  }

  protected onLanguage(value: unknown): void {
    if (isLanguage(value)) void this.change({ language: value });
  }

  protected onTheme(value: unknown): void {
    if (isTheme(value)) void this.change({ theme: value });
  }

  protected onSidebarLayout(value: unknown): void {
    if (isSidebarLayout(value)) void this.change({ sidebarLayout: value });
  }

  protected onPermissionMode(value: unknown): void {
    if (isPermissionMode(value)) void this.change({ defaultPermissionMode: value });
  }

  protected onAutoArchiveDays(event: Event): void {
    const days = Number((event.target as HTMLInputElement).value);
    if (isAutoArchiveDays(days)) void this.change({ autoArchiveDays: days });
  }

  /** An Agent's Settings; an Agent never run has none yet: Last used, no Models. */
  protected agentSettings(settings: Settings, agent: Agent): AgentSettings {
    return settings.agents[agent.id] ?? NEVER_RUN;
  }

  protected onModel(agent: Agent, value: unknown): void {
    if (typeof value === 'string' && value !== '') {
      void this.change({ agents: { [agent.id]: { model: value } } });
    }
  }

  protected onEffort(agent: Agent, value: unknown): void {
    if (isEffortDefault(value)) void this.change({ agents: { [agent.id]: { effort: value } } });
  }

  protected onOrderBy(settings: Settings, value: unknown): void {
    if (isOrderBy(value)) {
      void this.change({ projectOrder: { ...settings.projectOrder, by: value } });
    }
  }

  protected onOrderDirection(settings: Settings, value: unknown): void {
    if (isOrderDirection(value)) {
      void this.change({ projectOrder: { ...settings.projectOrder, direction: value } });
    }
  }
}
