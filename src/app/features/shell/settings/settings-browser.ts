import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
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
          [disabled]="clearing()"
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
  private readonly browser = inject(BrowserPaneState);
  protected readonly clearing = signal(false);

  protected async clearBrowsingData(): Promise<void> {
    if (this.clearing()) return;
    this.clearing.set(true);
    try {
      const ok = await this.browser.clearData();
      if (ok) {
        toast.success($localize`Browsing data cleared.`);
      } else {
        toast.error($localize`Could not clear browsing data.`);
      }
    } finally {
      this.clearing.set(false);
    }
  }
}
