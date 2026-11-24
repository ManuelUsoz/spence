import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { AgentTile } from '@ui/agent-tile';
import { HlmButtonImports } from '@ui/button';
import { HlmSelectImports } from '@ui/select';
import { Pill } from '@ui/pill';
import { Schema } from 'effect';
import type { Agent } from '../../../../shared/agents/agents.rpc';
import {
  EffortDefault,
  type AgentSettings,
  type ExecutionSettings,
} from '../../../../shared/settings/settings.rpc';
import { AGENT_INSTALL_OFFER } from '../../../core/agent-install-offer';
import { DeviceScopeDirective } from '../../../core/device-scope.directive';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

const isEffortDefault = Schema.is(EffortDefault);

const NEVER_RUN: AgentSettings = {
  model: 'lastUsed',
  effort: 'lastUsed',
  models: [],
  ran: false,
};

interface InstallOfferInstance {
  readonly installed?: {
    subscribe: (next: () => void) => { unsubscribe: () => void };
  };
}

/** Agents: one quiet row each; Configure opens its Model and Effort defaults in place. */
@Component({
  selector: 'app-settings-agents',
  imports: [
    NgComponentOutlet,
    DeviceScopeDirective,
    AgentTile,
    Pill,
    SettingsRow,
    HlmButtonImports,
    HlmSelectImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.executionLoaded(); as current) {
      <div class="mt-9 mb-1.5 flex items-center justify-between gap-2">
        <h2 class="text-sm font-semibold" i18n>Agents</h2>
        <button
          hlmBtn
          type="button"
          variant="ghost"
          size="sm"
          data-testid="agents-rescan"
          [disabled]="store.rescanning()"
          (click)="store.rescanAgents()"
          i18n
        >
          Re-scan
        </button>
      </div>

      @for (agent of current.agents; track agent.id) {
        @let defaults = agentSettings(current.settings, agent);
        @let neverRun = !defaults.ran;
        @let open = expanded().has(agent.id);
        <div class="border-border/60 border-t" [attr.data-testid]="'agent-' + agent.id">
          <div class="flex items-center gap-6 py-3">
            <app-agent-tile [agentId]="agent.id" [name]="agent.name" />
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-sm">{{ agent.name }}</span>
              <span
                class="text-muted-foreground flex items-center gap-1.5 text-xs"
                [attr.data-testid]="'agent-' + agent.id + '-status'"
              >
                @if (agent.installed) {
                  <ng-container i18n>Installed</ng-container>
                  @if (agent.installedVersion; as version) {
                    <span class="font-mono text-xs">{{ version }}</span>
                  }
                } @else {
                  <ng-container i18n>Not installed</ng-container>
                }
              </span>
            </div>
            @if (agent.installed) {
              <button
                appPill
                type="button"
                [attr.data-testid]="'agent-' + agent.id + '-configure'"
                [attr.aria-expanded]="open"
                [attr.aria-controls]="'agent-' + agent.id + '-panel'"
                (click)="toggle(agent.id)"
                i18n
              >
                Configure
              </button>
            }
          </div>

          @if (agent.versionQualification === 'unverified') {
            <div
              class="bg-muted mb-3 flex flex-col gap-1 rounded-md px-3 py-2 text-xs"
              [attr.data-testid]="'agent-' + agent.id + '-unverified'"
            >
              <span class="font-medium" i18n>
                Unverified version (qualified {{ agent.qualifiedVersion }})
              </span>
              @if (agent.upgradeCommand; as cmd) {
                <code class="font-mono select-all">{{ cmd }}</code>
              }
            </div>
          }

          @if (!agent.installed) {
            <!-- The offer installs on the Device the section is about. -->
            <div class="mb-3" [appDeviceScope]="store.device()">
              <ng-container
                [ngComponentOutlet]="installOffer"
                [ngComponentOutletInputs]="{ agent }"
              />
            </div>
          }

          @if (open) {
            <div class="mb-2 pl-10" [id]="'agent-' + agent.id + '-panel'">
              <app-settings-row
                label="Model"
                i18n-label
                [controlId]="'agent-' + agent.id + '-model-select'"
              >
                <hlm-select
                  [attr.data-testid]="'agent-' + agent.id + '-model'"
                  [disabled]="!agent.capabilities.models || defaults.models.length === 0"
                  [value]="defaults.model"
                  (valueChange)="onModel(agent, $event)"
                >
                  <hlm-select-trigger [buttonId]="'agent-' + agent.id + '-model-select'">
                    @if (defaults.model === 'lastUsed') {
                      <span i18n>Last used</span>
                    } @else {
                      {{ modelName(defaults) }}
                    }
                  </hlm-select-trigger>
                  <hlm-select-content *hlmSelectPortal>
                    <hlm-select-item value="lastUsed" data-value="lastUsed" i18n
                      >Last used</hlm-select-item
                    >
                    @for (model of defaults.models; track model.id) {
                      <hlm-select-item [value]="model.id" [attr.data-value]="model.id">{{
                        model.name
                      }}</hlm-select-item>
                    }
                  </hlm-select-content>
                </hlm-select>
              </app-settings-row>

              <app-settings-row
                label="Effort"
                i18n-label
                [controlId]="'agent-' + agent.id + '-effort-select'"
              >
                <hlm-select
                  [attr.data-testid]="'agent-' + agent.id + '-effort'"
                  [disabled]="!agent.capabilities.effort || neverRun"
                  [value]="defaults.effort"
                  (valueChange)="onEffort(agent, $event)"
                >
                  <hlm-select-trigger [buttonId]="'agent-' + agent.id + '-effort-select'">
                    @switch (defaults.effort) {
                      @case ('lastUsed') {
                        <span i18n>Last used</span>
                      }
                      @case ('low') {
                        <span i18n>Low</span>
                      }
                      @case ('medium') {
                        <span i18n>Medium</span>
                      }
                      @case ('high') {
                        <span i18n>High</span>
                      }
                      @case ('max') {
                        <span i18n>Max</span>
                      }
                    }
                  </hlm-select-trigger>
                  <hlm-select-content *hlmSelectPortal>
                    <hlm-select-item value="lastUsed" data-value="lastUsed" i18n
                      >Last used</hlm-select-item
                    >
                    @if (agent.capabilities.effort && !neverRun) {
                      <hlm-select-item value="low" data-value="low" i18n>Low</hlm-select-item>
                      <hlm-select-item value="medium" data-value="medium" i18n
                        >Medium</hlm-select-item
                      >
                      <hlm-select-item value="high" data-value="high" i18n>High</hlm-select-item>
                      <hlm-select-item value="max" data-value="max" i18n>Max</hlm-select-item>
                    }
                  </hlm-select-content>
                </hlm-select>
              </app-settings-row>

              @if (!agent.capabilities.models && !agent.capabilities.effort) {
                <p class="text-muted-foreground pb-2 text-xs" i18n>
                  Not supported by {{ agent.name }}.
                </p>
              } @else if (neverRun) {
                <p class="text-muted-foreground pb-2 text-xs" i18n>
                  Start a Session to see its Models
                </p>
              }
            </div>
          }
        </div>
      } @empty {
        <p class="text-muted-foreground" i18n>No Agents.</p>
      }
    }
  `,
})
export class SettingsAgents {
  protected readonly store = inject(SettingsStore);
  protected readonly installOffer = inject(AGENT_INSTALL_OFFER);
  private readonly installOutlets = viewChildren(NgComponentOutlet);
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());

  constructor() {
    effect((onCleanup) => {
      const subs = this.installOutlets().flatMap((outlet) => {
        const instance = outlet.componentInstance as InstallOfferInstance | null | undefined;
        return instance?.installed
          ? [instance.installed.subscribe(() => void this.store.rescanAgents())]
          : [];
      });
      onCleanup(() => {
        for (const sub of subs) sub.unsubscribe();
      });
    });
  }

  protected modelName(defaults: AgentSettings): string {
    return defaults.models.find((model) => model.id === defaults.model)?.name ?? defaults.model;
  }

  protected toggle(id: string): void {
    this.expanded.update((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** An Agent's Settings; an Agent never run has none yet: Last used, no Models. */
  protected agentSettings(settings: ExecutionSettings, agent: Agent): AgentSettings {
    return settings.agents[agent.id] ?? NEVER_RUN;
  }

  protected onModel(agent: Agent, value: unknown): void {
    if (typeof value === 'string' && value !== '') {
      void this.store.changeExecution({ agents: { [agent.id]: { model: value } } });
    }
  }

  protected onEffort(agent: Agent, value: unknown): void {
    if (isEffortDefault(value)) {
      void this.store.changeExecution({ agents: { [agent.id]: { effort: value } } });
    }
  }
}
