import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import { HlmButtonImports } from '@ui/button';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type {
  CommitFile,
  DiscardResult,
  PlannedDiscard,
} from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { discardEffectText, discardRejectionText, unavailableText } from './git-text';

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
 * Discard selected or all changes. The user first sees exactly which files will be affected (as Git sees them
 * now); confirming sends that same list with a token, and Spence refuses if the files changed in the meantime.
 */
@Component({
  selector: 'app-discard-panel',
  imports: [HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mt-2 flex flex-col gap-2', 'data-testid': 'discard-panel' },
  template: `
    <div class="flex items-center gap-2">
      <button
        type="button"
        hlmBtn
        variant="ghost"
        size="sm"
        data-testid="discard-button"
        [disabled]="busy() || selected().length === 0"
        (click)="start(selected())"
        i18n
      >
        Discard selected…
      </button>
      <button
        type="button"
        hlmBtn
        variant="ghost"
        size="sm"
        data-testid="discard-all-button"
        [disabled]="busy() || all().length === 0"
        (click)="start(all())"
        i18n
      >
        Discard all…
      </button>
    </div>
    @if (review(); as pending) {
      <div
        class="border-destructive/40 flex flex-col gap-2 rounded-xl border p-3"
        role="alertdialog"
        aria-label="Confirm discard"
        i18n-aria-label
        data-testid="discard-confirm"
      >
        <p class="text-sm font-medium" data-testid="discard-heading">
          {{ heading(pending.planned.length) }}
        </p>
        <ul class="max-h-48 overflow-auto text-xs" data-testid="discard-files">
          @for (file of pending.planned; track file.path) {
            <li class="flex gap-2 py-0.5" data-testid="discard-file">
              <span class="min-w-0 flex-1 truncate font-mono">{{ file.path }}</span>
              <span class="text-muted-foreground shrink-0">{{ effectText(file.effect) }}</span>
            </li>
          }
        </ul>
        <p class="text-muted-foreground text-xs" i18n>
          This cannot be undone from here. A copy is kept for 30 days.
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            hlmBtn
            variant="destructive"
            size="sm"
            data-testid="discard-confirm-button"
            [disabled]="busy()"
            (click)="confirm()"
            i18n
          >
            Discard
          </button>
          <button
            type="button"
            hlmBtn
            variant="ghost"
            size="sm"
            data-testid="discard-cancel-button"
            [disabled]="busy()"
            (click)="review.set(null)"
            i18n
          >
            Cancel
          </button>
        </div>
      </div>
    }
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
  /** The ticked files. */
  readonly selected = input<ReadonlyArray<CommitFile>>([]);
  /** Every changed file that can be discarded. */
  readonly all = input<ReadonlyArray<CommitFile>>([]);
  /** Something was discarded or is out of date: the page reads the folder again. */
  readonly changed = output<void>();

  private readonly runtime = inject(EffectRuntime);

  protected readonly busy = signal(false);
  protected readonly review = signal<Review | null>(null);
  protected readonly outcome = signal<Outcome | null>(null);

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.review.set(null);
        this.outcome.set(null);
      });
    });
  }

  protected heading(count: number): string {
    return count === 1 ? $localize`Discard 1 file?` : $localize`Discard ${count} files?`;
  }

  protected effectText = discardEffectText;

  protected async start(files: ReadonlyArray<CommitFile>): Promise<void> {
    if (this.busy() || files.length === 0) return;
    this.busy.set(true);
    this.outcome.set(null);
    const sessionId = this.sessionId();
    const exit = await this.runtime.run(prepare(sessionId, files));
    this.busy.set(false);
    if (sessionId !== this.sessionId()) return;
    if (!Exit.isSuccess(exit)) {
      this.outcome.set({ kind: 'problem', text: $localize`Could not check these files.` });
      return;
    }
    const result = exit.value;
    if (result._tag === 'Ready') {
      this.review.set({ files, token: result.token, planned: result.files });
    } else if (result._tag === 'Rejected') {
      this.outcome.set({ kind: 'problem', text: discardRejectionText(result.reason) });
    } else {
      this.outcome.set({ kind: 'problem', text: unavailableText(result.reason) });
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
      this.outcome.set({ kind: 'problem', text: $localize`Could not discard.` });
      return;
    }
    this.show(exit.value);
  }

  private show(result: DiscardResult): void {
    switch (result._tag) {
      case 'Discarded': {
        const folder = result.recoveryFolder;
        const days = result.recoveryDays;
        this.outcome.set({
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
        this.outcome.set({ kind: 'problem', text: discardRejectionText(result.reason) });
        // Whatever moved the files is on disk now: show the list as it is.
        if (result.reason === 'Stale') this.changed.emit();
        return;
      case 'Failed':
        this.outcome.set({
          kind: 'problem',
          text: $localize`Git could not discard everything.`,
          output: result.detail,
        });
        this.changed.emit();
        return;
      case 'Unavailable':
        this.outcome.set({ kind: 'problem', text: unavailableText(result.reason) });
        return;
    }
  }
}
