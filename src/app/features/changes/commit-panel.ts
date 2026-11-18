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
import { HlmButtonImports } from '@ui/button';
import { HlmTextareaImports } from '@ui/textarea';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { CommitFile, CommitResult } from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { commitRejectionText, unavailableText } from './git-text';

const commit = Effect.fnUntraced(function* (
  sessionId: SessionId,
  message: string,
  files: ReadonlyArray<CommitFile>,
  push: boolean,
  remote: string | undefined,
) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.commit']({
    sessionId,
    message,
    files,
    push,
    ...(remote === undefined ? {} : { remote }),
  });
});

type Outcome =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'problem'; readonly text: string; readonly output?: string };

/** The message box and Commit / Commit & push for the files ticked in the list. */
@Component({
  selector: 'app-commit-panel',
  imports: [HlmButtonImports, HlmTextareaImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mt-3 flex flex-col gap-2', 'data-testid': 'commit-panel' },
  template: `
    @if (running()) {
      <p class="text-xs text-[var(--attention)]" data-testid="still-editing" i18n>
        The Agent is still editing. These files may change before you commit.
      </p>
    }
    <textarea
      hlmTextarea
      rows="3"
      data-testid="commit-message"
      placeholder="Commit message"
      i18n-placeholder
      aria-label="Commit message"
      i18n-aria-label
      [value]="message()"
      (input)="message.set($any($event.target).value)"
    ></textarea>
    <div class="flex items-center gap-2">
      <button
        type="button"
        hlmBtn
        size="sm"
        data-testid="commit-button"
        [disabled]="!canCommit()"
        (click)="run(false)"
        i18n
      >
        Commit
      </button>
      <button
        type="button"
        hlmBtn
        variant="outline"
        size="sm"
        data-testid="commit-push-button"
        [disabled]="!canCommit() || !canPush()"
        (click)="run(true)"
        i18n
      >
        Commit & push
      </button>
      <span class="text-muted-foreground text-xs tabular-nums" data-testid="commit-count">
        {{ selectedCount() }} / {{ totalCount() }}
      </span>
    </div>
    @if (outcome(); as result) {
      <p
        class="text-xs"
        [class.text-destructive]="result.kind === 'problem'"
        [class.text-muted-foreground]="result.kind === 'ok'"
        data-testid="commit-outcome"
      >
        {{ result.text }}
      </p>
      @if (result.kind === 'problem' && result.output) {
        <pre
          class="border-border/60 max-h-40 overflow-auto rounded-lg border p-2 font-mono text-xs whitespace-pre-wrap"
          data-testid="commit-output"
          >{{ result.output }}</pre>
      }
    }
  `,
})
export class CommitPanel {
  readonly sessionId = input.required<SessionId>();
  /** The ticked files, as Git should commit them. */
  readonly files = input<ReadonlyArray<CommitFile>>([]);
  readonly totalCount = input<number>(0);
  /** The Agent is mid-Turn, so the files may still change. */
  readonly running = input<boolean>(false);
  /** Where Commit & push can go: the upstream, or the remote chosen/only one. */
  readonly canPush = input<boolean>(false);
  /** The remote to push to while the branch has no upstream. */
  readonly remote = input<string | undefined>(undefined);
  /** A commit (or push) happened: the page reads the folder again. */
  readonly changed = output<void>();

  private readonly runtime = inject(EffectRuntime);

  protected readonly message = signal('');
  protected readonly busy = signal(false);
  protected readonly outcome = signal<Outcome | null>(null);

  protected readonly selectedCount = computed(() => this.files().length);
  protected readonly canCommit = computed(
    () => !this.busy() && this.files().length > 0 && this.message().trim().length > 0,
  );

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.message.set('');
        this.outcome.set(null);
      });
    });
  }

  protected async run(push: boolean): Promise<void> {
    if (!this.canCommit() || (push && !this.canPush())) return;
    this.busy.set(true);
    this.outcome.set(null);
    const exit = await this.runtime.run(
      commit(this.sessionId(), this.message(), this.files(), push, this.remote()),
    );
    this.busy.set(false);
    if (!Exit.isSuccess(exit)) {
      this.outcome.set({ kind: 'problem', text: $localize`Could not commit.` });
      return;
    }
    this.show(exit.value);
  }

  private show(result: CommitResult): void {
    switch (result._tag) {
      case 'Committed': {
        this.message.set('');
        const sha = result.shortSha;
        this.outcome.set(
          result.pushed === 'Failed'
            ? {
                kind: 'problem',
                text: $localize`Committed ${sha}, but the push did not go through.`,
                ...(result.pushDetail === undefined ? {} : { output: result.pushDetail }),
              }
            : {
                kind: 'ok',
                text:
                  result.pushed === 'Pushed'
                    ? $localize`Committed ${sha} and pushed.`
                    : $localize`Committed ${sha}.`,
              },
        );
        this.changed.emit();
        return;
      }
      case 'Rejected':
        this.outcome.set({ kind: 'problem', text: commitRejectionText(result.reason) });
        return;
      case 'Failed':
        this.outcome.set({
          kind: 'problem',
          text: $localize`Git did not commit.`,
          output: result.detail,
        });
        return;
      case 'Unavailable':
        this.outcome.set({ kind: 'problem', text: unavailableText(result.reason) });
        return;
    }
  }
}
