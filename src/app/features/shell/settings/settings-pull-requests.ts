import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmSwitchImports } from '@ui/switch';
import {
  DEFAULT_PULL_REQUEST_SETTINGS,
  type PullRequestSettings,
  type Settings,
} from '../../../../shared/settings/settings.rpc';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

/** Pull requests: post-merge local base branch behavior. */
@Component({
  selector: 'app-settings-pull-requests',
  imports: [SettingsRow, HlmSwitchImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'settings-pull-requests' },
  template: `
    @if (store.loaded(); as current) {
      @let pr = prSettings(current.settings);
      <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Pull requests</h2>

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
          (checkedChange)="toggleAutoUpdateBase(pr, $event)"
        />
      </app-settings-row>
    }
  `,
})
export class SettingsPullRequests {
  protected readonly store = inject(SettingsStore);

  protected prSettings(settings: Settings): PullRequestSettings {
    return settings.pullRequests ?? DEFAULT_PULL_REQUEST_SETTINGS;
  }

  protected toggleAutoUpdateBase(current: PullRequestSettings, checked: boolean): void {
    void this.store.change({
      pullRequests: {
        ...current,
        autoUpdateBaseBranchAfterMerge: checked,
      },
    });
  }
}
