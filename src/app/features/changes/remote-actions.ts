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
import type { RemoteResult } from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { remoteRejectionText, unavailableText } from './git-text';

type Action = 'fetch' | 'pull' | 'push';

const runAction = Effect.fnUntraced(function* (
  sessionId: SessionId,
  action: Action,
  remote: string | undefined,
) {
  const api = yield* DesktopApi;
  if (action === 'fetch') return yield* api['SourceControl.fetch']({ sessionId });
  if (action === 'pull') return yield* api['SourceControl.pull']({ sessionId });
  return yield* api['SourceControl.push']({
    sessionId,
    ...(remote === undefined ? {} : { remote }),
  });
});

/** Fetch, fast-forward Pull and Push for the Session's branch. */
@Component({
  selector: 'app-remote-actions',
  imports: [HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-1', 'data-testid': 'remote-actions' },
  template: `
    <div class="flex items-center gap-1">
      <button
        type="button"
        hlmBtn
        variant="ghost"
        size="sm"
        data-testid="fetch-button"
        [disabled]="busy() !== null"
        (click)="run('fetch')"
        i18n
      >
        Fetch
      </button>
      <button
        type="button"
        hlmBtn
        variant="ghost"
        size="sm"
        data-testid="pull-button"
        [disabled]="busy() !== null || !hasUpstream()"
        (click)="run('pull')"
      >
        <span i18n>Pull</span>
        @if (behind() > 0) {
          <span class="text-muted-foreground tabular-nums">↓{{ behind() }}</span>
        }
      </button>
      <button
        type="button"
        hlmBtn
        variant="ghost"
        size="sm"
        data-testid="push-button"
        [disabled]="busy() !== null || !canPush()"
        (click)="run('push')"
      >
        <span i18n>Push</span>
        @if (ahead() > 0) {
          <span class="text-muted-foreground tabular-nums">↑{{ ahead() }}</span>
        }
      </button>
    </div>
    @if (outcome(); as result) {
      <p
        class="max-w-md text-xs"
        [class.text-destructive]="result.problem"
        [class.text-muted-foreground]="!result.problem"
        data-testid="remote-outcome"
      >
        {{ result.text }}
      </p>
      @if (result.output) {
        <pre
          class="border-border/60 max-h-32 max-w-md overflow-auto rounded-lg border p-2 font-mono text-xs whitespace-pre-wrap"
          data-testid="remote-output"
          >{{ result.output }}</pre>
      }
    }
  `,
})
export class RemoteActions {
  readonly sessionId = input.required<SessionId>();
  readonly ahead = input<number>(0);
  readonly behind = input<number>(0);
  /** The branch tracks a remote branch. */
  readonly hasUpstream = input<boolean>(false);
  /** Push can go somewhere: the upstream, or the remote chosen/only one. */
  readonly canPush = input<boolean>(false);
  readonly remote = input<string | undefined>(undefined);
  /** Something changed on disk or in the remote tracking: the page reads the folder again. */
  readonly changed = output<void>();

  private readonly runtime = inject(EffectRuntime);

  protected readonly busy = signal<Action | null>(null);
  protected readonly outcome = signal<{
    readonly text: string;
    readonly problem: boolean;
    readonly output?: string;
  } | null>(null);

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => this.outcome.set(null));
    });
  }

  protected async run(action: Action): Promise<void> {
    if (this.busy() !== null) return;
    this.busy.set(action);
    this.outcome.set(null);
    const exit = await this.runtime.run(runAction(this.sessionId(), action, this.remote()));
    this.busy.set(null);
    if (!Exit.isSuccess(exit)) {
      this.outcome.set({ text: $localize`That did not work.`, problem: true });
      return;
    }
    this.show(action, exit.value);
  }

  private show(action: Action, result: RemoteResult): void {
    switch (result._tag) {
      case 'Done':
        this.outcome.set({
          text:
            action === 'fetch'
              ? $localize`Fetched.`
              : action === 'pull'
                ? $localize`Pulled.`
                : $localize`Pushed.`,
          problem: false,
        });
        this.changed.emit();
        return;
      case 'Rejected':
        this.outcome.set({ text: remoteRejectionText(result.reason), problem: true });
        return;
      case 'Failed':
        this.outcome.set({
          text:
            action === 'fetch'
              ? $localize`Git could not fetch.`
              : action === 'pull'
                ? $localize`Git could not pull.`
                : $localize`Git could not push.`,
          problem: true,
          output: result.detail,
        });
        return;
      case 'Unavailable':
        this.outcome.set({ text: unavailableText(result.reason), problem: true });
        return;
    }
  }
}
