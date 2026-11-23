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
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type {
  CommitFile,
  DiscardResult,
  PlannedDiscard,
} from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { ChangesErrors } from './changes-errors';
import { discardEffectText, discardRejectionText, unavailableText } from '../../core/git-text';
import { Keymap } from '../../core/keymap';

const prepare = Effect.fnUntraced(function* (
  sessionId: SessionId,
  files: ReadonlyArray<CommitFile>,
) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.prepareDiscard']({ sessionId, files });
});

const discard = Effect.fnUntraced(function* (
  sessionId: SessionId,
  files: ReadonlyArray<CommitFile>,
  token: string,
) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.discard']({ sessionId, files, token });
});

interface Review {
  readonly files: ReadonlyArray<CommitFile>;
  readonly token: string;
  readonly planned: ReadonlyArray<PlannedDiscard>;
}

type Outcome =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'problem'; readonly text: string; readonly output?: string };

/**
 * Discards changes, for the files a caller hands to `start`. The user first sees exactly which files will be affected (as Git sees them
 * now); confirming sends that same list with a token, and Spence refuses if the files changed in the meantime.
 */
@Component({
  selector: 'app-discard-panel',
  imports: [HlmAlertDialogImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex shrink-0 flex-col gap-2 empty:hidden', 'data-testid': 'discard-panel' },
  template: `
    <hlm-alert-dialog
      [state]="review() === null ? 'closed' : 'open'"
      (stateChanged)="onStateChange($event)"
    >
      <hlm-alert-dialog-content
        *hlmAlertDialogPortal="let ctx"
        class="max-w-lg sm:max-w-lg"
        data-testid="discard-confirm"
      >
        @if (review(); as pending) {
          <hlm-alert-dialog-header>
            <h2
              hlmAlertDialogTitle
              class="font-display text-xl font-normal"
              data-testid="discard-heading"
            >
              {{ heading(pending.planned.length) }}
            </h2>
            <p hlmAlertDialogDescription i18n>
              This cannot be undone from here. A copy is kept for 30 days.
            </p>
          </hlm-alert-dialog-header>
          <ul class="max-h-64 overflow-auto text-xs" data-testid="discard-files">
            @for (file of pending.planned; track file.path) {
              <li class="flex gap-2 py-0.5" data-testid="discard-file">
                <span class="min-w-0 flex-1 truncate font-mono">{{ file.path }}</span>
                <span class="text-muted-foreground shrink-0">{{ effectText(file.effect) }}</span>
              </li>
            }
          </ul>
          <hlm-alert-dialog-footer>
            <button
              hlmAlertDialogCancel
              data-testid="discard-cancel-button"
              [disabled]="busy()"
              (click)="cancel()"
              i18n
            >
              Cancel
            </button>
            <button
              hlmAlertDialogAction
              variant="destructive"
              data-testid="discard-confirm-button"
              [disabled]="busy()"
              (click)="confirm()"
              i18n
            >
              Discard
            </button>
          </hlm-alert-dialog-footer>
        }
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
    @if (outcome(); as result) {
      <p
        class="text-xs"
        [class.text-destructive]="result.kind === 'problem'"
        [class.text-muted-foreground]="result.kind === 'ok'"
        data-testid="discard-outcome"
      >
        {{ result.text }}
      </p>
      @if (result.kind === 'problem' && result.output) {
        <pre
          class="border-border/60 max-h-32 overflow-auto rounded-lg border p-2 font-mono text-xs whitespace-pre-wrap"
          >{{ result.output }}</pre>
      }
    }
  `,
})
export class DiscardPanel {
  readonly sessionId = input.required<SessionId>();
  /** Something was discarded or is out of date: the page reads the folder again. */
  readonly changed = output<void>();

  private readonly runtime = inject(EffectRuntime);
  private readonly errors = inject(ChangesErrors);
  private readonly keymap = inject(Keymap);

  protected readonly busy = signal(false);
  protected readonly review = signal<Review | null>(null);
  protected readonly outcome = signal<Outcome | null>(null);
  private readonly open = computed(() => this.review() !== null);

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.review.set(null);
        this.setOutcome(null);
      });
    });
    effect((onCleanup) => {
      if (!this.open()) return;
      const release = this.keymap.pushModal({ onEscape: () => this.cancel() });
      onCleanup(release);
    });
  }

  private setOutcome(outcome: Outcome | null): void {
    if (outcome?.kind === 'problem') {
      this.outcome.set(null);
      this.errors.report(outcome.text, outcome.output);
    } else this.outcome.set(outcome);
  }

  protected cancel(): void {
    if (this.busy()) return;
    this.review.set(null);
  }

  protected onStateChange(next: string): void {
    if (next === 'closed') this.cancel();
  }

  protected heading(count: number): string {
    return count === 1 ? $localize`Discard 1 file?` : $localize`Discard ${count} files?`;
  }

  protected effectText = discardEffectText;

  /** Asks Git what discarding these files would do and shows it for confirmation. */
  async start(files: ReadonlyArray<CommitFile>): Promise<void> {
    if (this.busy() || files.length === 0) return;
    this.busy.set(true);
    this.setOutcome(null);
    const sessionId = this.sessionId();
    const exit = await this.runtime.run(prepare(sessionId, files));
    this.busy.set(false);
    if (sessionId !== this.sessionId()) return;
    if (!Exit.isSuccess(exit)) {
      this.setOutcome({ kind: 'problem', text: $localize`Could not check these files.` });
      return;
    }
    const result = exit.value;
    if (result._tag === 'Ready') {
      this.review.set({ files, token: result.token, planned: result.files });
    } else if (result._tag === 'Rejected') {
      this.setOutcome({ kind: 'problem', text: discardRejectionText(result.reason) });
    } else {
      this.setOutcome({ kind: 'problem', text: unavailableText(result.reason) });
    }
  }

  protected async confirm(): Promise<void> {
    const pending = this.review();
    if (pending === null || this.busy()) return;
    this.busy.set(true);
    const sessionId = this.sessionId();
    const exit = await this.runtime.run(discard(sessionId, pending.files, pending.token));
    this.busy.set(false);
    if (sessionId !== this.sessionId()) return;
    this.review.set(null);
    if (!Exit.isSuccess(exit)) {
      this.setOutcome({ kind: 'problem', text: $localize`Could not discard.` });
      return;
    }
    this.show(exit.value);
  }

  private show(result: DiscardResult): void {
    switch (result._tag) {
      case 'Discarded': {
        const folder = result.recoveryFolder;
        const days = result.recoveryDays;
        this.setOutcome({
          kind: 'ok',
          text:
            result.count === 1
              ? $localize`Discarded 1 file. A copy is kept for ${days} days in ${folder}.`
              : $localize`Discarded ${result.count} files. A copy is kept for ${days} days in ${folder}.`,
        });
        this.changed.emit();
        return;
      }
      case 'Rejected':
        this.setOutcome({ kind: 'problem', text: discardRejectionText(result.reason) });
        // Whatever moved the files is on disk now: show the list as it is.
        if (result.reason === 'Stale') this.changed.emit();
        return;
      case 'Failed':
        this.setOutcome({
          kind: 'problem',
          text: $localize`Git could not discard everything.`,
          output: result.detail,
        });
        this.changed.emit();
        return;
      case 'Unavailable':
        this.setOutcome({ kind: 'problem', text: unavailableText(result.reason) });
        return;
    }
  }
}
