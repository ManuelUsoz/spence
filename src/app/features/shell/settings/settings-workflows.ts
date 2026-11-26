import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmSelectImports } from '@ui/select';
import type {
  CoordinatorSettings,
  DivideAndConquerSettings,
  WorkflowTarget,
} from '../../../../shared/settings/settings.rpc';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

type WorkflowSettingsKey = 'coordinator' | 'divideAndConquer';
type WorkflowRoleId = keyof CoordinatorSettings | keyof DivideAndConquerSettings;
type RoleSelections = Partial<Record<WorkflowRoleId, WorkflowTarget>>;

@Component({
  selector: 'app-settings-workflows',
  imports: [SettingsRow, HlmSelectImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.loaded(); as current) {
      <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Workflows</h2>
      @for (workflow of workflows; track workflow.key) {
        @if (workflow.key === 'coordinator') {
          <p class="text-muted-foreground mb-3 text-sm" i18n>
            <code class="font-mono text-xs">/coordinate</code> uses the current Session as
            orchestrator, assigns implementation to a Worker, and runs a fresh Verifier to review
            the changes and checks.
          </p>
        } @else {
          <p class="text-muted-foreground mt-5 mb-3 text-sm" i18n>
            <code class="font-mono text-xs">/divide-and-conquer</code> plans the work, breaks it
            into tasks, implements it, and verifies the result in fresh Sessions.
          </p>
        }
        @for (role of workflow.roles; track role.id) {
          @let target = selection(workflow.key, role.id);
          @let models = target ? (current.settings.agents[target.agentId]?.models ?? []) : [];
          <app-settings-row
            [label]="role.label"
            [controlId]="'workflow-agent-' + workflow.prefix + role.id"
          >
            <div class="flex flex-wrap justify-end gap-2">
              <hlm-select
                [value]="target?.agentId ?? ''"
                (valueChange)="selectAgent(workflow.key, role.id, $event)"
              >
                <hlm-select-trigger [buttonId]="'workflow-agent-' + workflow.prefix + role.id">
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
                [attr.data-testid]="'workflow-model-' + workflow.prefix + role.id"
                [value]="target?.model ?? ''"
                (valueChange)="selectModel(workflow.key, role.id, $event)"
              >
                <hlm-select-trigger
                  [buttonId]="'workflow-model-button-' + workflow.prefix + role.id"
                >
                  {{ modelName(workflow.key, role.id) }}
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
    }
  `,
})
export class SettingsWorkflows {
  protected readonly store = inject(SettingsStore);
  protected readonly workflows: ReadonlyArray<{
    key: WorkflowSettingsKey;
    prefix: string;
    roles: ReadonlyArray<{ id: WorkflowRoleId; label: string }>;
  }> = [
    {
      key: 'coordinator',
      prefix: '',
      roles: [
        { id: 'worker', label: $localize`Implementation Worker` },
        { id: 'verifier', label: $localize`Verifier` },
      ],
    },
    {
      key: 'divideAndConquer',
      prefix: 'divide-and-conquer-',
      roles: [
        { id: 'planner', label: $localize`Planner` },
        { id: 'taskBreaker', label: $localize`Task Breaker` },
        { id: 'implementer', label: $localize`Implementer` },
        { id: 'verifier', label: $localize`Verifier` },
      ],
    },
  ];

  protected selection(
    workflow: WorkflowSettingsKey,
    role: WorkflowRoleId,
  ): WorkflowTarget | undefined {
    const selections: RoleSelections | undefined = this.store.loaded()?.settings[workflow];
    return selections?.[role];
  }

  protected agentName(id: string | undefined): string {
    return (
      this.store.loaded()?.agents.find((agent) => agent.id === id)?.name ?? $localize`Choose Agent`
    );
  }

  protected modelLabel(role: string): string {
    return $localize`Model for ${role}:role:`;
  }

  protected modelName(workflow: WorkflowSettingsKey, role: WorkflowRoleId): string {
    const current = this.store.loaded();
    const target = this.selection(workflow, role);
    if (target === undefined || target.model === '') return $localize`Choose Model`;
    return (
      current?.settings.agents[target.agentId]?.models.find((model) => model.id === target.model)
        ?.name ?? target.model
    );
  }

  protected selectAgent(workflow: WorkflowSettingsKey, role: WorkflowRoleId, id: unknown): void {
    const current = this.store.loaded();
    const agent = current?.agents.find((candidate) => candidate.id === id);
    if (
      current === null ||
      agent === undefined ||
      this.selection(workflow, role)?.agentId === agent.id
    )
      return;
    void this.store.change({ [workflow]: { [role]: { agentId: agent.id, model: '' } } });
  }

  protected selectModel(workflow: WorkflowSettingsKey, role: WorkflowRoleId, id: unknown): void {
    const settings = this.store.loaded()?.settings;
    const target = this.selection(workflow, role);
    if (
      target === undefined ||
      typeof id !== 'string' ||
      settings?.agents[target.agentId]?.models.some((model) => model.id === id) !== true
    )
      return;
    void this.store.change({ [workflow]: { [role]: { ...target, model: id } } });
  }
}
