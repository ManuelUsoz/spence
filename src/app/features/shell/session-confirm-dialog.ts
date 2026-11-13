import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { Keymap } from '../../core/keymap';
import { SessionsState } from './sessions-state';

/** Shared confirmation dialog for archiving running Turns, deleting Sessions, and removing Projects. */
@Component({
  selector: 'app-session-confirm-dialog',
  imports: [HlmAlertDialogImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-alert-dialog
      [state]="state.confirm() === null ? 'closed' : 'open'"
      (stateChanged)="onStateChange($event)"
    >
      <hlm-alert-dialog-content
        *hlmAlertDialogPortal="let ctx"
        data-testid="session-confirm-dialog"
      >
        @if (state.confirm(); as prompt) {
          <hlm-alert-dialog-header>
            <h2
              hlmAlertDialogTitle
              class="font-display text-xl font-normal"
              data-testid="confirm-title"
            >
              {{ prompt.title }}
            </h2>
            <p hlmAlertDialogDescription data-testid="confirm-description">
              {{ prompt.description }}
            </p>
          </hlm-alert-dialog-header>
          <hlm-alert-dialog-footer>
            <button
              hlmAlertDialogCancel
              data-testid="confirm-cancel"
              (click)="state.dismissConfirm()"
              i18n
            >
              Cancel
            </button>
            <button
              hlmAlertDialogAction
              [variant]="prompt.destructive ? 'destructive' : 'default'"
              data-testid="confirm-action"
              (click)="state.runConfirm()"
            >
              {{ prompt.confirmLabel }}
            </button>
          </hlm-alert-dialog-footer>
        }
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
  `,
})
export class SessionConfirmDialog {
  protected readonly state = inject(SessionsState);
  private readonly keymap = inject(Keymap);
  private readonly open = computed(() => this.state.confirm() !== null);

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const release = this.keymap.pushModal({ onEscape: () => this.state.dismissConfirm() });
      onCleanup(release);
    });
  }

  protected onStateChange(next: string): void {
    if (next === 'closed') this.state.dismissConfirm();
  }
}
