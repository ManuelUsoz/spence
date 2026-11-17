import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AgentTile } from '@ui/agent-tile';
import { HlmButtonImports } from '@ui/button';
import { HlmNativeSelectImports } from '@ui/native-select';
import { Pill } from '@ui/pill';
import { Schema } from 'effect';
import type { Agent } from '../../../../shared/agents/agents.rpc';
import {
  EffortDefault,
  type AgentSettings,
  type Settings,
} from '../../../../shared/settings/settings.rpc';
import { AGENT_INSTALL_OFFER } from '../../../core/agent-install-offer';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

const isEffortDefault = Schema.is(EffortDefault);

const NEVER_RUN: AgentSettings = {
  model: 'lastUsed',
  effort: 'lastUsed',
  models: [],
  ran: false,
};

/** Agents: one quiet row each; Configure opens its Model and Effort defaults in place. */
@Component({
  selector: 'app-settings-agents',
  imports: [
    NgComponentOutlet,
    AgentTile,
    Pill,
    SettingsRow,
    HlmButtonImports,
    HlmNativeSelectImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.loaded(); as current) {
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
            <div class="mb-3">
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
                <hlm-native-select
                  [attr.data-testid]="'agent-' + agent.id + '-model'"
                  [selectId]="'agent-' + agent.id + '-model-select'"
                  [disabled]="!agent.capabilities.models || defaults.models.length === 0"
                  [value]="defaults.model"
                  (valueChange)="onModel(agent, $event)"
                >
                  <option value="lastUsed" i18n>Last used</option>
                  @for (model of defaults.models; track model.id) {
                    <option [value]="model.id">{{ model.name }}</option>
                  }
                </hlm-native-select>
              </app-settings-row>

              <app-settings-row
                label="Effort"
                i18n-label
                [controlId]="'agent-' + agent.id + '-effort-select'"
              >
                <hlm-native-select
                  [attr.data-testid]="'agent-' + agent.id + '-effort'"
                  [selectId]="'agent-' + agent.id + '-effort-select'"
                  [disabled]="!agent.capabilities.effort || neverRun"
                  [value]="defaults.effort"
                  (valueChange)="onEffort(agent, $event)"
                >
                  <option value="lastUsed" i18n>Last used</option>
                  @if (agent.capabilities.effort && !neverRun) {
                    <option value="low" i18n>Low</option>
                    <option value="medium" i18n>Medium</option>
                    <option value="high" i18n>High</option>
                    <option value="max" i18n>Max</option>
                  }
                </hlm-native-select>
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
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected toggle(id: string): void {
    this.expanded.update((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** An Agent's Settings; an Agent never run has none yet: Last used, no Models. */
  protected agentSettings(settings: Settings, agent: Agent): AgentSettings {
    return settings.agents[agent.id] ?? NEVER_RUN;
  }

  protected onModel(agent: Agent, value: unknown): void {
    if (typeof value === 'string' && value !== '') {
      void this.store.change({ agents: { [agent.id]: { model: value } } });
    }
  }

  protected onEffort(agent: Agent, value: unknown): void {
    if (isEffortDefault(value)) {
      void this.store.change({ agents: { [agent.id]: { effort: value } } });
    }
  }
}
