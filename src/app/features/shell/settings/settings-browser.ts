import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { toast } from '@ui/toast';
import { BrowserPaneState } from '../../../core/browser-pane';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

/** Browser: actions for the embedded Browser's shared Local device profile. */
@Component({
  selector: 'app-settings-browser',
  imports: [SettingsRow, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.loaded()) {
      <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Browser</h2>

      <app-settings-row
        label="Browsing data"
        i18n-label
        hint="Cookies, storage, and cached data shared across Local device Sessions."
        i18n-hint
      >
        <button
          hlmBtn
          type="button"
          variant="outline"
          size="sm"
          data-testid="settings-browser-clear-data"
          [disabled]="browser.clearingData()"
          (click)="clearBrowsingData()"
          i18n
        >
          Clear browsing data
        </button>
      </app-settings-row>
    }
  `,
})
export class SettingsBrowser {
  protected readonly store = inject(SettingsStore);
  protected readonly browser = inject(BrowserPaneState);

  protected async clearBrowsingData(): Promise<void> {
    await this.browser.clearDataWithToast(toast);
  }
}
