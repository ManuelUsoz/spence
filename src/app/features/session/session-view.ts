import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
  type OnInit,
  viewChild,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmKbdImports } from '@ui/kbd';
import { HlmTextareaImports } from '@ui/textarea';
import { HlmToggleGroupImports } from '@ui/toggle-group';
import { toast } from '@ui/toast';
import { Cause, Effect, Exit, Option, Schedule, Schema, Stream } from 'effect';
import { PermissionMode } from '../../../shared/projects/projects.rpc';
import type {
  PermissionRequestId,
  SessionId,
  SessionStreamItem,
  TurnId,
  TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import {
  emptyThread,
  foldThread,
  permissionMark,
  textRuns,
  type Thread,
  type ThreadStep,
} from './thread';

/** How long to wait before following a stream that dropped (e.g. the port closed) again. */
const RESUBSCRIBE_AFTER = '500 millis';

/** A `SessionError` means the Session itself is gone: following again would not help. */
const sessionGone = (cause: Cause.Cause<{ readonly _tag: string }>): boolean =>
  Option.exists(Cause.findErrorOption(cause), (error) => error._tag === 'SessionError');

/**
 * Follows the Session's events, handing each item to `onItem`, until the stream ends. When it drops it follows again
 * after `lastSeq()`, the last `seq` seen.
 */
const follow = Effect.fnUntraced(function* (
  sessionId: SessionId,
  lastSeq: () => number,
  onItem: (item: SessionStreamItem) => void,
) {
  const api = yield* DesktopApi;
  yield* Effect.suspend(() => {
    const afterSeq = lastSeq();
    return api['Session.events'](afterSeq === 0 ? { sessionId } : { sessionId, afterSeq }).pipe(
      Stream.runForEach((item) => Effect.sync(() => onItem(item))),
    );
  }).pipe(
    Effect.sandbox,
    Effect.retry({
      schedule: Schedule.spaced(RESUBSCRIBE_AFTER),
      while: (cause) => !sessionGone(cause),
    }),
    Effect.catch((cause) => Effect.failCause(cause)),
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

const answerPermission = Effect.fnUntraced(function* (
  sessionId: SessionId,
  requestId: PermissionRequestId,
  optionId: string,
) {
  const api = yield* DesktopApi;
  yield* api['Session.answerPermission']({ sessionId, requestId, optionId });
});

const setPermissionMode = Effect.fnUntraced(function* (sessionId: SessionId, mode: PermissionMode) {
  const api = yield* DesktopApi;
  yield* api['Session.setOption']({ sessionId, option: 'permissionMode', value: mode });
});

const isPermissionMode = Schema.is(PermissionMode);

const optionOrder = (kind: 'allowOnce' | 'allowAlways' | 'rejectOnce' | 'rejectAlways'): number => {
  switch (kind) {
    case 'allowOnce':
      return 0;
    case 'allowAlways':
      return 1;
    case 'rejectOnce':
      return 2;
    case 'rejectAlways':
      return 3;
  }
};

/**
 * One Session: its thread (user and Agent Messages, Steps, Permission requests), the Dock, the Ticker and the
 * Composer. Enter sends, Shift+Enter starts a new line; Send waits while a Turn runs, and Stop asks the Agent to end
 * it.
 */
@Component({
  selector: 'app-session-view',
  imports: [HlmButtonImports, HlmKbdImports, HlmTextareaImports, HlmToggleGroupImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col' },
  template: `
    @switch (following()) {
      @case ('loading') {
        <p class="text-muted-foreground pb-4 text-sm" data-testid="session-loading" i18n>
          Opening the Session…
        </p>
      }
      @case ('failed') {
        <p class="text-destructive pb-4 text-sm" data-testid="session-unavailable" i18n>
          Could not open this Session.
        </p>
      }
    }

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
            @case ('done') {}
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
          @for (step of stepsForTurn(message.turnId); track step.id) {
            <div
              class="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="receipt-step"
            >
              <span class="font-mono text-xs" data-testid="receipt-step-title">{{
                step.title
              }}</span>
              @if (stepMark(step); as mark) {
                <span class="text-xs" data-testid="receipt-mark">{{ mark }}</span>
              }
            </div>
          }
        }
      }
    </div>

    @if (running() && pendingPermission(); as pending) {
      <div class="flex items-center gap-2 pb-2 text-sm text-muted-foreground" data-testid="ticker">
        <span class="size-2 rounded-full bg-[var(--attention)]"></span>
        <span i18n>Waiting for you below</span>
      </div>
      <div class="border-border mb-2 flex flex-col gap-2 rounded-lg border p-3" data-testid="dock">
        <div class="font-mono text-sm" data-testid="dock-title">{{ pending.title }}</div>
        <div class="flex flex-wrap gap-2">
          @for (option of sortedOptions(); track option.id; let i = $index) {
            <button
              hlmBtn
              [variant]="i === 0 ? 'default' : 'outline'"
              size="sm"
              data-testid="dock-option"
              (click)="answer(option.id)"
            >
              <span>{{ option.label }}</span>
              @if (i < 4) {
                <kbd hlmKbd class="ml-1">{{ i + 1 }}</kbd>
              }
            </button>
          }
        </div>
      </div>
    }

    @if (following() !== 'failed') {
      <form
        class="bg-background sticky bottom-0 flex flex-col gap-2 pb-2"
        data-testid="composer"
        (submit)="$event.preventDefault(); send()"
      >
        <div class="flex items-center justify-between gap-2">
          <div
            hlmToggleGroup
            variant="outline"
            size="sm"
            data-testid="permission-mode"
            aria-label="Permission mode"
            i18n-aria-label
            [nullable]="false"
            [value]="permissionMode()"
            (valueChange)="onModeChange($event)"
          >
            <button hlmToggleGroupItem value="ask" data-testid="permission-mode-ask" i18n>
              Ask
            </button>
            <button hlmToggleGroupItem value="auto" data-testid="permission-mode-auto" i18n>
              Auto
            </button>
          </div>
        </div>
        <textarea
          #composerInput
          hlmTextarea
          class="max-h-48"
          data-testid="composer-input"
          placeholder="Message the Agent"
          i18n-placeholder
          aria-label="Message"
          i18n-aria-label
          [value]="draft()"
          (input)="draft.set(composerInput.value)"
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
    }
  `,
})
export class SessionView implements OnInit {
  private readonly runtime = inject(EffectRuntime);
  private readonly aborts = new AbortController();

  readonly sessionId = input.required<SessionId>();
  private readonly composerInput = viewChild.required<HTMLTextAreaElement>('composerInput');

  protected readonly thread = signal<Thread>(emptyThread);
  /** Whether the Session's events arrive: before the first one, while they do, or never (the Session is gone). */
  protected readonly following = signal<'loading' | 'following' | 'failed'>('loading');
  protected readonly draft = signal('');
  /** A prompt was sent and its Turn has not shown up yet. */
  private readonly sending = signal(false);

  protected readonly running = computed(() => this.thread().running !== null);
  protected readonly canSend = computed(
    () => !this.running() && !this.sending() && this.draft().trim() !== '',
  );
  protected readonly permissionMode = computed(() => this.thread().permissionMode ?? 'auto');
  protected readonly pendingPermission = computed(() => {
    const turnId = this.thread().running;
    if (turnId === null) return null;
    const request = this.thread().permissions.find(
      (permission) => permission.turnId === turnId && permission.state._tag === 'pending',
    );
    if (request === undefined) return null;
    const step = this.thread().steps.find((existing) => existing.id === request.stepId);
    return {
      requestId: request.id,
      title: step?.title ?? '',
      options: request.options,
    };
  });
  protected readonly sortedOptions = computed(() =>
    [...(this.pendingPermission()?.options ?? [])].sort(
      (a, b) => optionOrder(a.kind) - optionOrder(b.kind),
    ),
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
    return outcomes.get(turnId) ?? null;
  }

  protected stepsForTurn(turnId: TurnId): ReadonlyArray<ThreadStep> {
    return this.thread().steps.filter((step) => step.turnId === turnId);
  }

  protected stepMark(step: ThreadStep): 'auto' | 'rejected' | null {
    return permissionMark(step, this.thread().permissions);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.send();
  }

  @HostListener('window:keydown', ['$event'])
  protected onWindowKeydown(event: KeyboardEvent): void {
    const pending = this.pendingPermission();
    if (pending === null) return;
    if (!/^[1-4]$/.test(event.key)) return;
    const index = Number(event.key) - 1;
    if (index >= pending.options.length) return;
    const option = pending.options[index];
    if (option === undefined) return;
    if (!this.mayAnswerWithKey(event.target)) return;
    event.preventDefault();
    void this.answer(option.id);
  }

  protected async answer(optionId: string): Promise<void> {
    const pending = this.pendingPermission();
    if (pending === null) return;
    await this.runtime.run(answerPermission(this.sessionId(), pending.requestId, optionId), {
      signal: this.aborts.signal,
    });
  }

  protected onModeChange(value: unknown): void {
    if (isPermissionMode(value) && value !== this.permissionMode()) {
      void this.runtime.run(setPermissionMode(this.sessionId(), value), {
        signal: this.aborts.signal,
      });
    }
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

  private async subscribe(): Promise<void> {
    const exit = await this.runtime.run(
      follow(
        this.sessionId(),
        () => this.thread().lastSeq,
        (item) => {
          this.following.set('following');
          this.thread.update((thread) => foldThread(thread, item));
        },
      ),
      { signal: this.aborts.signal },
    );
    if (Exit.isFailure(exit) && !this.aborts.signal.aborted) this.following.set('failed');
  }

  private mayAnswerWithKey(target: EventTarget | null): boolean {
    if (target === null) return true;
    const composer = this.composerInput();
    if (target === composer) return composer.value === '';
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.getAttribute('contenteditable') === 'true')
    ) {
      return false;
    }
    return true;
  }
}
