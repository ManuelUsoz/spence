import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButtonImports } from '@ui/button';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { CommitSummary } from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { revertRejectionText, unavailableText } from '../../core/git-text';
import { Keymap } from '../../core/keymap';
import { ChangesErrors } from './changes-errors';

const revert = Effect.fnUntraced(function* (sessionId: SessionId, sha: string) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.revert']({ sessionId, sha });
});

/** Revert for one commit of the History: a confirmation, then a new commit that undoes it. */
@Component({
  selector: 'app-revert-action',
  imports: [HlmAlertDialogImports, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col items-end gap-1' },
  template: `
    <button
      type="button"
      hlmBtn
      variant="ghost"
      size="sm"
      data-testid="revert-button"
      [disabled]="busy()"
      (click)="confirming.set(true)"
      i18n
    >
      Revert
    </button>
    <hlm-alert-dialog
      [state]="confirming() ? 'open' : 'closed'"
      (stateChanged)="onStateChange($event)"
    >
      <hlm-alert-dialog-content *hlmAlertDialogPortal="let ctx" data-testid="revert-confirm">
        <hlm-alert-dialog-header>
          <h2 hlmAlertDialogTitle class="font-display text-xl font-normal" i18n>
            Revert this commit?
          </h2>
          <p hlmAlertDialogDescription i18n>Add a commit that undoes this one?</p>
        </hlm-alert-dialog-header>
        <hlm-alert-dialog-footer>
          <button
            hlmAlertDialogCancel
            data-testid="revert-cancel-button"
            [disabled]="busy()"
            (click)="cancel()"
            i18n
          >
            Cancel
          </button>
          <button
            hlmAlertDialogAction
            data-testid="revert-confirm-button"
            [disabled]="busy()"
            (click)="run()"
            i18n
          >
            Revert
          </button>
        </hlm-alert-dialog-footer>
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
    @if (message(); as text) {
      <p
        class="max-w-sm text-right text-xs"
        [class.text-destructive]="problem()"
        [class.text-muted-foreground]="!problem()"
        data-testid="revert-outcome"
      >
        {{ text }}
      </p>
    }
  `,
})
export class RevertAction {
  readonly sessionId = input.required<SessionId>();
  readonly commit = input.required<CommitSummary>();
  /** A commit was added: the page reads the folder and the history again. */
  readonly changed = output<void>();

  private readonly runtime = inject(EffectRuntime);
  private readonly keymap = inject(Keymap);
  private readonly errors = inject(ChangesErrors);

  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly problem = signal(false);

  /** The commit by id: a new object for the same commit (the list was read again) keeps the outcome on screen. */
  private readonly sha = computed(() => this.commit().sha);

  constructor() {
    // The same control serves whichever commit is selected; a question or outcome belongs to one commit.
    effect(() => {
      this.sha();
      untracked(() => {
        this.confirming.set(false);
        this.message.set(null);
        this.problem.set(false);
      });
    });
    effect((onCleanup) => {
      if (!this.confirming()) return;
      const release = this.keymap.pushModal({ onEscape: () => this.cancel() });
      onCleanup(release);
    });
  }

  protected cancel(): void {
    if (this.busy()) return;
    this.confirming.set(false);
  }

  protected onStateChange(next: string): void {
    if (next === 'closed') this.cancel();
  }

  protected async run(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    const sessionId = this.sessionId();
    const exit = await this.runtime.run(revert(sessionId, this.commit().sha));
    this.busy.set(false);
    this.confirming.set(false);
    if (sessionId !== this.sessionId()) return;
    if (!Exit.isSuccess(exit)) {
      this.errors.report($localize`Could not revert.`);
      return;
    }
    const result = exit.value;
    switch (result._tag) {
      case 'Reverted': {
        const sha = result.shortSha;
        this.problem.set(false);
        this.message.set($localize`Reverted. New commit ${sha}.`);
        this.changed.emit();
        return;
      }
      case 'Rejected':
        this.errors.report(revertRejectionText(result.reason));
        return;
      case 'Failed':
        this.errors.report($localize`Git could not revert.`, result.detail);
        return;
      case 'Unavailable':
        this.errors.report(unavailableText(result.reason));
        return;
    }
  }
}
