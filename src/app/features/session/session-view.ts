import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmTextareaImports } from '@ui/textarea';
import { toast } from '@ui/toast';
import { Cause, Effect, Exit, Option, Stream } from 'effect';
import type {
  SessionId,
  SessionStreamItem,
  TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { emptyThread, foldThread, textRuns, type Thread } from './thread';

/** How long to wait before following a stream that dropped (e.g. the port closed) again. */
const RESUBSCRIBE_AFTER_MS = 500;

/** Follows the Session's events from after `afterSeq`, handing each item to `onItem`, until the stream ends. */
const follow = Effect.fnUntraced(function* (
  sessionId: SessionId,
  afterSeq: number,
  onItem: (item: SessionStreamItem) => void,
) {
  const api = yield* DesktopApi;
  yield* api['Session.events'](afterSeq === 0 ? { sessionId } : { sessionId, afterSeq }).pipe(
    Stream.runForEach((item) => Effect.sync(() => onItem(item))),
  );
});

const sendPrompt = Effect.fnUntraced(function* (sessionId: SessionId, text: string) {
  const api = yield* DesktopApi;
  return yield* api['Session.prompt']({ sessionId, parts: [{ _tag: 'text', text }] });
});

const cancelTurn = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.cancel']({ sessionId });
});

/**
 * One Session: its thread (user and Agent Messages, text only) and the Composer. Enter sends, Shift+Enter starts a
 * new line; Send waits while a Turn runs, and Stop asks the Agent to end it.
 */
@Component({
  selector: 'app-session-view',
  imports: [HlmButtonImports, HlmTextareaImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col' },
  template: `
    <div class="flex flex-col gap-4 pb-4" data-testid="thread">
      @for (message of thread().messages; track message.id) {
        @if (message.role === 'user') {
          <div
            class="bg-muted max-w-[80%] self-end rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
            data-testid="message-user"
          >
            {{ message.text }}
          </div>
        } @else {
          <div class="text-sm leading-relaxed whitespace-pre-wrap" data-testid="message-agent">
            @for (run of runs(message.text); track $index) {
              @switch (run.kind) {
                @case ('prose') {
                  <span>{{ run.text }}</span>
                }
                @case ('code') {
                  <code class="bg-muted rounded px-1 font-mono text-xs">{{ run.text }}</code>
                }
                @case ('block') {
                  <pre
                    class="bg-muted my-2 overflow-x-auto rounded-md p-3"
                  ><code class="font-mono text-xs">{{ run.text }}</code></pre>
                }
              }
            }
          </div>
        }
        @if (outcomeAfter(message.turnId, $index); as outcome) {
          @switch (outcome._tag) {
            @case ('cancelled') {
              <p class="text-muted-foreground text-sm" data-testid="outcome" i18n>Stopped.</p>
            }
            @case ('refused') {
              <p class="text-muted-foreground text-sm" data-testid="outcome" i18n>
                The Agent declined.
              </p>
            }
            @case ('cutShort') {
              <p class="text-muted-foreground text-sm" data-testid="outcome" i18n>
                The Agent hit a limit and stopped.
              </p>
            }
            @case ('failed') {
              <p class="text-destructive text-sm whitespace-pre-wrap" data-testid="outcome">
                {{ outcome.detail }}
              </p>
            }
          }
        }
      }
    </div>

    <form
      class="bg-background sticky bottom-0 flex flex-col gap-2 pb-2"
      data-testid="composer"
      (submit)="$event.preventDefault(); send()"
    >
      <textarea
        hlmTextarea
        class="max-h-48"
        data-testid="composer-input"
        placeholder="Message the Agent"
        i18n-placeholder
        aria-label="Message"
        i18n-aria-label
        [value]="draft()"
        (input)="draft.set($any($event.target).value)"
        (keydown)="onKeydown($event)"
      ></textarea>
      <div class="flex justify-end gap-2">
        @if (running()) {
          <button hlmBtn type="button" variant="outline" data-testid="stop" (click)="stop()" i18n>
            Stop
          </button>
        }
        <button hlmBtn type="submit" data-testid="send" [disabled]="!canSend()" i18n>Send</button>
      </div>
    </form>
  `,
})
export class SessionView implements OnInit {
  private readonly runtime = inject(EffectRuntime);
  private readonly aborts = new AbortController();

  readonly sessionId = input.required<SessionId>();

  protected readonly thread = signal<Thread>(emptyThread);
  protected readonly draft = signal('');
  /** A prompt was sent and its Turn has not shown up yet. */
  private readonly sending = signal(false);

  protected readonly running = computed(() => this.thread().running !== null);
  protected readonly canSend = computed(
    () => !this.running() && !this.sending() && this.draft().trim() !== '',
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
  }

  ngOnInit(): void {
    void this.subscribe();
  }

  protected runs(text: string) {
    return textRuns(text);
  }

  /** The Turn's outcome, shown under the last Message of that Turn. `done` shows nothing. */
  protected outcomeAfter(
    turnId: Thread['messages'][number]['turnId'],
    index: number,
  ): TurnOutcome | null {
    const { messages, outcomes } = this.thread();
    if (messages[index + 1]?.turnId === turnId) return null;
    const outcome = outcomes.get(turnId);
    return outcome === undefined || outcome._tag === 'done' ? null : outcome;
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.send();
  }

  protected async send(): Promise<void> {
    if (!this.canSend()) return;
    const text = this.draft();
    this.sending.set(true);
    const exit = await this.runtime.run(sendPrompt(this.sessionId(), text), {
      signal: this.aborts.signal,
    });
    this.sending.set(false);
    if (Exit.isSuccess(exit)) {
      // Cleared only if the user did not type on meanwhile.
      if (this.draft() === text) this.draft.set('');
      return;
    }
    if (!this.aborts.signal.aborted) toast.error($localize`Could not send the Message.`);
  }

  protected async stop(): Promise<void> {
    await this.runtime.run(cancelTurn(this.sessionId()), { signal: this.aborts.signal });
  }

  /** Follows the Session's events; when the stream drops, follows again after the last `seq` seen. */
  private async subscribe(): Promise<void> {
    while (!this.aborts.signal.aborted) {
      const exit = await this.runtime.run(
        follow(this.sessionId(), this.thread().lastSeq, (item) =>
          this.thread.update((thread) => foldThread(thread, item)),
        ),
        { signal: this.aborts.signal },
      );
      if (Exit.isSuccess(exit) || this.aborts.signal.aborted) return;
      // The Session itself is gone: following again would not help.
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error) && error.value._tag === 'SessionError') return;
      await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_AFTER_MS));
    }
  }
}
