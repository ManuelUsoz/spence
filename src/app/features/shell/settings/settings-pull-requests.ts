import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HlmInputImports } from '@ui/input';
import {
  DEFAULT_PULL_REQUEST_SETTINGS,
  type PullRequestSettings,
} from '../../../../shared/settings/settings.rpc';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

/** Pull requests: worktree branch naming pattern for Sessions started from Pull requests. */
@Component({
  selector: 'app-settings-pull-requests',
  imports: [SettingsRow, HlmInputImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'settings-pull-requests' },
  template: `
    @if (store.loaded(); as current) {
      @let pr = current.settings.pullRequests ?? defaults;
      <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Pull requests</h2>

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
    void this.store.change({
      pullRequests: {
        ...current,
        worktreeBranchPattern: trimmed,
      },
    });
  }
}
