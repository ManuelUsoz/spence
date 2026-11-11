import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { SettingsState } from './settings-state';

/** The settings modal. It is empty for now; sections go in its body. */
@Component({
  selector: 'app-settings-dialog',
  imports: [HlmDialogImports, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-dialog
      [state]="settings.open() ? 'open' : 'closed'"
      (stateChanged)="settings.set($event === 'open')"
    >
      <hlm-dialog-content *hlmDialogPortal="let ctx" data-testid="settings-dialog">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Settings</h2>
          <p hlmDialogDescription>Preferences for Spence.</p>
        </hlm-dialog-header>
        <p class="text-muted-foreground">There is nothing to configure yet.</p>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose>Close</button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class SettingsDialog {
  protected readonly settings = inject(SettingsState);
}
