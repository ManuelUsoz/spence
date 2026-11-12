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
import { HlmTooltipImports } from '@ui/tooltip';
import { toast } from '@ui/toast';
import { Cause, Effect, Exit, Option, Schedule, Stream } from 'effect';
import type {
  MessagePart,
  SessionId,
  SessionStreamItem,
  TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { emptyThread, foldThread, textRuns, type Thread } from './thread';
import { ImageStrip } from './image-strip';
import { admitImages, imageParts, readCandidate, type Attached, type Refusal } from './images';

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

const sendPrompt = Effect.fnUntraced(function* (
  sessionId: SessionId,
  parts: ReadonlyArray<MessagePart>,
) {
  const api = yield* DesktopApi;
  return yield* api['Session.prompt']({ sessionId, parts });
});

const cancelTurn = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.cancel']({ sessionId });
});

/** The body of a toast for one refused Image. */
const refusalToast = (refusal: Refusal, agentName: string): string => {
  switch (refusal.kind) {
    case 'notImage':
      return $localize`Only images can be attached`;
    case 'cantTake':
      return $localize`${agentName} can't take images`;
    case 'tooLarge':
    case 'tooWide':
      return $localize`${refusal.name} is too large`;
    case 'tooMany':
      return $localize`A Message can hold up to ${refusal.maxPerMessage} images`;
  }
};

/**
 * One Session: its thread (user and Agent Messages, with Images) and the Composer. Enter sends, Shift+Enter starts a
 * new line; Send waits while a Turn runs, and Stop asks the Agent to end it.
 */
