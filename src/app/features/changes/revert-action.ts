import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { Effect, Exit } from 'effect';
import { HlmButtonImports } from '@ui/button';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { CommitSummary } from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { revertRejectionText, unavailableText } from './git-text';

const revert = Effect.fnUntraced(function* (sessionId: SessionId, sha: string) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.revert']({ sessionId, sha });
});

/** Revert for one commit of the History: a confirmation, then a new commit that undoes it. */
@Component({
  selector: 'app-revert-action',
  imports: [HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col items-end gap-1' },
  template: `
    @if (!confirming()) {
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
    } @else {
      <div class="flex items-center gap-2" data-testid="revert-confirm">
        <span class="text-muted-foreground text-xs" i18n>Add a commit that undoes this one?</span>
        <button
          type="button"
          hlmBtn
          size="sm"
          data-testid="revert-confirm-button"
          [disabled]="busy()"
          (click)="run()"
          i18n
        >
          Revert
        </button>
        <button
          type="button"
          hlmBtn
          variant="ghost"
          size="sm"
          data-testid="revert-cancel-button"
          [disabled]="busy()"
          (click)="confirming.set(false)"
          i18n
        >
          Cancel
        </button>
      </div>
    }
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

  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly problem = signal(false);

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
      this.problem.set(true);
      this.message.set($localize`Could not revert.`);
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
        this.problem.set(true);
        this.message.set(revertRejectionText(result.reason));
        return;
      case 'Failed':
        this.problem.set(true);
        this.message.set($localize`Git could not revert: ${result.detail}`);
        return;
      case 'Unavailable':
        this.problem.set(true);
        this.message.set(unavailableText(result.reason));
        return;
    }
  }
}
