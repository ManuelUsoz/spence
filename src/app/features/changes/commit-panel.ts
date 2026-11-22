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
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmTextareaImports } from '@ui/textarea';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { CommitFile, CommitResult } from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { commitRejectionText, unavailableText } from '../../core/git-text';

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
  imports: [HlmButtonImports, HlmDropdownMenuImports, HlmTextareaImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'border-border/60 flex shrink-0 flex-col gap-2 border-t p-3',
    'data-testid': 'commit-panel',
  },
  template: `
    @if (running()) {
      <p class="text-xs text-[var(--attention)]" data-testid="still-editing" i18n>
        The Agent is still editing. These files may change before you commit.
      </p>
    }
    <textarea
      hlmTextarea
      rows="2"
      class="min-h-0 resize-none rounded-xl text-[13.5px]"
      data-testid="commit-message"
      placeholder="Commit message"
      i18n-placeholder
      aria-label="Commit message"
      i18n-aria-label
      [value]="message()"
      (input)="message.set($any($event.target).value)"
    ></textarea>
    <div class="flex items-center justify-end">
      <span class="flex shrink-0">
        <button
          type="button"
          hlmBtn
          size="sm"
          class="rounded-l-full rounded-r-none px-3.5"
          data-testid="commit-button"
          [disabled]="!canCommit()"
          (click)="run(false)"
        >
          {{ commitLabel() }}
        </button>
        <button
          type="button"
          hlmBtn
          size="sm"
          class="ml-px rounded-l-none rounded-r-full px-2"
          data-testid="commit-more"
          aria-label="More: commit and push"
          i18n-aria-label
          [disabled]="!canCommit() || !canPush()"
          [hlmDropdownMenuTrigger]="commitMenu"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
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

    <ng-template #commitMenu>
      <hlm-dropdown-menu class="w-48 rounded-xl" data-testid="commit-menu">
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="commit-push-button"
          (triggered)="run(true)"
          i18n
        >
          Commit & push
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class CommitPanel {
  readonly sessionId = input.required<SessionId>();
  /** The ticked files, as Git should commit them. */
  readonly files = input<ReadonlyArray<CommitFile>>([]);
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

  protected readonly commitLabel = computed(() => {
    const count = this.files().length;
    if (count === 0) return $localize`Commit`;
    return count === 1 ? $localize`Commit 1 file` : $localize`Commit ${count} files`;
  });
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
    const sessionId = this.sessionId();
    const exit = await this.runtime.run(
      commit(sessionId, this.message(), this.files(), push, this.remote()),
    );
    this.busy.set(false);
    // The answer belongs to the Session it was asked for.
    if (sessionId !== this.sessionId()) return;
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