@Component({
  selector: 'app-session-view',
  imports: [HlmButtonImports, HlmTextareaImports, HlmTooltipImports, ImageStrip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex flex-col',
    '[class.ring-2]': 'dragging()',
    '[class.ring-primary]': 'dragging()',
    '[class.rounded-lg]': 'dragging()',
    '(dragenter)': 'onDragEnter($event)',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave()',
    '(drop)': 'onDrop($event)',
  },
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
            @if (message.images.length > 0) {
              <app-image-strip
                class="mb-2"
                [images]="message.images"
                data-testid="message-images"
              />
            }
            {{ message.text }}
          </div>
        } @else {
          <div class="text-sm leading-relaxed whitespace-pre-wrap" data-testid="message-agent">
            @if (message.images.length > 0) {
              <app-image-strip
                class="mb-2"
                [images]="message.images"
                data-testid="message-images"
              />
            }
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

    @if (following() !== 'failed') {
      <form
        class="bg-background sticky bottom-0 flex flex-col gap-2 pb-2"
        data-testid="composer"
        (submit)="$event.preventDefault(); send()"
      >
        @if (images().length > 0) {
          <app-image-strip
            [images]="images()"
            [removable]="true"
            [class.ring-2]="imagesBlocked()"
            [class.ring-destructive]="imagesBlocked()"
            [class.rounded-md]="imagesBlocked()"
            (remove)="removeImage($event)"
            data-testid="composer-images"
          />
        }
        @if (imagesBlocked()) {
          <p class="text-destructive text-xs" data-testid="images-blocked" i18n>
            {{ agentName() }} can't take images. Remove them to send.
          </p>
        }
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
          (paste)="onPaste($event)"
        ></textarea>
        <div class="flex justify-end gap-2">
          <span [hlmTooltip]="attachTooltip() ?? ''" [tooltipDisabled]="attachTooltip() === null">
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="icon"
              data-testid="attach"
              [disabled]="attachDisabled()"
              (click)="fileInput.click()"
              aria-label="Attach image"
              i18n-aria-label
            >
              <svg
                aria-hidden="true"
                class="size-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                />
              </svg>
            </button>
          </span>
          <input
            #fileInput
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            class="sr-only"
            data-testid="attach-input"
            (change)="onAttachChange($event)"
          />
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

  protected readonly thread = signal<Thread>(emptyThread);
  /** Whether the Session's events arrive: before the first one, while they do, or never (the Session is gone). */
  protected readonly following = signal<'loading' | 'following' | 'failed'>('loading');
  protected readonly draft = signal('');
  protected readonly images = signal<ReadonlyArray<Attached>>([]);
  protected readonly dragging = signal(false);
  /** A prompt was sent and its Turn has not shown up yet. */
  private readonly sending = signal(false);
  private dragCount = 0;
  private sentTurn: Thread['messages'][number]['turnId'] | null = null;

  protected readonly running = computed(() => this.thread().running !== null);
  protected readonly agentName = computed(() => this.thread().live?.agentName ?? 'Agent');
  protected readonly attachDisabled = computed(() => {
    const live = this.thread().live;
    return live !== null && live.agentStatus === 'ready' && !live.canAttachImages;
  });
  protected readonly attachTooltip = computed(() =>
    this.attachDisabled() ? $localize`${this.agentName()} can't take images` : null,
  );
  protected readonly imagesBlocked = computed(() => {
    const live = this.thread().live;
    return (
      this.images().length > 0 &&
      live !== null &&
      live.agentStatus === 'ready' &&
      !live.canAttachImages
    );
  });
  protected readonly canSend = computed(() => {
    if (this.running() || this.sending() || this.imagesBlocked()) return false;
    return this.draft().trim() !== '' || this.images().length > 0;
  });

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

  protected onPaste(event: ClipboardEvent): void {
    const files = event.clipboardData?.files;
    if (files === undefined || files.length === 0) return;
    event.preventDefault();
    void this.attachFiles(files);
  }

  protected onAttachChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.attachFiles(input.files);
    input.value = '';
  }

  protected removeImage(index: number): void {
    this.images.update((images) => images.filter((_, i) => i !== index));
  }

  protected onDragEnter(event: DragEvent): void {
    event.preventDefault();
    this.dragCount += 1;
    this.dragging.set(true);
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  protected onDragLeave(): void {
    this.dragCount -= 1;
    if (this.dragCount <= 0) {
      this.dragCount = 0;
      this.dragging.set(false);
    }
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragCount = 0;
    this.dragging.set(false);
    void this.attachFiles(event.dataTransfer?.files ?? null);
  }

  protected async send(): Promise<void> {
    if (!this.canSend()) return;
    const text = this.draft();
    const images = this.images();
    const parts: Array<MessagePart> = [...imageParts(images)];
    const trimmed = text.trim();
    if (trimmed !== '') parts.push({ _tag: 'text', text });
    this.sending.set(true);
    const exit = await this.runtime.run(sendPrompt(this.sessionId(), parts), {
      signal: this.aborts.signal,
    });
    this.sending.set(false);
    if (Exit.isSuccess(exit)) {
      this.sentTurn = exit.value;
      // Cleared only if the user did not change the Composer meanwhile.
      if (this.draft() === text && this.images() === images) {
        this.draft.set('');
        this.images.set([]);
      }
      if (this.thread().outcomes.get(exit.value)?._tag === 'failed') {
        this.restoreFailedTurn(exit.value);
      }
      return;
    }
    if (!this.aborts.signal.aborted) toast.error($localize`Could not send the Message.`);
  }

  protected async stop(): Promise<void> {
    await this.runtime.run(cancelTurn(this.sessionId()), { signal: this.aborts.signal });
  }

  private async attachFiles(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) return;
    const candidates = await Promise.all(Array.from(files, (file) => readCandidate(file)));
    const { accepted, refusals } = admitImages(this.images().length, candidates, this.gate());
    if (accepted.length > 0) {
      this.images.update((images) => [...images, ...accepted]);
    }
    const name = this.agentName();
    for (const refusal of refusals) {
      toast.error(refusalToast(refusal, name));
    }
  }

  private gate() {
    const live = this.thread().live;
    return {
      limits: live?.imageLimits ?? null,
      canAttach: live === null || live.agentStatus !== 'ready' || live.canAttachImages,
    };
  }

  private restoreFailedTurn(turnId: Thread['messages'][number]['turnId']): void {
    if (this.draft() !== '' || this.images().length > 0) return;
    const failedMessage = [...this.thread().messages]
      .reverse()
      .find((message) => message.turnId === turnId && message.role === 'user');
    if (failedMessage === undefined) return;
    this.draft.set(failedMessage.text);
    this.images.set(
      failedMessage.images.map((image) => ({
        name: '',
        mimeType: image.mimeType,
        data: image.data,
      })),
    );
  }

  private async subscribe(): Promise<void> {
    const exit = await this.runtime.run(
      follow(
        this.sessionId(),
        () => this.thread().lastSeq,
        (item) => {
          this.following.set('following');
          this.thread.update((thread) => foldThread(thread, item));
          if (item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded') {
            const outcome = item.event.item.outcome;
            if (outcome._tag === 'failed' && this.sentTurn === item.event.item.turnId) {
              this.restoreFailedTurn(item.event.item.turnId);
            }
          }
        },
      ),
      { signal: this.aborts.signal },
    );
    if (Exit.isFailure(exit) && !this.aborts.signal.aborted) this.following.set('failed');
  }
}
