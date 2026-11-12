import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  viewChild,
  type ElementRef,
  type OnInit,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmNativeSelectImports } from '@ui/native-select';
import { HlmTextareaImports } from '@ui/textarea';
import { HlmToggleGroupImports } from '@ui/toggle-group';
import { HlmTooltipImports } from '@ui/tooltip';
import { toast } from '@ui/toast';
import { Cause, Effect, Exit, Option, Schedule, Stream } from 'effect';
import type { Effort } from '../../../shared/agents/agents.rpc';
import type {
  Command,
  SessionId,
  SessionStreamItem,
  TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { emptyThread, foldThread, textRuns, type Thread, type ThreadDivider } from './thread';

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

const setOption = Effect.fnUntraced(function* (
  sessionId: SessionId,
  option: 'model' | 'effort',
  value: string,
) {
  const api = yield* DesktopApi;
  yield* api['Session.setOption']({ sessionId, option, value });
});

const clearContext = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.clearContext']({ sessionId });
});

/**
 * One Session: its thread (user and Agent Messages, text only) and the Composer. Enter sends, Shift+Enter starts a
 * new line; Send waits while a Turn runs, and Stop asks the Agent to end it.
 */
@Component({
  selector: 'app-session-view',
  imports: [
    HlmButtonImports,
    HlmNativeSelectImports,
    HlmTextareaImports,
    HlmToggleGroupImports,
    HlmTooltipImports,
  ],
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
      @for (message of thread().messages; track message.id; let i = $index) {
        @for (divider of dividersAt(i); track divider.beforeIndex) {
          <div
            class="text-muted-foreground flex items-center gap-3 text-xs"
            data-testid="context-divider"
          >
            <span class="bg-border h-px flex-1"></span>
            @switch (divider.reason) {
              @case ('cleared') {
                <span i18n>Context cleared</span>
              }
              @case ('lost') {
                <span i18n>Context lost</span>
              }
            }
            <span class="bg-border h-px flex-1"></span>
          </div>
        }
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
      @for (divider of trailingDividers(); track divider.beforeIndex) {
        <div
          class="text-muted-foreground flex items-center gap-3 text-xs"
          data-testid="context-divider"
        >
          <span class="bg-border h-px flex-1"></span>
          @switch (divider.reason) {
            @case ('cleared') {
              <span i18n>Context cleared</span>
            }
            @case ('lost') {
              <span i18n>Context lost</span>
            }
          }
          <span class="bg-border h-px flex-1"></span>
        </div>
      }
    </div>

    @if (following() !== 'failed') {
      <form
        class="bg-background sticky bottom-0 flex flex-col gap-2 pb-2"
        data-testid="composer"
        (submit)="$event.preventDefault(); send()"
      >
        <div class="flex flex-wrap items-center gap-2">
          @if (controlsLoading()) {
            <span class="text-muted-foreground text-xs" data-testid="controls-loading" i18n>
              Starting the Agent…
            </span>
          } @else {
            @if (model(); as modelOption) {
              <hlm-native-select
                data-testid="model-picker"
                selectId="model-picker"
                size="sm"
                aria-label="Model"
                i18n-aria-label
                [value]="modelOption.value"
                [disabled]="controlsDisabled()"
                (valueChange)="setModel($event)"
              >
                @for (choice of modelOption.choices; track choice.id) {
                  <option [value]="choice.id">{{ choice.name }}</option>
                }
              </hlm-native-select>
            }
            @if (effort(); as effortOption) {
              <div
                hlmToggleGroup
                type="single"
                size="sm"
                variant="outline"
                [nullable]="false"
                [value]="effortOption.value"
                (valueChange)="setEffort($event)"
                data-testid="effort-picker"
              >
                @for (level of effortLevels; track level) {
                  @let offered = effortOption.choices.includes(level);
                  <button
                    hlmToggleGroupItem
                    type="button"
                    [value]="level"
                    [disabled]="controlsDisabled() || !offered"
                    [hlmTooltip]="offered ? effortLabel(level) : unavailableLevelTooltip()"
                    [attr.data-testid]="'effort-' + level"
                    [attr.aria-label]="effortLabel(level)"
                  >
                    {{ effortLabel(level) }}
                  </button>
                }
              </div>
            }
            <div class="flex-1"></div>
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="clear-context"
              [disabled]="clearing() || running()"
              (click)="onClear()"
              i18n
            >
              Clear
            </button>
            @if (hasCompact()) {
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                data-testid="compact"
                [disabled]="controlsDisabled()"
                (click)="onCompact()"
                i18n
              >
                Compact
              </button>
            }
          }
        </div>

        <div class="relative">
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
            (input)="onInput(composerInput.value)"
            (keydown)="onKeydown($event)"
          ></textarea>

          @if (commandsOpen()) {
            <div
              class="bg-background border-border absolute z-10 mt-1 w-full rounded-md border shadow-md"
              data-testid="commands-list"
              role="listbox"
              [attr.aria-label]="commandsAriaLabel()"
            >
              @for (command of filteredCommands(); track command.name; let i = $index) {
                <button
                  type="button"
                  class="w-full px-3 py-2 text-left text-sm"
                  [class]="i === selectedCommand() ? 'bg-accent text-accent-foreground' : ''"
                  role="option"
                  [attr.aria-selected]="i === selectedCommand()"
                  [attr.data-testid]="'command-' + command.name"
                  (click)="pickCommand(command)"
                >
                  <span class="font-mono">/{{ command.name }}</span>
                  <span class="text-muted-foreground ms-2">{{ command.description }}</span>
                  @if (command.hint) {
                    <span class="text-muted-foreground ms-2 font-mono text-xs">
                      {{ command.hint }}
                    </span>
                  }
                </button>
              } @empty {
                <div class="text-muted-foreground px-3 py-2 text-sm" i18n>No commands match.</div>
              }
            </div>
          }
        </div>

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
  private readonly composerInput =
    viewChild.required<ElementRef<HTMLTextAreaElement>>('composerInput');

  readonly sessionId = input.required<SessionId>();

  protected readonly thread = signal<Thread>(emptyThread);
  /** Whether the Session's events arrive: before the first one, while they do, or never (the Session is gone). */
  protected readonly following = signal<'loading' | 'following' | 'failed'>('loading');
  protected readonly draft = signal('');
  /** A prompt was sent and its Turn has not shown up yet. */
  private readonly sending = signal(false);
  /** `Session.clearContext` is running. */
  protected readonly clearing = signal(false);
  /** The `/` Commands list is open. */
  protected readonly commandsOpen = signal(false);
  /** Selected index in the filtered Commands list. */
  protected readonly selectedCommand = signal(0);

  protected readonly running = computed(() => this.thread().running !== null);
  protected readonly live = computed(() => this.thread().live);
  protected readonly agentStatus = computed(() => this.live()?.agentStatus);
  protected readonly controlsLoading = computed(() => this.agentStatus() === 'starting');
  protected readonly controlsDisabled = computed(() => this.agentStatus() !== 'ready');

  protected readonly model = computed(() => this.live()?.options.model);
  protected readonly effort = computed(() => this.live()?.options.effort);

  protected readonly commands = computed(() => {
    const agentCommands = this.live()?.commands ?? [];
    const list: Array<Command & { readonly isSpence?: boolean }> = [
      { name: 'clear', description: $localize`Clear the context`, isSpence: true },
    ];
    for (const command of agentCommands) {
      if (command.name !== 'clear') list.push(command);
    }
    return list;
  });

  protected readonly hasCompact = computed(() =>
    this.commands().some((command) => command.name === 'compact'),
  );

  protected readonly commandFilter = computed(() => {
    const draft = this.draft();
    return draft.startsWith('/') ? draft.slice(1).trimStart() : '';
  });

  protected readonly filteredCommands = computed(() => {
    const filter = this.commandFilter().toLowerCase();
    if (filter === '') return this.commands();
    return this.commands().filter((command) => command.name.toLowerCase().startsWith(filter));
  });

  protected readonly canSend = computed(
    () => !this.running() && !this.sending() && this.draft().trim() !== '',
  );

  protected readonly unavailableLevelTooltip = () => $localize`this Agent doesn't offer it`;
  protected readonly commandsAriaLabel = () => $localize`Commands`;

  protected readonly effortLevels: ReadonlyArray<Effort> = ['low', 'medium', 'high', 'max'];

  protected effortLabel(level: Effort): string {
    switch (level) {
      case 'low':
        return $localize`Low`;
      case 'medium':
        return $localize`Medium`;
      case 'high':
        return $localize`High`;
      case 'max':
        return $localize`Max`;
    }
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    effect(() => {
      const count = this.filteredCommands().length;
      this.selectedCommand.update((index) => (index >= count ? Math.max(0, count - 1) : index));
    });
  }

  ngOnInit(): void {
    void this.subscribe();
  }

  protected runs(text: string) {
    return textRuns(text);
  }

  /** Dividers that belong before the Message at `index`. */
  protected dividersAt(index: number): ReadonlyArray<ThreadDivider> {
    return this.thread().dividers.filter((divider) => divider.beforeIndex === index);
  }

  /** Dividers that belong after the last Message. */
  protected trailingDividers(): ReadonlyArray<ThreadDivider> {
    return this.thread().dividers.filter(
      (divider) => divider.beforeIndex === this.thread().messages.length,
    );
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

  protected onInput(value: string): void {
    this.draft.set(value);
    if (this.commandsOpen() && !value.startsWith('/')) {
      this.commandsOpen.set(false);
    } else if (value.startsWith('/') && !this.commandsOpen() && this.commands().length > 0) {
      this.commandsOpen.set(true);
      this.selectedCommand.set(0);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (this.commandsOpen()) {
      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault();
          this.selectedCommand.update((index) =>
            Math.min(index + 1, this.filteredCommands().length - 1),
          );
          return;
        }
        case 'ArrowUp': {
          event.preventDefault();
          this.selectedCommand.update((index) => Math.max(index - 1, 0));
          return;
        }
        case 'Enter': {
          const selected = this.filteredCommands()[this.selectedCommand()];
          if (selected !== undefined) {
            event.preventDefault();
            this.pickCommand(selected);
            return;
          }
          // No command matches: send the text instead.
          this.commandsOpen.set(false);
          break;
        }
        case 'Tab': {
          const selected = this.filteredCommands()[this.selectedCommand()];
          if (selected !== undefined) {
            event.preventDefault();
            this.pickCommand(selected);
          }
          return;
        }
        case 'Escape': {
          this.commandsOpen.set(false);
          return;
        }
      }
    }

    if (event.key === '/' && this.draft() === '' && this.commands().length > 0) {
      this.commandsOpen.set(true);
      this.selectedCommand.set(0);
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    if (!this.canSend()) return;
    event.preventDefault();
    void this.send();
  }

  protected setModel(value: string | undefined | null): void {
    if (value === undefined || value === null || value === this.model()?.value) return;
    void this.runOption('model', value);
  }

  protected setEffort(value: unknown): void {
    if (typeof value !== 'string' || value === this.effort()?.value) return;
    void this.runOption('effort', value);
  }

  private async runOption(option: 'model' | 'effort', value: string): Promise<void> {
    const exit = await this.runtime.run(setOption(this.sessionId(), option, value), {
      signal: this.aborts.signal,
    });
    if (Exit.isFailure(exit) && !this.aborts.signal.aborted) {
      toast.error($localize`Could not change the option.`);
    }
  }

  protected async onClear(): Promise<void> {
    if (this.clearing() || this.running()) return;
    this.clearing.set(true);
    const exit = await this.runtime.run(clearContext(this.sessionId()), {
      signal: this.aborts.signal,
    });
    this.clearing.set(false);
    if (Exit.isSuccess(exit)) {
      this.draft.set('');
      return;
    }
    if (!this.aborts.signal.aborted) toast.error($localize`Could not clear the context.`);
  }

  protected onCompact(): void {
    this.draft.set('/compact ');
    this.commandsOpen.set(false);
    this.composerInput().nativeElement.focus();
  }

  protected pickCommand(command: Command & { readonly isSpence?: boolean }): void {
    if (command.name === 'clear' && command.isSpence) {
      void this.onClear();
      return;
    }
    this.draft.set(`/${command.name} `);
    this.commandsOpen.set(false);
    this.composerInput().nativeElement.focus();
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
}
