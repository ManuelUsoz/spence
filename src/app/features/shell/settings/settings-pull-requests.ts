import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HlmInputImports } from '@ui/input';
import { HlmSelectImports } from '@ui/select';
import { HlmSwitch } from '@ui/switch';
import { AgentId } from '../../../../shared/agents/agents.rpc';
import {
  DEFAULT_PULL_REQUEST_SETTINGS,
  type PullRequestSettings,
} from '../../../../shared/settings/settings.rpc';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

/** Pull requests: AI drafting and post-merge local base branch behavior. */
@Component({
  selector: 'app-settings-pull-requests',
  imports: [SettingsRow, HlmInputImports, HlmSelectImports, HlmSwitch],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'settings-pull-requests' },
  template: `
    @if (store.loaded(); as current) {
      @let pr = current.settings.pullRequests ?? defaults;
      @let selectedAgent = agentById(pr.draftingAgent);
      @let models = modelsFor(pr.draftingAgent);

      <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Pull requests</h2>
      <p class="text-muted-foreground mb-3 text-sm" i18n>
        Configure ephemeral AI drafting when opening the Create Pull request form.
      </p>

      <app-settings-row
        label="Draft title & description automatically"
        hint="Runs an isolated, tool-free Agent prompt on the branch diff when creating a Pull request."
        controlId="pr-drafting-enabled"
        i18n-label
        i18n-hint
      >
        <hlm-switch
          id="pr-drafting-enabled"
          data-testid="pr-settings-drafting-enabled"
          [checked]="pr.draftingEnabled"
          (checkedChange)="patch({ draftingEnabled: $event })"
        />
      </app-settings-row>

      <app-settings-row
        label="Drafting Agent"
        [hint]="agentStatusLabel(selectedAgent?.installed)"
        controlId="pr-drafting-agent"
        i18n-label
      >
        <hlm-select
          data-testid="pr-settings-drafting-agent"
          [value]="pr.draftingAgent"
          (valueChange)="selectAgent($event)"
        >
          <hlm-select-trigger buttonId="pr-drafting-agent">
            {{ selectedAgent?.name ?? pr.draftingAgent }}
          </hlm-select-trigger>
          <hlm-select-content *hlmSelectPortal>
            @for (agent of current.agents; track agent.id) {
              <hlm-select-item [value]="agent.id" [attr.data-value]="agent.id">
                <span>{{ agent.name }}</span>
                <span class="text-muted-foreground ml-2 text-xs">
                  @if (agent.installed) {
                    <ng-container i18n>Ready</ng-container>
                  } @else {
                    <ng-container i18n>Not installed</ng-container>
                  }
                </span>
              </hlm-select-item>
            }
          </hlm-select-content>
        </hlm-select>
      </app-settings-row>

      <app-settings-row label="Drafting Model" controlId="pr-drafting-model" i18n-label>
        <hlm-select
          data-testid="pr-settings-drafting-model"
          [value]="pr.draftingModel"
          (valueChange)="selectModel($event)"
        >
          <hlm-select-trigger buttonId="pr-drafting-model">
            {{ modelLabel(pr.draftingAgent, pr.draftingModel) }}
          </hlm-select-trigger>
          <hlm-select-content *hlmSelectPortal>
            <hlm-select-item value="lastUsed" data-value="lastUsed" i18n>Last used</hlm-select-item>
            @for (model of models; track model.id) {
              <hlm-select-item [value]="model.id" [attr.data-value]="model.id">{{
                model.name
              }}</hlm-select-item>
            }
          </hlm-select-content>
        </hlm-select>
      </app-settings-row>

      <app-settings-row
        label="Update local base branch after merge"
        i18n-label
        hint="Automatically fast-forward the local base branch when a Pull request is merged."
        i18n-hint
        controlId="pr-auto-update-base"
      >
        <hlm-switch
          id="pr-auto-update-base"
          data-testid="settings-pr-auto-update-base"
          [checked]="pr.autoUpdateBaseBranchAfterMerge"
          (checkedChange)="patch({ autoUpdateBaseBranchAfterMerge: $event })"
        />
      </app-settings-row>

      <app-settings-row
        label="PR worktree branch pattern"
        i18n-label
        hint="Used for fork or colliding PR branches when starting a Session. Supports {number}, {headRef}, and {author}."
        i18n-hint
        controlId="settings-pr-branch-pattern"
      >
        <input
          hlmInput
          id="settings-pr-branch-pattern"
          type="text"
          class="h-8 w-52 font-mono text-xs"
          data-testid="settings-pr-branch-pattern"
          [value]="draftPattern() ?? pr.worktreeBranchPattern"
          placeholder="pr/{number}"
          (input)="onPatternInput($event)"
          (blur)="commitPattern(pr)"
          (keydown.enter)="commitPattern(pr)"
        />
      </app-settings-row>
    }
  `,
})
export class SettingsPullRequests {
  protected readonly store = inject(SettingsStore);
  protected readonly defaults = DEFAULT_PULL_REQUEST_SETTINGS;
  protected readonly draftPattern = signal<string | null>(null);

  protected onPatternInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.draftPattern.set(input.value);
  }

  protected commitPattern(current: PullRequestSettings): void {
    const raw = this.draftPattern();
    if (raw === null) return;
    const trimmed = raw.trim() || this.defaults.worktreeBranchPattern;
    this.draftPattern.set(null);
    if (trimmed === current.worktreeBranchPattern) return;
    this.patch({ worktreeBranchPattern: trimmed });
  }

  protected agentById(id: string) {
    return this.store.loaded()?.agents.find((a) => a.id === id);
  }

  protected modelsFor(agentId: string) {
    return this.store.loaded()?.settings.agents[AgentId.make(agentId)]?.models ?? [];
  }

  protected agentStatusLabel(installed: boolean | undefined): string {
    if (installed === undefined) return '';
    return installed
      ? $localize`Agent is installed and ready.`
      : $localize`Agent is not installed.`;
  }

  protected modelLabel(agentId: string, modelId: string): string {
    if (modelId === 'lastUsed' || modelId.length === 0) return $localize`Last used`;
    const models = this.modelsFor(agentId);
    return models.find((m) => m.id === modelId)?.name ?? modelId;
  }

  protected selectAgent(agentId: string | readonly string[] | null | undefined): void {
    const id = typeof agentId === 'string' ? agentId : agentId?.[0];
    if (!id) return;
    this.patch({ draftingAgent: id, draftingModel: 'lastUsed' });
  }

  protected selectModel(modelId: string | readonly string[] | null | undefined): void {
    const id = typeof modelId === 'string' ? modelId : modelId?.[0];
    if (!id) return;
    this.patch({ draftingModel: id });
  }

  protected patch(partial: Partial<PullRequestSettings>): void {
    const current = this.store.loaded()?.settings.pullRequests ?? this.defaults;
    void this.store.change({ pullRequests: { ...current, ...partial } });
  }
}
