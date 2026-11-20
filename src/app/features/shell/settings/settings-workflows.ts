import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmSelectImports } from '@ui/select';
import type { CoordinatorSettings } from '../../../../shared/settings/settings.rpc';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

@Component({
  selector: 'app-settings-workflows',
  imports: [SettingsRow, HlmSelectImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.loaded(); as current) {
      <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Workflows</h2>
      <p class="text-muted-foreground mb-3 text-sm" i18n>
        <code class="font-mono text-xs">/coordinate</code> assigns implementation to a Worker. A
        fresh Verifier reviews the changes and runs relevant checks.
      </p>
      @for (role of roles; track role.id) {
        @let target = current.settings.coordinator?.[role.id];
        @let models = target ? (current.settings.agents[target.agentId]?.models ?? []) : [];
        <app-settings-row [label]="role.label" [controlId]="'workflow-agent-' + role.id">
          <div class="flex flex-wrap justify-end gap-2">
            <hlm-select
              [value]="target?.agentId ?? ''"
              (valueChange)="selectAgent(role.id, $event)"
            >
              <hlm-select-trigger [buttonId]="'workflow-agent-' + role.id">
                {{ agentName(target?.agentId) }}
              </hlm-select-trigger>
              <hlm-select-content *hlmSelectPortal>
                @for (agent of current.agents; track agent.id) {
                  <hlm-select-item [value]="agent.id" [attr.data-value]="agent.id">{{
                    agent.name
                  }}</hlm-select-item>
                }
              </hlm-select-content>
            </hlm-select>
            <hlm-select
              [attr.data-testid]="'workflow-model-' + role.id"
              [value]="target?.model ?? ''"
              (valueChange)="selectModel(role.id, $event)"
            >
              <hlm-select-trigger [attr.aria-label]="modelLabel(role.label)">
                {{ modelName(role.id) }}
              </hlm-select-trigger>
              <hlm-select-content *hlmSelectPortal>
                @for (model of models; track model.id) {
                  <hlm-select-item [value]="model.id" [attr.data-value]="model.id">{{
                    model.name
                  }}</hlm-select-item>
                } @empty {
                  <p class="text-muted-foreground px-2 py-1 text-sm" i18n>
                    Open a Session with this Agent to discover its Models.
                  </p>
                }
              </hlm-select-content>
            </hlm-select>
          </div>
        </app-settings-row>
      }
    }
  `,
})
export class SettingsWorkflows {
  protected readonly store = inject(SettingsStore);
  protected readonly roles: ReadonlyArray<{ id: keyof CoordinatorSettings; label: string }> = [
    { id: 'coordinator', label: $localize`Coordinator` },
    { id: 'worker', label: $localize`Implementation Worker` },
    { id: 'verifier', label: $localize`Verifier` },
  ];

  protected agentName(id: string | undefined): string {
    return (
      this.store.loaded()?.agents.find((agent) => agent.id === id)?.name ?? $localize`Choose Agent`
    );
  }

  protected modelLabel(role: string): string {
    return $localize`Model for ${role}:role:`;
  }

  protected modelName(role: keyof CoordinatorSettings): string {
    const current = this.store.loaded();
    const target = current?.settings.coordinator?.[role];
    if (target === undefined || target.model === '') return $localize`Choose Model`;
    return (
      current?.settings.agents[target.agentId]?.models.find((model) => model.id === target.model)
        ?.name ?? target.model
    );
  }

  protected selectAgent(role: keyof CoordinatorSettings, id: unknown): void {
    const current = this.store.loaded();
    const agent = current?.agents.find((candidate) => candidate.id === id);
    if (
      current === null ||
      agent === undefined ||
      current.settings.coordinator?.[role]?.agentId === agent.id
    )
      return;
    void this.store.change({ coordinator: { [role]: { agentId: agent.id, model: '' } } });
  }

  protected selectModel(role: keyof CoordinatorSettings, id: unknown): void {
    const settings = this.store.loaded()?.settings;
    const target = settings?.coordinator?.[role];
    if (
      target === undefined ||
      typeof id !== 'string' ||
      settings?.agents[target.agentId]?.models.some((model) => model.id === id) !== true
    )
      return;
    void this.store.change({ coordinator: { [role]: { ...target, model: id } } });
  }
}
