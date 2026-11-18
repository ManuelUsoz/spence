import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  LOCALE_ID,
  output,
  signal,
  viewChild,
  type OnInit,
} from '@angular/core';
import { AgentTile } from '@ui/agent-tile';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmBadgeImports } from '@ui/badge';
import { HlmCommandImports } from '@ui/command';
import { HlmKbdImports } from '@ui/kbd';
import { HlmButtonImports } from '@ui/button';
import { HlmInputImports } from '@ui/input';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmTextareaImports } from '@ui/textarea';
import { HlmTooltipImports } from '@ui/tooltip';
import { toast } from '@ui/toast';
import { Cause, Effect, Exit, Option, Schedule, Schema, Stream } from 'effect';
import { PermissionMode, type ProjectId } from '../../../shared/projects/projects.rpc';
import { AgentId, type Agent, type Effort } from '../../../shared/agents/agents.rpc';
import {
  STOP_AGENT_INTERRUPTED_DETAIL,
  type ActionOwner,
  type Command,
  type ComposerDraft,
  type ForkLineage,
  type ForkTarget,
  type HandoffAttempt,
  type HandoffKind,
  type ImagePart,
  type MessagePart,
  type MessageId,
  type PermissionRequestId,
  type QueuedMessage,
  type SessionId,
  type SessionStreamItem,
  type TurnId,
  type WorkerInfo,
} from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { DeviceScope } from '../../core/device-scope';
import { EffectRuntime } from '../../core/effect-runtime';
import { isTextInputTarget, Keymap } from '../../core/keymap';
import {
  SessionToolbar,
  type SessionOperation,
  type WorkerCrumb,
} from '../../core/session-toolbar';
import { RemoteDevices } from '../../core/remote-devices';
import { Tabs } from '../../core/tabs';
import { AgentBar } from './agent-bar';
import { HandoffDialog } from './handoff-dialog';
import { MemoryLostBar } from './memory-lost-bar';
import { ComposerCarets } from './composer-carets';
import { Dock } from './dock';
import { MessageImages } from './message-images';
import { MarkdownView } from './markdown-view';
import { Receipt } from './receipt';
import { Ticker } from './ticker';
import { WorkersPanel } from './workers-panel';
import { ThreadAsideComponent } from './thread-aside';
import {
  emptyThread,
  foldThread,
  runningWork,
  threadRows,
  turnWork,
  type Thread,
  type ThreadDivider,
  type ThreadMessage,
  type ThreadRow,
} from './thread';

import { ComposerStatus } from './composer-status';
import { ContextRing } from './context-ring';
import { ImageStrip } from './image-strip';
import { admitImages, imageParts, readCandidate, type Attached, type Refusal } from './images';
import { contextSummary, sessionActions } from './session-actions';

/** How long to wait before following a stream that dropped (e.g. the port closed) again. */
const RESUBSCRIBE_AFTER = '500 millis';

/** How often the Ticker elapsed time updates while a Turn runs. */
const TICKER_INTERVAL_MS = 1000;

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

const steerTurn = Effect.fnUntraced(function* (
  sessionId: SessionId,
  parts: ReadonlyArray<MessagePart>,
) {
  const api = yield* DesktopApi;
  yield* api['Session.steer']({ sessionId, parts });
});

const enqueueMessage = Effect.fnUntraced(function* (
  sessionId: SessionId,
  parts: ReadonlyArray<MessagePart>,
) {
  const api = yield* DesktopApi;
  yield* api['Session.enqueue']({ sessionId, parts });
});

const replaceQueue = Effect.fnUntraced(function* (
  sessionId: SessionId,
  queue: ReadonlyArray<QueuedMessage>,
) {
  const api = yield* DesktopApi;
  yield* api['Session.setQueue']({ sessionId, queue });
});

const clearSessionQueue = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.clearQueue']({ sessionId });
});

const cancelTurn = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.cancel']({ sessionId });
});

const stopAgent = Effect.fnUntraced(function* (sessionId: SessionId, force?: boolean) {
  const api = yield* DesktopApi;
  return yield* api['Session.stopAgent']({
    sessionId,
    ...(force === undefined ? {} : { force }),
  });
});

const retryAgent = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.retryAgent']({ sessionId });
});

const loginAgent = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.loginAgent']({ sessionId });
});

const openAgentLog = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.openAgentLog']({ sessionId });
});

const checkProject = Effect.fnUntraced(function* (id: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Projects.check']({ id });
});

const locateProject = Effect.fnUntraced(function* (id: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Projects.locate']({ id });
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

const compactSession = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.compact']({ sessionId });
});

const startEmptyContext = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.startEmptyContext']({ sessionId });
});

const getComposer = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Session.getComposer']({ sessionId });
});

const setComposer = Effect.fnUntraced(function* (sessionId: SessionId, draft: ComposerDraft) {
  const api = yield* DesktopApi;
  yield* api['Session.setComposer']({ sessionId, draft });
});

const openExternal = Effect.fnUntraced(function* (url: string) {
  const api = yield* DesktopApi;
  yield* api['Links.openExternal']({ url });
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

const listAgents = Effect.fnUntraced(function* () {
  const api = yield* DesktopApi;
  return yield* api['Agents.list']();
});

const setSessionAgent = Effect.fnUntraced(function* (sessionId: SessionId, agentId: AgentId) {
  const api = yield* DesktopApi;
  yield* api['Session.setAgent']({ sessionId, agentId });
});

const isPermissionMode = Schema.is(PermissionMode);
const isAgentId = Schema.is(AgentId);

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
 * One Session: its thread (user and Agent Messages, with Images) and the Composer. Enter sends, Shift+Enter starts a
 * new line; Send waits while a Turn runs, and Stop asks the Agent to end it.
 */
function greetingFor(hour: number): string {
  if (hour < 5) return $localize`Good night`;
  if (hour < 12) return $localize`Good morning`;
  if (hour < 18) return $localize`Good afternoon`;
  return $localize`Good evening`;
}

@Component({
  selector: 'app-session-view',
  imports: [
    ComposerStatus,
    HlmAlertDialogImports,
    HlmBadgeImports,
    HlmButtonImports,
    HlmCommandImports,
    HlmInputImports,
    AgentTile,
    HlmDropdownMenuImports,
    HlmTextareaImports,
    HlmTooltipImports,
    ContextRing,
    ImageStrip,
    MessageImages,
    MarkdownView,
    HlmKbdImports,
    AgentBar,
    HandoffDialog,
    MemoryLostBar,
    Dock,
    Ticker,
    Receipt,
    ThreadAsideComponent,
    WorkersPanel,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'mx-auto flex w-full max-w-[760px] flex-col transition-[min-height] duration-500 ease-out motion-reduce:transition-none',
    '[style.min-height]': "fresh() ? 'min(60vh, 560px)' : '0px'",
    '[class.justify-center]': 'fresh()',
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
      @for (row of rows(); track rowIndex($index, row)) {
        @switch (row.type) {
          @case ('message') {
            @for (
              divider of dividersAt(thread().messages.indexOf(row.message));
              track divider.beforeIndex
            ) {
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

            @if (row.message.from; as sender) {
              <div
                class="border-border text-muted-foreground max-w-[82%] self-end rounded-xl border px-3.5 py-2.5 text-[13.5px] whitespace-pre-wrap"
                data-testid="message-from"
                [attr.data-turn-id]="row.message.turnId"
              >
                <div class="mb-1 text-[11px]">
                  @if (sender.projectName; as projectName) {
                    <span i18n>From {{ sender.title }} in {{ projectName }}</span>
                  } @else {
                    <span i18n>From {{ sender.title }}</span>
                  }
                  @if (sender.needsUser) {
                    <span
                      class="bg-accent text-accent-foreground ml-1.5 rounded-full px-2 py-0.5"
                      i18n
                    >
                      needs your answer
                    </span>
                  }
                </div>
                <div class="text-foreground">{{ row.message.text }}</div>
              </div>
            } @else if (row.message.role === 'user') {
              <div
                class="bg-muted max-w-[82%] self-end rounded-[18px_18px_6px_18px] px-3.5 py-2.5 text-[13.5px] whitespace-pre-wrap"
                data-testid="message-user"
                [attr.data-turn-id]="row.message.turnId"
              >
                @if (row.message.steer) {
                  <span
                    class="bg-accent text-accent-foreground mb-1 inline-block rounded-full px-2 py-0.5 text-[11px]"
                    data-testid="steered-badge"
                    i18n
                  >
                    steered
                  </span>
                }
                @if (row.message.images.length > 0) {
                  <app-message-images
                    class="mb-2"
                    [images]="row.message.images"
                    data-testid="message-images"
                  />
                }
                {{ row.message.text }}
              </div>
            } @else {
              <div class="text-sm leading-relaxed" data-testid="message-agent">
                @if (row.message.images.length > 0) {
                  <app-message-images
                    class="mb-2"
                    [images]="row.message.images"
                    data-testid="message-images"
                  />
                }
                <app-markdown-view
                  [text]="row.message.text"
                  [settled]="settled(row.message)"
                  (openLink)="onOpenLink($event)"
                />
              </div>
            }
          }
          @case ('ticker') {
            @if (!pendingPermission() && workForTurn(row.turnId); as work) {
              <app-ticker [work]="work" [now]="now()" />
            }
          }
          @case ('aside') {
            <app-thread-aside
              [item]="row.aside"
              [forkLineage]="forkLineage()"
              (openSource)="onOpenForkSource($event)"
            />
          }
          @case ('outcome') {
            @switch (row.outcome._tag) {
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
                <div
                  class="text-destructive bg-destructive/10 text-sm whitespace-pre-wrap rounded-md px-3 py-2"
                  data-testid="outcome"
                >
                  @if (row.outcome.reason === 'agentStopped') {
                    <span i18n>{{ agentName() }} stopped unexpectedly</span>
                    <details>
                      <summary i18n>Details</summary>
                      <pre class="font-mono text-xs">{{ row.outcome.detail }}</pre>
                      <button
                        hlmBtn
                        type="button"
                        variant="ghost"
                        size="sm"
                        (click)="onOpenAgentLog()"
                        i18n
                      >
                        Open log
                      </button>
                    </details>
                  } @else if (row.outcome.reason === 'interrupted') {
                    @if (row.outcome.detail === stopAgentInterruptedDetail) {
                      <span i18n>{{ agentName() }} was stopped.</span>
                    } @else {
                      <span i18n>Spence closed while the Turn was running</span>
                    }
                  } @else {
                    {{ row.outcome.detail }}
                  }
                </div>
              }
            }
          }
          @case ('receipt') {
            @if (workForTurn(row.turnId); as work) {
              <app-receipt [work]="work" [permissions]="thread().permissions" />
            }
          }
          @case ('workers') {
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-fit items-center gap-2.5 rounded-md text-[13px] outline-none focus-visible:ring-2"
              data-testid="workers-line"
              aria-haspopup="menu"
              [hlmDropdownMenuTrigger]="workersMenu"
              [hlmDropdownMenuTriggerData]="{ workers: row.workers }"
              align="start"
            >
              <svg
                aria-hidden="true"
                class="size-[13px] shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M12 8V4H8" />
                <rect width="16" height="12" x="4" y="8" rx="2" />
                <path d="M2 14h2" />
                <path d="M20 14h2" />
                <path d="M15 13v2" />
                <path d="M9 13v2" />
              </svg>
              <span i18n
                >Started {{ row.workers.length }}
                {row.workers.length, plural, =1 {worker} other {workers}} ·
                {{ finishedCount(row.workers) }} finished</span
              >
            </button>
          }
          @case ('fork') {
            <div class="text-muted-foreground flex items-center gap-2 text-xs">
              <button
                type="button"
                class="hover:text-foreground hover:underline"
                data-testid="fork-target-link"
                [attr.data-fork-id]="row.fork.forkSessionId"
                (click)="onOpenForkTarget(row.fork)"
                i18n
              >
                Forked to {{ row.fork.forkTitle }}
              </button>
            </div>
          }
        }
      }
      @if (canFork()) {
        <div
          class="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 hover:opacity-100"
          role="toolbar"
          aria-label="Turn actions"
          i18n-aria-label
          data-testid="turn-actions"
        >
          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="sm"
            class="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
            data-testid="turn-fork"
            (click)="openHandoff('fork')"
          >
            <svg
              class="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <circle cx="18" cy="6" r="3" />
              <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9M12 12v3" />
            </svg>
            <span i18n>Fork</span>
          </button>
        </div>
      }
      @if (queue().length > 0) {
        <div class="flex flex-col gap-2" data-testid="queue">
          @for (item of queue(); track item.id; let i = $index) {
            <div
              class="border-border flex max-w-[80%] flex-col items-end gap-1 self-end rounded-lg border border-dashed px-2 py-1 text-sm opacity-80"
              data-testid="queued-message"
              [attr.data-queue-id]="item.id"
            >
              <div class="flex flex-wrap items-center justify-end gap-1">
                <span
                  class="bg-muted-foreground/15 rounded-full px-2 py-0.5 text-[11px]"
                  data-testid="queued-badge"
                  i18n
                >
                  queued {{ i + 1 }}
                </span>
                <button
                  hlmBtn
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="queue-up"
                  [disabled]="i === 0"
                  (click)="moveQueued(item.id, -1)"
                  aria-label="Move up"
                  i18n-aria-label
                >
                  ↑
                </button>
                <button
                  hlmBtn
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="queue-down"
                  [disabled]="i === queue().length - 1"
                  (click)="moveQueued(item.id, 1)"
                  aria-label="Move down"
                  i18n-aria-label
                >
                  ↓
                </button>
                @if (editingQueued() === item.id) {
                  <input
                    hlmInput
                    data-testid="queue-edit-input"
                    class="h-8 w-64"
                    [value]="queuedText(item)"
                    (keydown.enter)="commitQueuedEdit(item, $any($event.target).value)"
                    (blur)="commitQueuedEdit(item, $any($event.target).value)"
                  />
                } @else {
                  <span class="whitespace-pre-wrap">{{ queuedText(item) }}</span>
                  <button
                    hlmBtn
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid="queue-edit"
                    (click)="editingQueued.set(item.id)"
                    aria-label="Edit"
                    i18n-aria-label
                  >
                    ✎
                  </button>
                }
                <button
                  hlmBtn
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="queue-remove"
                  (click)="removeQueued(item.id)"
                  aria-label="Remove"
                  i18n-aria-label
                >
                  ×
                </button>
              </div>
              @if (queuedImages(item).length > 0) {
                <app-image-strip [images]="queuedImages(item)" />
              }
            </div>
          }
          <div class="flex justify-end">
            <button
              hlmBtn
              type="button"
              variant="ghost"
              size="sm"
              data-testid="clear-queue"
              (click)="clearQueued()"
              i18n
            >
              Clear queue
            </button>
          </div>
        </div>
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

    @if (running() && pendingPermission(); as pending) {
      <div class="flex items-center gap-2 pb-2 text-sm text-muted-foreground" data-testid="ticker">
        <span class="size-2 rounded-full bg-[var(--attention)]"></span>
        <span i18n>Waiting for you below</span>
      </div>
      <div
        class="border-border bg-card mb-2 flex flex-col gap-2 rounded-2xl border p-3 shadow-sm"
        data-testid="dock"
      >
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
                <kbd hlmKbd class="ml-1 font-mono font-normal">{{ i + 1 }}</kbd>
              }
            </button>
          }
        </div>
      </div>
    }

    @if (following() !== 'failed') {
      <div
        class="grid transition-[grid-template-rows,opacity] duration-500 ease-out motion-reduce:transition-none"
        [class]="fresh() ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'"
        [attr.inert]="fresh() ? null : ''"
        data-testid="greeting"
      >
        <div class="min-h-0 overflow-hidden">
          <div class="flex flex-col gap-1 px-1.5 pb-8">
            <h2 class="text-3xl leading-tight font-medium tracking-tight">{{ greeting() }}</h2>
            <p class="text-muted-foreground text-base" data-testid="greeting-project">
              @if (projectName(); as name) {
                <ng-container i18n>What are we doing in {{ name }}?</ng-container>
              } @else {
                <ng-container i18n>What are we doing?</ng-container>
              }
            </p>
          </div>
        </div>
      </div>
      <div class="bg-background sticky bottom-0 flex flex-col gap-2 pb-2">
        @if (awayFromBottom()) {
          <button
            hlmBtn
            type="button"
            variant="outline"
            size="icon"
            class="bg-card absolute -top-12 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-sm"
            data-testid="scroll-to-bottom"
            aria-label="Scroll to the latest message"
            i18n-aria-label
            (click)="scrollToBottom()"
          >
            <svg
              aria-hidden="true"
              class="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
          </button>
        }
        @if (dragging()) {
          <div
            class="border-primary bg-background/90 text-muted-foreground pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-md border-2 border-dashed text-sm"
            data-testid="drop-target"
            i18n
          >
            Drop images to attach
          </div>
        }
        @if (memoryLost()) {
          <app-memory-lost-bar
            [resolving]="resolvingMemoryLost()"
            [canPrepareHandoff]="!running() && !compacting() && !clearing()"
            (prepareSummaryHandoff)="openHandoff('memoryLost')"
            (startEmptyContext)="onStartEmptyContext()"
          />
        }
        <app-agent-bar
          [live]="live()"
          [folderMissing]="folderMissing()"
          [loggingIn]="loggingIn()"
          (retry)="onRetryAgent()"
          (openLog)="onOpenAgentLog()"
          (login)="onLoginAgent()"
          (cancelLogin)="onCancelLogin()"
          (installed)="onRetryAgent()"
          (locate)="onLocateProject()"
        />
        <app-dock [plan]="runningPlan()" />
        <form
          class="bg-tray group/composer flex flex-col rounded-[22px]"
          data-testid="composer"
          (submit)="$event.preventDefault(); send()"
          (dragenter)="onDragEnter($event)"
          (dragover)="onDragOver($event)"
          (dragleave)="onDragLeave()"
          (drop)="onDrop($event)"
        >
          <div
            class="bg-card border-border flex flex-col gap-2 rounded-[20px] border p-3 shadow-sm"
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
            @if (modelsLimitation(); as limitation) {
              <p class="text-muted-foreground text-xs" data-testid="models-limitation">
                {{ limitation }}
              </p>
            }
            <div class="relative">
              <textarea
                #composerInput
                hlmTextarea
                class="max-h-48 rounded-none border-0 bg-transparent px-1 py-0.5 text-[14.5px] shadow-none focus-visible:ring-0 dark:bg-transparent"
                data-testid="composer-input"
                [placeholder]="composerPlaceholder()"
                aria-label="Message"
                i18n-aria-label
                [value]="draft()"
                (input)="onInput(composerInput.value)"
                (keydown)="onKeydown($event)"
                (paste)="onPaste($event)"
              ></textarea>

              @if (commandsOpen()) {
                <div
                  class="bg-popover text-popover-foreground border-border absolute z-10 mt-1 w-full overflow-hidden rounded-md border shadow-md"
                  data-testid="commands-list"
                >
                  <div
                    hlmCommand
                    [search]="''"
                    role="listbox"
                    aria-label="Commands"
                    i18n-aria-label
                  >
                    <div hlmCommandList class="max-h-80">
                      @for (group of commandGroups(); track group.key) {
                        <div hlmCommandGroup>
                          <div hlmCommandGroupLabel>{{ group.label }}</div>
                          @for (item of group.entries; track item.command.id) {
                            <button
                              type="button"
                              hlmCommandItem
                              role="option"
                              class="flex-col items-stretch gap-0.5 text-left"
                              [value]="item.command.id"
                              [class.bg-accent]="item.index === selectedCommand()"
                              [class.text-accent-foreground]="item.index === selectedCommand()"
                              [attr.aria-selected]="item.index === selectedCommand()"
                              [attr.data-testid]="'command-' + item.command.id"
                              (mouseenter)="selectedCommand.set(item.index)"
                              (click)="pickCommand(item.command)"
                            >
                              <span class="flex w-full items-start justify-between gap-2">
                                <span class="font-mono text-sm">{{ item.command.invocation }}</span>
                                <span hlmBadge variant="outline" class="text-[10px]">
                                  {{ kindLabel(item.command.kind) }}
                                </span>
                              </span>
                              @if (item.command.description; as description) {
                                <span class="text-muted-foreground w-full text-left text-xs">{{
                                  description
                                }}</span>
                              }
                              <span
                                class="text-muted-foreground flex w-full flex-wrap items-center gap-2 text-xs"
                              >
                                <span>{{ item.command.owner.name }}</span>
                                @if (item.command.hint; as hint) {
                                  <span>
                                    {{ hintLabel }}
                                    <span class="font-mono text-xs">{{ hint }}</span>
                                  </span>
                                }
                              </span>
                            </button>
                          }
                        </div>
                      } @empty {
                        @if (commandFilter() !== '') {
                          <p hlmCommandEmpty i18n>No commands match.</p>
                        }
                      }
                    </div>
                    @if (commandStatus(); as status) {
                      <p
                        class="text-muted-foreground border-border border-t px-3 py-2 text-xs"
                        data-testid="commands-status"
                      >
                        {{ status }}
                      </p>
                    }
                  </div>
                </div>
              }
            </div>
            @if (workerHint(); as hint) {
              <p class="text-muted-foreground ps-1 text-xs" data-testid="worker-hint">{{ hint }}</p>
            }
            <div class="flex flex-wrap items-center gap-1.5">
              <span
                [hlmTooltip]="attachTooltip() ?? ''"
                [tooltipDisabled]="attachTooltip() === null"
              >
                <button
                  hlmBtn
                  type="button"
                  variant="outline"
                  size="icon"
                  class="rounded-full"
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
              <div [class]="pickersClass()" data-testid="composer-pickers">
                <button
                  type="button"
                  data-testid="permission-mode"
                  class="hover:bg-accent focus-visible:ring-ring border-input flex h-8 items-center gap-1.5 rounded-full border ps-2.5 pe-3 text-xs outline-none focus-visible:ring-2"
                  aria-haspopup="menu"
                  [attr.aria-label]="permissionLabel()"
                  [hlmTooltip]="permissionModeTip"
                  side="top"
                  align="start"
                  [hlmDropdownMenuTrigger]="modeMenu"
                >
                  <svg
                    class="size-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path
                      d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"
                    />
                  </svg>
                  @if (permissionMode() === 'ask') {
                    <span i18n>Ask</span>
                  } @else {
                    <span i18n>Auto</span>
                  }
                </button>
              </div>
              <div [class]="pickersClass()" data-testid="composer-pickers">
                <button
                  type="button"
                  data-testid="model-picker"
                  class="hover:bg-accent focus-visible:ring-ring border-input flex h-8 items-center gap-2 rounded-full border ps-1 pe-2.5 text-xs outline-none focus-visible:ring-2"
                  aria-haspopup="dialog"
                  [attr.aria-label]="pickerLabel()"
                  [hlmTooltip]="modelTip"
                  side="top"
                  align="start"
                  [hlmDropdownMenuTrigger]="agentMenu"
                >
                  <app-agent-tile [agentId]="activeAgentId()" [name]="agentName()" size="sm" />
                  @if (modelsSupported() && model()) {
                    <span>{{ modelName() }}</span>
                  } @else {
                    <span>{{ agentName() }}</span>
                  }
                  @if (effortSupported() && effort(); as effortOption) {
                    <span class="text-muted-foreground" data-testid="effort-current">{{
                      effortLabel(effortOption.value)
                    }}</span>
                  }
                  <svg
                    class="text-muted-foreground size-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                @if (controlsLoading()) {
                  <span class="text-muted-foreground text-xs" data-testid="controls-loading" i18n>
                    Starting the Agent…
                  </span>
                }
              </div>
              <div class="flex-1"></div>
              <div class="contents">
                <app-context-ring [usage]="contextUsage()" [agentName]="agentName()" />
                @if (running() || compacting()) {
                  @if (stopAgentReady()) {
                    <button
                      hlmBtn
                      type="button"
                      variant="destructive"
                      data-testid="stop-agent"
                      [disabled]="stoppingAgent()"
                      (click)="onStopAgentClick()"
                      i18n
                    >
                      Stop Agent
                    </button>
                  } @else if (stopAgentWaiting()) {
                    <button
                      hlmBtn
                      type="button"
                      variant="outline"
                      data-testid="stop-waiting"
                      disabled
                      i18n
                    >
                      Stopping…
                    </button>
                  } @else {
                    <button
                      hlmBtn
                      type="button"
                      variant="outline"
                      data-testid="stop"
                      [hlmTooltip]="stopTip"
                      (click)="stop()"
                      i18n
                    >
                      Stop
                    </button>
                  }
                }
                @if (running()) {
                  <button
                    hlmBtn
                    type="button"
                    variant="outline"
                    data-testid="queue-send"
                    [disabled]="!composerReady()"
                    (click)="queueDraft()"
                  >
                    <span i18n>Queue</span>
                    <kbd hlmKbd class="ms-1 font-mono font-normal">{{
                      keymap.format({ mod: true, key: 'Enter' })
                    }}</kbd>
                  </button>
                  @if (steeringSupported()) {
                    <button
                      hlmBtn
                      type="button"
                      variant="outline"
                      data-testid="steer-send"
                      [disabled]="!composerReady()"
                      (click)="steerDraft()"
                    >
                      <span i18n>Steer</span>
                      <kbd hlmKbd class="ms-1 font-mono font-normal">{{
                        keymap.format({ mod: true, shift: true, key: 'Enter' })
                      }}</kbd>
                    </button>
                  }
                }
                <button
                  hlmBtn
                  type="submit"
                  size="icon"
                  class="rounded-full"
                  data-testid="send"
                  aria-label="Send"
                  i18n-aria-label
                  [disabled]="!canSend()"
                >
                  <svg
                    aria-hidden="true"
                    class="size-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
          <app-composer-status [sessionId]="sessionId()" [running]="running()" />
        </form>
        @if (visibleWorkers().length > 0) {
          <div
            class="text-muted-foreground flex h-9 items-center gap-1 ps-3.5 pe-2 text-xs"
            data-testid="composer-strip"
          >
            <span class="flex-1"></span>
            <button
              type="button"
              class="hover:bg-accent flex h-[26px] items-center gap-1.5 rounded-lg px-2 text-xs"
              data-testid="workers-toggle"
              [attr.aria-expanded]="workersOpen()"
              [attr.aria-label]="workersLabel()"
              (click)="workersOpen.set(!workersOpen())"
            >
              @if (activeWorkerCount() > 0 && !workersNeedYou()) {
                <span
                  class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                  aria-hidden="true"
                ></span>
              } @else {
                <svg
                  aria-hidden="true"
                  class="size-[13px]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 8V4H8" />
                  <rect width="16" height="12" x="4" y="8" rx="2" />
                  <path d="M2 14h2" />
                  <path d="M20 14h2" />
                  <path d="M15 13v2" />
                  <path d="M9 13v2" />
                </svg>
              }
              <span class="tabular-nums" i18n>{activeWorkerCount(), plural,
                =0 {Reconnecting}
                =1 {1 agent}
                other {{{ activeWorkerCount() }} agents}
              }</span>
              @if (workersNeedYou()) {
                <span
                  aria-hidden="true"
                  class="size-1.5 shrink-0 rounded-full bg-[var(--attention)]"
                ></span>
              }
            </button>
          </div>
        }
      </div>
    }

    <ng-template #permissionModeTip>
      <span class="inline-flex items-center gap-1.5">
        @if (askSupported()) {
          <span i18n>Toggle Permission mode</span>
          <kbd hlmKbd class="font-mono font-normal">{{
            keymap.format({ mod: true, shift: true, key: 'a' })
          }}</kbd>
        } @else {
          <span i18n>{{ agentName() }} doesn't support Ask mode; Auto is required.</span>
        }
      </span>
    </ng-template>

    <ng-template #workersMenu let-workers="workers">
      <hlm-dropdown-menu class="w-72 rounded-xl" data-testid="workers-line-menu">
        @for (worker of workers; track worker.sessionId) {
          <button
            type="button"
            hlmDropdownMenuItem
            class="h-auto items-start justify-start gap-2.5 py-2 text-start"
            data-testid="workers-line-item"
            (triggered)="openSession(worker.sessionId, worker.title)"
          >
            <app-agent-tile
              [agentId]="worker.agentId ?? ''"
              [name]="worker.agentName ?? worker.title"
              size="sm"
            />
            <span class="flex min-w-0 flex-1 flex-col items-start text-start">
              <span class="truncate font-medium">{{ worker.title }}</span>
              @if (worker.modelName ?? worker.agentName; as model) {
                <span class="text-muted-foreground truncate text-xs">{{ model }}</span>
              }
            </span>
            <span class="text-muted-foreground shrink-0 text-xs">
              @switch (worker.state) {
                @case ('idle') {
                  <ng-container i18n>Done</ng-container>
                }
                @case ('unknown') {
                  <ng-container i18n>Reconnecting</ng-container>
                }
                @default {
                  <ng-container i18n>Running</ng-container>
                }
              }
            </span>
          </button>
        }
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #modeMenu>
      <hlm-dropdown-menu class="w-44 rounded-xl" data-testid="permission-mode-menu">
        <button
          type="button"
          hlmDropdownMenuRadio
          [keepOpen]="false"
          [checked]="permissionMode() === 'ask'"
          [disabled]="!askSupported()"
          data-testid="permission-mode-ask"
          (triggered)="onModeChange('ask')"
        >
          <ng-container i18n>Ask</ng-container>
          <hlm-dropdown-menu-radio-indicator />
        </button>
        <button
          type="button"
          hlmDropdownMenuRadio
          [keepOpen]="false"
          [checked]="permissionMode() === 'auto'"
          data-testid="permission-mode-auto"
          (triggered)="onModeChange('auto')"
        >
          <ng-container i18n>Auto</ng-container>
          <hlm-dropdown-menu-radio-indicator />
        </button>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #agentMenu>
      <hlm-dropdown-menu
        class="w-[30rem] max-w-[calc(100vw-2rem)] rounded-2xl p-0"
        data-testid="agent-menu"
      >
        <div class="flex max-h-72 min-h-56">
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label="Agents"
            i18n-aria-label
            class="bg-sidebar border-border/60 flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-e p-1.5"
          >
            @for (agent of menuAgents(); track agent.id) {
              <button
                type="button"
                role="tab"
                class="hover:bg-accent focus-visible:ring-ring flex h-10 items-center gap-2.5 rounded-lg px-2 text-start text-sm outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
                [class.bg-accent]="agent.id === activeAgentId()"
                [attr.aria-selected]="agent.id === activeAgentId()"
                [disabled]="agent.id !== activeAgentId() && !canSwitchAgent()"
                [attr.data-testid]="'agent-option-' + agent.id"
                (click)="setAgent(agent.id)"
              >
                <app-agent-tile [agentId]="agent.id" [name]="agent.name" />
                <span class="truncate" [class.font-medium]="agent.id === activeAgentId()">{{
                  agent.name
                }}</span>
              </button>
            }
          </div>
          <div
            role="tabpanel"
            class="flex min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5"
            [attr.aria-label]="agentName()"
          >
            @if (!modelsSupported()) {
              <span
                class="text-muted-foreground px-2 py-1 text-xs"
                data-testid="models-unavailable"
                i18n
              >
                Model selection isn't available for {{ agentName() }}
              </span>
            } @else if (model(); as modelOption) {
              @for (choice of modelOption.choices; track choice.id) {
                <button
                  type="button"
                  role="menuitemradio"
                  class="hover:bg-accent focus-visible:ring-ring flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-start text-sm outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
                  [class.bg-accent]="choice.id === modelOption.value"
                  [attr.aria-checked]="choice.id === modelOption.value"
                  [attr.data-checked]="choice.id === modelOption.value ? '' : null"
                  [disabled]="controlsDisabled()"
                  [attr.data-testid]="'model-option-' + choice.id"
                  (click)="setModel(choice.id)"
                >
                  <span class="flex-1 truncate font-medium">{{ choice.name }}</span>
                  @if (choice.id === modelOption.value) {
                    <svg
                      class="size-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  }
                </button>
              }
            }
            @if (!canSwitchAgent() && menuAgents().length > 1) {
              <p class="text-muted-foreground mt-auto px-2.5 pt-2 text-xs" i18n>
                The Agent is fixed once the first Turn has run.
              </p>
            }
          </div>
        </div>
        <div class="border-border/60 flex items-center gap-3 border-t px-3 py-2.5">
          <span id="effort-label" class="text-muted-foreground text-xs" i18n>Effort</span>
          @if (!effortSupported()) {
            <span class="text-muted-foreground text-xs" data-testid="effort-unavailable" i18n>
              Effort selection isn't available for {{ agentName() }}
            </span>
          } @else if (effort(); as effortOption) {
            <div
              role="radiogroup"
              aria-labelledby="effort-label"
              class="bg-muted grid flex-1 grid-cols-4 gap-0.5 rounded-lg p-0.5"
            >
              @for (level of effortLevels; track level) {
                @let offered = effortOption.choices.includes(level);
                <button
                  type="button"
                  role="radio"
                  class="text-muted-foreground aria-checked:bg-background aria-checked:text-foreground focus-visible:ring-ring h-7 rounded-md text-xs font-medium outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40 aria-checked:shadow-xs"
                  [attr.aria-checked]="level === effortOption.value"
                  [disabled]="controlsDisabled() || !offered"
                  [attr.title]="offered ? null : unavailableLevelTooltip()"
                  [attr.data-testid]="'effort-' + level"
                  (click)="setEffort(level)"
                >
                  {{ effortLabel(level) }}
                </button>
              }
            </div>
          }
        </div>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #modelTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>Model</span>
        <kbd hlmKbd class="font-mono font-normal">{{
          keymap.format({ mod: true, shift: true, key: 'm' })
        }}</kbd>
      </span>
    </ng-template>

    <ng-template #stopTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>Stop</span>
        <kbd hlmKbd class="font-mono font-normal">{{ keymap.format({ key: 'Escape' }) }}</kbd>
      </span>
    </ng-template>

    @if (handoffDialog(); as dialog) {
      <app-handoff-dialog
        [sessionId]="sessionId()"
        [kind]="dialog.kind"
        [targetAgentId]="dialog.targetAgentId"
        [targetModel]="dialog.targetModel"
        [cancelGrace]="live()?.cancelGrace"
        [attempts]="handoffAttempts()"
        (closed)="handoffDialog.set(null)"
        (committed)="onHandoffCommitted($event)"
        (attemptRecorded)="onHandoffAttemptRecorded($event)"
      />
    }

    <hlm-alert-dialog
      [state]="stopAgentConfirm() === null ? 'closed' : 'open'"
      (stateChanged)="onStopAgentConfirmStateChange($event)"
    >
      <hlm-alert-dialog-content
        *hlmAlertDialogPortal="let ctx"
        data-testid="stop-agent-confirm-dialog"
      >
        @if (stopAgentConfirm(); as prompt) {
          <hlm-alert-dialog-header>
            <h2
              hlmAlertDialogTitle
              class="font-display text-xl font-normal"
              data-testid="stop-agent-confirm-title"
              i18n
            >
              Stop {{ prompt.agentName }}?
            </h2>
            <p hlmAlertDialogDescription data-testid="stop-agent-confirm-description">
              {{ stopAgentConfirmDescription() }}
            </p>
          </hlm-alert-dialog-header>
          <hlm-alert-dialog-footer>
            <button
              hlmAlertDialogCancel
              data-testid="stop-agent-confirm-cancel"
              (click)="dismissStopAgentConfirm()"
              i18n
            >
              Cancel
            </button>
            <button
              hlmAlertDialogAction
              variant="destructive"
              data-testid="stop-agent-confirm-action"
              (click)="confirmStopAgent()"
              i18n
            >
              Stop Agent
            </button>
          </hlm-alert-dialog-footer>
        }
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
    @if (workersOpen()) {
      <app-workers-panel
        aria-label="Workers"
        i18n-aria-label
        [workers]="visibleWorkers()"
        (open)="openSession($event.sessionId, $event.title)"
        (closed)="workersOpen.set(false)"
      />
    }
  `,
})
export class SessionView implements OnInit {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  protected readonly keymap = inject(Keymap);
  private readonly carets = inject(ComposerCarets);
  private readonly destroyRef = inject(DestroyRef);
  private readonly runtime = inject(EffectRuntime);
  private readonly deviceScope = inject(DeviceScope, { optional: true });
  private readonly remoteDevices = inject(RemoteDevices);
  private readonly tabs = inject(Tabs);
  private readonly aborts = new AbortController();
  private readonly composerInput = viewChild<ElementRef<HTMLTextAreaElement>>('composerInput');
  private ticker: ReturnType<typeof setInterval> | undefined;
  private initialFocusDone = false;
  private workerPanelDecided = false;
  private caretApplied = false;

  readonly sessionId = input.required<SessionId>();
  readonly projectId = input<ProjectId | null>(null);
  /** The Project's name, for the fresh-Session greeting. */
  readonly projectName = input('');
  readonly messageSent = output<SessionId>();

  protected readonly thread = signal<Thread>(emptyThread);
  /** Whether the Session's events arrive: before the first one, while they do, or never (the Session is gone). */
  protected readonly following = signal<'loading' | 'following' | 'failed'>('loading');
  protected readonly folderMissing = signal(false);
  protected readonly loggingIn = signal(false);
  private loginAborts: AbortController | null = null;
  protected readonly draft = signal('');
  protected readonly images = signal<ReadonlyArray<Attached>>([]);
  private readonly composerLoaded = signal(false);
  private lastSaved: ComposerDraft | null = null;
  protected readonly dragging = signal(false);
  protected readonly now = signal(Date.now());
  /** A prompt was sent and its Turn has not shown up yet. */
  private readonly sending = signal(false);
  protected readonly stopAgentInterruptedDetail = STOP_AGENT_INTERRUPTED_DETAIL;
  /** `Session.clearContext` is running. */
  protected readonly clearing = signal(false);
  /** `Session.startEmptyContext` is running. */
  protected readonly resolvingMemoryLost = signal(false);
  protected readonly handoffDialog = signal<{
    readonly kind: HandoffKind;
    readonly targetAgentId?: AgentId;
    readonly targetModel?: string;
  } | null>(null);
  protected readonly handoffAttempts = signal<ReadonlyArray<HandoffAttempt>>([]);
  protected readonly stoppingAgent = signal(false);
  protected readonly stopAgentConfirm = signal<{
    readonly agentName: string;
    readonly otherWorkingCount: number;
  } | null>(null);
  /** The Session action picker (`Mod+Shift+K`) is open. */
  /** The `/` Commands list is open. */
  protected readonly commandsOpen = signal(false);
  /** Selected index in the filtered Commands list. */
  protected readonly selectedCommand = signal(0);

  protected readonly running = computed(
    () => this.thread().running !== null || this.live()?.runningTurn !== undefined,
  );
  private readonly composerStatus = viewChild(ComposerStatus);
  protected readonly live = computed(() => this.thread().live);
  /** The Worker's own title, for what the Composer says to it. */
  private readonly workerTitle = computed(() => {
    const title = this.live()?.title;
    return title?.user ?? title?.auto ?? $localize`Worker`;
  });
  /** What the Composer of a Worker explains: only a Spence-owned one takes Messages. */
  protected readonly workerHint = computed(() => {
    const live = this.live();
    if (live?.parentSessionId === undefined) return null;
    return live.workerKind === 'owned'
      ? $localize`Only ${this.workerTitle()} sees this. The parent Turn keeps running.`
      : $localize`Messaging this Worker is not supported.`;
  });
  /** The nearest ancestor of this Session waiting for Permission, from the live states the Tabs follow. */
  private readonly waitingAncestorId = computed((): SessionId | null => {
    const seen = new Set<SessionId>();
    let id = this.live()?.parentSessionId;
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const state = this.tabs.liveState(id);
      if (state?.attention === 'needsAnswer') return id;
      id = state?.parentSessionId;
    }
    return null;
  });
  private readonly workerCrumb = computed((): WorkerCrumb | null => {
    const live = this.live();
    if (live?.parentSessionId === undefined) return null;
    const option = live.options.model;
    return {
      parentId: live.parentSessionId,
      agentId: live.agentId ?? '',
      agentName: this.agentName(),
      modelName: option?.choices.find((choice) => choice.id === option.value)?.name ?? null,
      working: this.running(),
      waitingAncestorId: this.waitingAncestorId(),
    };
  });
  /** The Remote device this Session runs on, by name; `null` for a Local Session. */
  protected readonly deviceName = computed((): string | null => {
    const device = this.deviceScope?.device();
    return device === undefined ? null : (this.remoteDevices.nameOf(device) ?? null);
  });
  protected readonly composerPlaceholder = computed(() => {
    const live = this.live();
    const device = this.deviceName();
    if (live?.parentSessionId !== undefined && live.workerKind === 'owned') {
      return $localize`Message ${this.workerTitle()}`;
    }
    // A Remote Session names its Device, so a Message never goes somewhere unexpected.
    return device === null
      ? $localize`Message the Agent`
      : $localize`Message the Agent on ${device}:device:`;
  });
  protected readonly workersOpen = signal(false);
  protected readonly visibleWorkers = computed(() =>
    (this.live()?.workers ?? []).filter((worker) => worker.state !== 'idle'),
  );
  protected readonly workersNeedYou = computed(() =>
    this.visibleWorkers().some((worker) => worker.state === 'requiresAction'),
  );
  protected readonly workersLabel = computed(() =>
    this.activeWorkerCount() === 0
      ? $localize`:@@workers-label-reconnecting:Workers reconnecting`
      : this.workersNeedYou()
        ? $localize`:@@workers-label-needs:${this.activeWorkerCount()} agents, one waiting`
        : $localize`:@@workers-label:${this.activeWorkerCount()} agents`,
  );
  protected readonly activeWorkerCount = computed(
    () =>
      this.visibleWorkers().filter(
        (worker) => worker.state === 'running' || worker.state === 'requiresAction',
      ).length,
  );
  protected readonly availableAgents = signal<ReadonlyArray<Agent>>([]);
  protected readonly changingAgent = signal(false);
  protected readonly isDraft = computed(() => this.live()?.isDraft === true);
  protected readonly showDraftAgentPicker = computed(
    () =>
      this.isDraft() &&
      this.availableAgents().length > 1 &&
      this.availableAgents().some((agent) => agent.id === this.activeAgentId()),
  );
  protected readonly activeAgentId = computed(() => this.live()?.agentId ?? '');
  protected readonly capabilities = computed(() => this.live()?.capabilities ?? null);
  protected readonly supportsCompaction = computed(
    () => this.capabilities()?.supportsCompaction === true,
  );
  protected readonly compacting = computed(
    () =>
      this.live()?.compacting === true ||
      this.thread().asides.some(
        (aside) => aside.item._tag === 'Compaction' && aside.item.status === 'running',
      ),
  );
  protected readonly askSupported = computed(() => this.capabilities()?.askMode !== false);
  protected readonly modelsSupported = computed(() => this.capabilities()?.models !== false);
  protected readonly effortSupported = computed(() => this.capabilities()?.effort !== false);
  protected readonly modelsLimitation = computed(() => {
    const note = this.live()?.modelsLimitation;
    return note !== undefined && note !== '' ? note : null;
  });
  protected readonly agentStatus = computed(() => this.live()?.agentStatus);
  protected readonly cancelGrace = computed(() => this.live()?.cancelGrace);
  protected readonly stopAgentWaiting = computed(
    () => (this.running() || this.compacting()) && this.cancelGrace()?.phase === 'waiting',
  );
  protected readonly stopAgentReady = computed(
    () => (this.running() || this.compacting()) && this.cancelGrace()?.phase === 'ready',
  );
  protected readonly unconfirmedExit = computed(() => this.live()?.unconfirmedExit);
  protected readonly stopAgentConfirmDescription = computed(() => {
    const prompt = this.stopAgentConfirm();
    if (prompt === null) return '';
    return prompt.otherWorkingCount === 1
      ? $localize`Stopping ${prompt.agentName} will also interrupt 1 other working Session.`
      : $localize`Stopping ${prompt.agentName} will also interrupt ${prompt.otherWorkingCount} other working Sessions.`;
  });
  protected readonly controlsLoading = computed(() => this.agentStatus() === 'starting');
  protected readonly controlsDisabled = computed(() => this.agentStatus() !== 'ready');

  protected readonly model = computed(() => this.live()?.options.model);
  protected readonly effort = computed(() => this.live()?.options.effort);
  protected readonly modelName = computed(() => {
    const option = this.model();
    return (
      option?.choices.find((choice) => choice.id === option.value)?.name ?? $localize`Select model…`
    );
  });
  /** The Agents in the picker's sidebar; the current one alone until the catalog has loaded. */
  protected readonly menuAgents = computed((): ReadonlyArray<{ id: string; name: string }> => {
    const all = this.availableAgents();
    return all.length > 0 ? all : [{ id: this.activeAgentId(), name: this.agentName() }];
  });
  protected readonly canSwitchAgent = computed(
    () => this.showDraftAgentPicker() && !this.changingAgent() && !this.running(),
  );
  protected readonly permissionLabel = computed(() =>
    this.permissionMode() === 'ask'
      ? $localize`Permission mode: Ask`
      : $localize`Permission mode: Auto`,
  );
  protected readonly pickerLabel = computed(
    () => $localize`Agent, model and effort: ${this.agentName()}`,
  );

  protected readonly commands = computed<ReadonlyArray<Command>>(() => {
    const owner: ActionOwner = { kind: 'spence', name: $localize`Spence` };
    const spence: Array<Command> = [
      {
        id: 'spence:clear',
        name: 'clear',
        invocation: '/clear',
        owner,
        kind: 'command',
        description: $localize`Start a fresh context window for this Session.`,
      },
    ];
    if (this.supportsCompaction()) {
      spence.push({
        id: 'spence:compact',
        name: 'compact',
        invocation: '/compact',
        owner,
        kind: 'command',
        description: $localize`Summarize earlier messages to free context space.`,
      });
    }
    const reserved = new Set(spence.map((command) => command.name.toLowerCase()));
    const agent = (this.live()?.commands ?? []).filter(
      (command) => !reserved.has(command.name.toLowerCase()),
    );
    return [...spence, ...agent];
  });

  protected readonly agentCommandsAvailable = computed(
    () => (this.live()?.commands ?? []).length > 0,
  );

  protected readonly forkLineage = computed(() => this.live()?.forkLineage);
  protected readonly forks = computed(() => this.live()?.forks ?? []);
  protected readonly rows = computed(() => threadRows(this.thread(), this.forks()));
  /** Fork hangs off the last Turn, so it needs a finished reply and an idle Agent. */
  protected readonly canFork = computed(
    () =>
      this.rows().length >= 2 &&
      !this.running() &&
      !this.compacting() &&
      !this.clearing() &&
      this.agentStatus() !== undefined,
  );
  /** Something was sent, or the thread already has messages: the Session has left its fresh state. */
  private readonly started = computed(
    () => this.rows().length > 0 || this.sending() || this.running(),
  );
  /** A Session with no messages yet: the greeting shows and the Composer sits in the middle. */
  protected readonly fresh = computed(() => this.following() === 'following' && !this.started());
  private scroller: HTMLElement | null = null;
  /** The thread is scrolled well above its end. */
  protected readonly awayFromBottom = signal(false);
  protected readonly greeting = computed(() => greetingFor(new Date().getHours()));
  /**
   * The pickers fade out once the Session has started and come back while the pointer is over the Composer or
   * focus is inside them, so they stay reachable.
   */
  protected readonly pickersClass = computed(() =>
    this.started()
      ? 'flex flex-wrap items-center gap-1.5 opacity-0 transition-opacity duration-500 motion-reduce:transition-none group-hover/composer:opacity-100 focus-within:opacity-100'
      : 'flex flex-wrap items-center gap-1.5 opacity-100 transition-opacity duration-500 motion-reduce:transition-none',
  );
  protected readonly runningPlan = computed(() => runningWork(this.thread())?.plan ?? null);

  protected readonly commandFilter = computed(() => {
    const draft = this.draft();
    return draft.startsWith('/') ? draft.slice(1).trimStart() : '';
  });

  protected readonly filteredCommands = computed(() => {
    const filter = this.commandFilter().toLowerCase();
    if (filter === '') return this.commands();
    return this.commands().filter((command) => {
      const haystack = [command.name, command.invocation, command.description ?? '']
        .join(' ')
        .toLowerCase();
      return haystack.includes(filter);
    });
  });

  /** The filtered entries, grouped by owner (Spence first, then the Agent's own catalog order). */
  protected readonly commandGroups = computed(() => {
    const groups = new Map<
      string,
      {
        readonly key: string;
        readonly label: string;
        readonly entries: Array<{ readonly command: Command; readonly index: number }>;
      }
    >();
    this.filteredCommands().forEach((command, index) => {
      const key = `${command.owner.kind}:${command.owner.name}`;
      const group = groups.get(key) ?? {
        key,
        label: command.owner.name,
        entries: [],
      };
      group.entries.push({ command, index });
      groups.set(key, group);
    });
    return [...groups.values()];
  });

  protected readonly commandStatus = computed(() => {
    if (this.commandFilter() !== '') return null;
    const live = this.live();
    if (live === null || live === undefined) return null;
    if (!live.commandsLoaded) {
      return live.agentStatus === 'starting'
        ? $localize`Loading Agent actions…`
        : $localize`No Agent actions advertised.`;
    }
    return this.agentCommandsAvailable() ? null : $localize`No Agent actions advertised.`;
  });

  private dragCount = 0;
  private sentTurn: Thread['messages'][number]['turnId'] | null = null;

  protected readonly agentName = computed(() => this.thread().live?.agentName ?? $localize`Agent`);
  private readonly toolbar = inject(SessionToolbar);
  private readonly locale = inject(LOCALE_ID);
  private readonly toolbarActions = computed(() =>
    sessionActions({
      running: this.running(),
      compacting: this.compacting(),
      clearing: this.clearing(),
      agentStatus: this.agentStatus(),
      supportsCompaction: this.supportsCompaction(),
      agentName: this.agentName(),
    }),
  );
  private readonly toolbarContext = computed(() =>
    contextSummary(this.contextUsage(), this.locale),
  );
  protected readonly contextUsage = computed(
    () => this.thread().live?.contextUsage ?? { _tag: 'unavailable' as const },
  );
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
  protected readonly memoryLost = computed(() => this.live()?.memoryLost === true);
  protected readonly queue = computed(() => this.live()?.queue ?? []);
  protected readonly steeringSupported = computed(() => this.live()?.steeringSupported === true);
  /** The Composer holds something the Agent can take, and nothing blocks sending it. */
  protected readonly composerReady = computed(() => {
    if (
      this.compacting() ||
      this.sending() ||
      this.stoppingAgent() ||
      this.imagesBlocked() ||
      this.folderMissing() ||
      this.unconfirmedExit() !== undefined ||
      this.memoryLost()
    ) {
      return false;
    }
    const status = this.agentStatus();
    if (status !== 'ready' && status !== 'stopped') return false;
    return this.draft().trim() !== '' || this.images().length > 0;
  });
  protected readonly canSend = computed(
    () =>
      !this.running() &&
      this.composerReady() &&
      !(this.live()?.parentSessionId !== undefined && this.live()?.workerKind !== 'owned'),
  );
  protected readonly editingQueued = signal<MessageId | null>(null);

  protected readonly unavailableLevelTooltip = () => $localize`this Agent doesn't offer it`;
  protected readonly kindCommand = $localize`Command`;
  protected readonly kindSkill = $localize`Skill`;
  protected readonly hintLabel = $localize`Hint`;

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

  protected kindLabel(kind: Command['kind']): string {
    return kind === 'skill' ? this.kindSkill : this.kindCommand;
  }
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
    afterNextRender(() => this.watchScroll());
    this.destroyRef.onDestroy(() => {
      const composer = this.composerInput()?.nativeElement;
      if (composer !== undefined) {
        this.carets.save(this.sessionId(), {
          start: composer.selectionStart ?? composer.value.length,
          end: composer.selectionEnd ?? composer.value.length,
        });
      }
      // Flush any final keystroke before aborting subscriptions so switching Tabs never drops the last character.
      this.persistDraft();
      this.aborts.abort();
      this.stopTicker();
    });
    this.registerShortcuts();
    this.destroyRef.onDestroy(
      this.toolbar.publish({
        sessionId: this.sessionId,
        worker: this.workerCrumb,
        context: this.toolbarContext,
        actions: this.toolbarActions,
        run: (operation) => this.onSessionOperation(operation),
      }),
    );
    effect(() => {
      const live = this.live();
      if (live !== null) this.tabs.seedLive(this.sessionId(), live);
    });
    effect(() => {
      // A Worker with running children of its own opens on the panel, once; any other Session opens it from the Composer.
      if (this.workerPanelDecided || this.live() === null) return;
      this.workerPanelDecided = true;
      if (this.live()?.parentSessionId !== undefined && this.activeWorkerCount() > 0) {
        this.workersOpen.set(true);
      }
    });
    effect(() => {
      if (this.initialFocusDone) return;
      const composer = this.composerInput()?.nativeElement;
      if (composer === undefined) return;
      this.initialFocusDone = true;
      if (this.shouldFocusComposerOnMount(composer)) {
        composer.focus({ preventScroll: true });
      }
    });
    effect(() => {
      if (this.caretApplied || !this.composerLoaded()) return;
      const composer = this.composerInput()?.nativeElement;
      if (composer === undefined) return;
      const expected = this.draft();
      this.caretApplied = true;
      if (composer.value !== expected) composer.value = expected;
      const caret = this.carets.consume(this.sessionId());
      const max = composer.value.length;
      if (caret !== null) {
        composer.setSelectionRange(Math.min(caret.start, max), Math.min(caret.end, max));
      } else if (max > 0) {
        composer.setSelectionRange(max, max);
      }
    });
    effect(() => {
      const count = this.filteredCommands().length;
      this.selectedCommand.update((index) => (index >= count ? Math.max(0, count - 1) : index));
    });
    effect(() => {
      if (this.agentStatus() !== 'needsLogin') {
        this.loggingIn.set(false);
      }
    });
    effect(() => {
      if (!this.running() && !this.compacting()) {
        this.stopAgentConfirm.set(null);
      }
    });
    effect((onCleanup) => {
      if (this.stopAgentConfirm() === null) return;
      const release = this.keymap.pushModal({ onEscape: () => this.dismissStopAgentConfirm() });
      onCleanup(release);
    });
    effect(() => {
      this.persistDraft();
    });
    effect(() => {
      const pending = this.tabs.pendingTurnScroll();
      if (pending === null || pending.sessionId !== this.sessionId()) return;
      const rows = this.rows();
      if (!rows.some((row) => row.type === 'message' && row.message.turnId === pending.turnId)) {
        return;
      }
      const target = this.host.nativeElement.querySelector<HTMLElement>(
        `[data-turn-id="${pending.turnId}"]`,
      );
      if (target !== null && target !== undefined) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        this.tabs.clearTurnScroll(pending.sessionId, pending.turnId);
      }
    });
  }

  /** Follows the nearest scrolling ancestor so the jump-to-bottom button shows once the thread is far above the end. */
  private watchScroll(): void {
    let scroller: HTMLElement | null = this.host.nativeElement.parentElement;
    while (scroller !== null) {
      const overflow = getComputedStyle(scroller).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') break;
      scroller = scroller.parentElement;
    }
    const target = scroller ?? (this.document.scrollingElement as HTMLElement | null);
    if (target === null) return;
    const events: HTMLElement | Window = scroller ?? this.document.defaultView ?? target;
    this.scroller = target;
    const update = () => {
      this.awayFromBottom.set(target.scrollHeight - target.scrollTop - target.clientHeight > 400);
    };
    events.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(this.host.nativeElement);
    this.destroyRef.onDestroy(() => {
      events.removeEventListener('scroll', update);
      observer.disconnect();
    });
    update();
  }

  protected scrollToBottom(): void {
    this.scroller?.scrollTo({
      top: this.scroller.scrollHeight,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }

  private persistDraft(): void {
    if (!this.composerLoaded()) return;
    const draft: ComposerDraft = { text: this.draft(), images: this.images() };
    if (
      this.lastSaved !== null &&
      draft.text === this.lastSaved.text &&
      draft.images === this.lastSaved.images
    ) {
      return;
    }
    this.lastSaved = draft;
    void this.runtime.run(setComposer(this.sessionId(), draft));
  }

  ngOnInit(): void {
    void this.loadAgents();
    void this.restoreComposer();
    void this.subscribe();
    void this.refreshProjectFolder();
  }

  private async loadAgents(): Promise<void> {
    const exit = await this.runtime.run(listAgents(), { signal: this.aborts.signal });
    if (this.aborts.signal.aborted) return;
    if (Exit.isSuccess(exit)) this.availableAgents.set(exit.value);
  }

  private async restoreComposer(): Promise<void> {
    const exit = await this.runtime.run(getComposer(this.sessionId()), {
      signal: this.aborts.signal,
    });
    if (this.aborts.signal.aborted) return;
    if (Exit.isSuccess(exit)) {
      this.lastSaved = exit.value;
      if (this.draft() === '' && this.images().length === 0) {
        if (exit.value.text !== '') this.draft.set(exit.value.text);
        if (exit.value.images.length > 0) this.images.set(exit.value.images);
      }
    }
    this.composerLoaded.set(true);
  }

  /** A Message is settled once its Turn is no longer running: its Markdown is parsed once and cached. */
  protected settled(message: ThreadMessage): boolean {
    return this.thread().running !== message.turnId;
  }

  protected onOpenLink(url: string): void {
    void this.runtime.run(openExternal(url), { signal: this.aborts.signal });
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

  protected finishedCount(workers: ReadonlyArray<WorkerInfo>): number {
    return workers.filter((worker) => worker.state === 'idle').length;
  }

  protected workForTurn(turnId: TurnId) {
    return turnWork(this.thread(), turnId);
  }

  protected rowIndex(index: number, row: ThreadRow): string {
    switch (row.type) {
      case 'message':
        return `message-${row.message.id}`;
      case 'ticker':
        return `ticker-${row.turnId}`;
      case 'aside':
        return `aside-${row.aside.key}`;
      case 'receipt':
        return `receipt-${row.turnId}`;
      case 'workers':
        return `workers-${row.turnId}`;
      case 'fork':
        return `fork-${row.fork.forkSessionId}`;
      case 'outcome':
        return `outcome-${index}`;
    }
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
    if (value === undefined || value === null || value === '' || value === this.model()?.value) {
      return;
    }
    if (!this.isDraft() && this.capabilities()?.modelChangePreservesContext === false) {
      if (this.running() || this.compacting() || this.clearing()) {
        toast.error($localize`Finish or cancel the active Turn before changing Model.`);
        return;
      }
      this.openHandoff('modelChange', this.live()?.agentId, value);
      return;
    }
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

  protected async onStartEmptyContext(): Promise<void> {
    if (this.resolvingMemoryLost()) return;
    this.resolvingMemoryLost.set(true);
    const exit = await this.runtime.run(startEmptyContext(this.sessionId()), {
      signal: this.aborts.signal,
    });
    this.resolvingMemoryLost.set(false);
    if (!Exit.isSuccess(exit) && !this.aborts.signal.aborted) {
      toast.error($localize`Could not start with an empty context.`);
    }
  }

  protected async onClear(): Promise<void> {
    if (this.clearing() || this.running() || this.compacting()) return;
    this.commandsOpen.set(false);
    this.clearing.set(true);
    const exit = await this.runtime.run(clearContext(this.sessionId()), {
      signal: this.aborts.signal,
    });
    this.clearing.set(false);
    if (Exit.isSuccess(exit)) {
      this.draft.set('');
      this.composerInput()?.nativeElement.focus({ preventScroll: true });
      return;
    }
    if (!this.aborts.signal.aborted) toast.error($localize`Could not clear the context.`);
  }

  protected async onCompact(): Promise<void> {
    if (this.clearing() || this.running() || this.compacting() || !this.supportsCompaction()) {
      return;
    }
    this.commandsOpen.set(false);
    const previousDraft = this.draft();
    if (previousDraft.trim() === '/compact') this.draft.set('');
    const exit = await this.runtime.run(compactSession(this.sessionId()), {
      signal: this.aborts.signal,
    });
    if (Exit.isSuccess(exit)) {
      this.composerInput()?.nativeElement.focus({ preventScroll: true });
      return;
    }
    if (this.draft() === '' && previousDraft.trim() === '/compact') {
      this.draft.set(previousDraft);
    }
    if (!this.aborts.signal.aborted) toast.error($localize`Could not compact the context.`);
  }

  protected onSessionOperation(operation: SessionOperation): void {
    switch (operation) {
      case 'Compact':
        void this.onCompact();
        return;
      case 'Clear':
        void this.onClear();
        return;
      case 'Switch Agent':
        this.openHandoff('switch');
        return;
    }
  }

  protected openHandoff(kind: HandoffKind, targetAgentId?: AgentId, targetModel?: string): void {
    if (this.running() || this.compacting() || this.clearing()) return;
    this.commandsOpen.set(false);
    this.handoffDialog.set({ kind, targetAgentId, targetModel });
    void this.loadHandoffAttempts();
  }

  protected onHandoffCommitted(result: {
    readonly contextId: string;
    readonly forkSessionId?: SessionId;
  }): void {
    this.handoffDialog.set(null);
    if (result.forkSessionId !== undefined) {
      this.tabs.markSessionsChanged();
      toast.success($localize`Fork created.`);
    }
    this.composerInput()?.nativeElement.focus({ preventScroll: true });
  }

  protected openSession(id: SessionId, title: string | null): void {
    const projectId = this.projectId();
    if (projectId === null) return;
    this.workersOpen.set(false);
    this.tabs.open({ id, projectId, title });
  }

  protected onOpenForkSource(lineage: ForkLineage): void {
    const projectId = this.projectId();
    if (lineage.sourceDeleted || projectId === null) return;
    this.tabs.open({
      id: lineage.sourceSessionId,
      projectId,
      title: lineage.sourceTitle,
    });
    if (lineage.sourceTurnId !== undefined) {
      this.tabs.requestTurnScroll(lineage.sourceSessionId, lineage.sourceTurnId);
    }
  }

  protected onOpenForkTarget(fork: ForkTarget): void {
    const projectId = this.projectId();
    if (projectId === null) return;
    this.tabs.open({
      id: fork.forkSessionId,
      projectId,
      title: fork.forkTitle,
    });
  }

  protected onHandoffAttemptRecorded(attempt: HandoffAttempt): void {
    this.handoffAttempts.update((list) => [attempt, ...list]);
  }

  private async loadHandoffAttempts(): Promise<void> {
    const id = this.sessionId();
    const exit = await this.runtime.run(
      Effect.gen(function* () {
        const api = yield* DesktopApi;
        return yield* api['Session.listHandoffAttempts']({ sessionId: id });
      }),
      { signal: this.aborts.signal },
    );
    if (Exit.isSuccess(exit)) {
      this.handoffAttempts.set(exit.value);
    }
  }

  protected pickCommand(command: Command): void {
    if (command.owner.kind === 'spence') {
      if (command.name === 'clear') {
        void this.onClear();
        return;
      }
      if (command.name === 'compact' && this.supportsCompaction()) {
        void this.onCompact();
        return;
      }
    }
    const text = `${command.invocation} `;
    this.draft.set(text);
    this.commandsOpen.set(false);
    const composer = this.composerInput()?.nativeElement;
    if (composer === undefined) return;
    composer.value = text;
    composer.focus({ preventScroll: true });
    composer.setSelectionRange(text.length, text.length);
  }

  protected onPaste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (data === null) return;
    const files: Array<File> = [...data.files];
    if (files.length === 0) {
      for (const item of [...data.items]) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file !== null) files.push(file);
      }
    }
    // A clipboard with only text stays an ordinary paste; one with images attaches them instead.
    if (!files.some((file) => file.type.startsWith('image/'))) return;
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

  private registerShortcuts(): void {
    this.keymap.register({
      binding: { key: 'l', mod: true },
      when: () => this.composerInput() !== undefined,
      run: () => {
        this.composerInput()?.nativeElement.focus();
      },
      destroyRef: this.destroyRef,
    });
    this.keymap.register({
      binding: { key: 'm', mod: true, shift: true },
      when: () => this.controlsTarget() !== null,
      run: () => {
        const target = this.controlsTarget();
        if (target === null) return false;
        target.focus();
        target.click();
        return true;
      },
      destroyRef: this.destroyRef,
    });
    this.keymap.register({
      binding: { key: 'a', mod: true, shift: true },
      when: () => this.live() !== undefined && !this.controlsDisabled() && this.askSupported(),
      run: () => {
        this.onModeChange(this.permissionMode() === 'ask' ? 'auto' : 'ask');
      },
      destroyRef: this.destroyRef,
    });
    for (const index of [0, 1, 2, 3] as const) {
      this.keymap.register({
        binding: { code: `Digit${index + 1}` },
        when: () => this.pendingPermission() !== null && this.sortedOptions()[index] !== undefined,
        run: (event) => {
          if (this.keymap.isMenuOpen() || !this.mayAnswerWithKey(event.target)) return false;
          const option = this.sortedOptions()[index];
          if (option === undefined) return false;
          void this.answer(option.id);
          return true;
        },
        destroyRef: this.destroyRef,
      });
    }
    this.keymap.register({
      binding: { key: 'Enter', mod: true },
      when: () => this.running() && this.composerReady(),
      run: () => {
        void this.queueDraft();
        return true;
      },
      destroyRef: this.destroyRef,
    });
    this.keymap.register({
      binding: { key: 'Enter', mod: true, shift: true },
      when: () => this.running() && this.steeringSupported() && this.composerReady(),
      run: () => {
        void this.steerDraft();
        return true;
      },
      destroyRef: this.destroyRef,
    });
    this.keymap.registerEscape({
      layer: 'commands',
      when: () => this.commandsOpen(),
      run: () => this.commandsOpen.set(false),
      destroyRef: this.destroyRef,
    });
    this.keymap.registerEscape({
      layer: 'stopTurn',
      when: () => (this.running() && this.cancelGrace() === undefined) || this.compacting(),
      run: () => {
        void this.stop();
      },
      destroyRef: this.destroyRef,
    });
    this.keymap.registerFallback({
      run: (event) => this.handleTypeToFocus(event),
      destroyRef: this.destroyRef,
    });
  }

  private shouldFocusComposerOnMount(composer: HTMLTextAreaElement): boolean {
    if (this.keymap.modalOpen() || this.keymap.isMenuOpen()) return false;
    const active = this.document.activeElement;
    return !(active !== composer && isTextInputTarget(active));
  }

  private handleTypeToFocus(event: KeyboardEvent): boolean {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key.length !== 1) return false;
    if (this.keymap.modalOpen() || this.keymap.isMenuOpen()) return false;
    if (
      this.pendingPermission() !== null &&
      (/^[1-4]$/.test(event.key) || /^Digit[1-4]$/.test(event.code))
    ) {
      return false;
    }

    const composer = this.composerInput()?.nativeElement;
    if (composer === undefined || composer.disabled) return false;

    const target = event.target;
    if (target instanceof HTMLElement) {
      if (isTextInputTarget(target)) return false;
      if (
        target.closest(
          '[data-slot="sidebar"], [data-sidebar="sidebar"], aside, [role="tablist"], [role="menu"]',
        ) !== null
      ) {
        return false;
      }
      if (
        target.closest(
          'button, a, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"]',
        ) !== null
      ) {
        return false;
      }
    }
    if (!this.isFocusInSessionView()) return false;

    composer.focus({ preventScroll: true });
    const start = composer.selectionStart ?? composer.value.length;
    const end = composer.selectionEnd ?? start;
    composer.setRangeText(event.key, start, end, 'end');
    this.onInput(composer.value);
    return true;
  }

  private controlsTarget(): HTMLElement | null {
    const root = this.host.nativeElement;
    return root.querySelector<HTMLElement>('[data-testid="model-picker"]');
  }

  private isFocusInSessionView(): boolean {
    const active = this.document.activeElement;
    return (
      active === null ||
      active === this.document.body ||
      active === this.document.documentElement ||
      this.host.nativeElement.contains(active)
    );
  }

  protected async answer(optionId: string): Promise<void> {
    const pending = this.pendingPermission();
    if (pending === null) return;
    await this.runtime.run(answerPermission(this.sessionId(), pending.requestId, optionId), {
      signal: this.aborts.signal,
    });
  }

  protected async setAgent(value: string | undefined | null): Promise<void> {
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      value === this.activeAgentId() ||
      !isAgentId(value)
    ) {
      return;
    }
    this.changingAgent.set(true);
    const exit = await this.runtime.run(setSessionAgent(this.sessionId(), value), {
      signal: this.aborts.signal,
    });
    this.changingAgent.set(false);
    if (Exit.isFailure(exit) && !this.aborts.signal.aborted) {
      toast.error($localize`Could not change the Agent.`);
    }
  }

  protected onModeChange(value: unknown): void {
    if (!isPermissionMode(value) || value === this.permissionMode()) return;
    if (value === 'ask' && !this.askSupported()) return;
    void this.runtime.run(setPermissionMode(this.sessionId(), value), {
      signal: this.aborts.signal,
    });
  }

  protected async send(): Promise<void> {
    if (!this.canSend()) return;
    const { text, images, trimmed, parts } = this.composeParts();
    if (images.length === 0) {
      if (trimmed === '/clear') {
        this.commandsOpen.set(false);
        void this.onClear();
        return;
      }
      if (trimmed === '/compact' && this.supportsCompaction()) {
        this.commandsOpen.set(false);
        void this.onCompact();
        return;
      }
    }
    this.sending.set(true);
    // A draft that chose "New worktree" gets its worktree now; if that fails the message stays in the Composer.
    if (!((await this.composerStatus()?.prepare(trimmed)) ?? true)) {
      this.sending.set(false);
      return;
    }
    const exit = await this.runtime.run(sendPrompt(this.sessionId(), parts), {
      signal: this.aborts.signal,
    });
    this.sending.set(false);
    if (Exit.isSuccess(exit)) {
      this.sentTurn = exit.value;
      this.consumeDraft(text, images);
      this.messageSent.emit(this.sessionId());
      if (this.thread().outcomes.get(exit.value)?._tag === 'failed') {
        this.restoreFailedTurn(exit.value);
      }
      return;
    }
    if (!this.aborts.signal.aborted) toast.error($localize`Could not send the Message.`);
  }

  /** The Composer as Message parts: Images first, then its text. */
  private composeParts(): {
    readonly text: string;
    readonly images: ReadonlyArray<Attached>;
    readonly trimmed: string;
    readonly parts: ReadonlyArray<MessagePart>;
  } {
    const text = this.draft();
    const images = this.images();
    const trimmed = text.trim();
    const parts: Array<MessagePart> = [...imageParts(images)];
    if (trimmed !== '') parts.push({ _tag: 'text', text });
    return { text, images, trimmed, parts };
  }

  /** Clears the Composer only if the user did not change it meanwhile. */
  private consumeDraft(text: string, images: ReadonlyArray<Attached>): void {
    if (this.draft() === text && this.images() === images) {
      this.draft.set('');
      this.images.set([]);
      this.carets.clear(this.sessionId());
    }
  }

  /** Lines the Composer up in the Queue, while a Turn runs. */
  protected async queueDraft(): Promise<void> {
    if (!this.running() || !this.composerReady()) return;
    this.commandsOpen.set(false);
    const { text, images, parts } = this.composeParts();
    this.sending.set(true);
    const exit = await this.runtime.run(enqueueMessage(this.sessionId(), parts), {
      signal: this.aborts.signal,
    });
    this.sending.set(false);
    if (Exit.isSuccess(exit)) {
      this.consumeDraft(text, images);
      return;
    }
    if (!this.aborts.signal.aborted) toast.error($localize`Could not queue the Message.`);
  }

  /** Steers the running Turn; when it settles first, the Message is sent as a normal Turn instead. */
  protected async steerDraft(): Promise<void> {
    if (!this.running() || !this.steeringSupported() || !this.composerReady()) return;
    this.commandsOpen.set(false);
    const { text, images, parts } = this.composeParts();
    this.sending.set(true);
    const exit = await this.runtime.run(steerTurn(this.sessionId(), parts), {
      signal: this.aborts.signal,
    });
    if (Exit.isSuccess(exit)) {
      this.sending.set(false);
      this.consumeDraft(text, images);
      return;
    }
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (
      !this.aborts.signal.aborted &&
      failure !== undefined &&
      failure._tag === 'SessionError' &&
      failure.reason === 'NotRunning'
    ) {
      const fallback = await this.runtime.run(sendPrompt(this.sessionId(), parts), {
        signal: this.aborts.signal,
      });
      this.sending.set(false);
      if (Exit.isSuccess(fallback)) {
        this.sentTurn = fallback.value;
        this.consumeDraft(text, images);
        this.messageSent.emit(this.sessionId());
        return;
      }
      if (!this.aborts.signal.aborted) toast.error($localize`Could not steer the Turn.`);
      return;
    }
    this.sending.set(false);
    if (!this.aborts.signal.aborted) toast.error($localize`Could not steer the Turn.`);
  }

  protected queuedText(item: QueuedMessage): string {
    return item.parts.map((part) => (part._tag === 'text' ? part.text : '')).join('');
  }

  protected queuedImages(item: QueuedMessage): ReadonlyArray<ImagePart> {
    return item.parts.filter((part): part is ImagePart => part._tag === 'image');
  }

  protected moveQueued(id: MessageId, delta: number): void {
    const queue = [...this.queue()];
    const index = queue.findIndex((item) => item.id === id);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= queue.length) return;
    const [moved] = queue.splice(index, 1);
    if (moved === undefined) return;
    queue.splice(target, 0, moved);
    void this.saveQueue(queue);
  }

  protected removeQueued(id: MessageId): void {
    void this.saveQueue(this.queue().filter((item) => item.id !== id));
  }

  protected clearQueued(): void {
    void this.runtime.run(clearSessionQueue(this.sessionId()), { signal: this.aborts.signal });
  }

  protected commitQueuedEdit(item: QueuedMessage, value: string): void {
    if (this.editingQueued() !== item.id) return;
    this.editingQueued.set(null);
    const text = value.trim();
    const keep = item.parts.filter((part) => part._tag !== 'text');
    if (text === '' && keep.length === 0) {
      this.removeQueued(item.id);
      return;
    }
    const parts: ReadonlyArray<MessagePart> = [
      ...(text === '' ? [] : [{ _tag: 'text', text: value } as const]),
      ...keep,
    ];
    void this.saveQueue(
      this.queue().map((queued) => (queued.id === item.id ? { ...queued, parts } : queued)),
    );
  }

  private async saveQueue(queue: ReadonlyArray<QueuedMessage>): Promise<void> {
    const exit = await this.runtime.run(replaceQueue(this.sessionId(), queue), {
      signal: this.aborts.signal,
    });
    if (Exit.isFailure(exit) && !this.aborts.signal.aborted) {
      toast.error($localize`Could not change the Queue.`);
    }
  }

  protected async stop(): Promise<void> {
    await this.runtime.run(cancelTurn(this.sessionId()), { signal: this.aborts.signal });
  }

  protected async onStopAgentClick(): Promise<void> {
    const grace = this.cancelGrace();
    if (grace === undefined || this.stoppingAgent()) return;
    if (grace.otherWorkingCount > 0) {
      this.stopAgentConfirm.set({
        agentName: this.agentName(),
        otherWorkingCount: grace.otherWorkingCount,
      });
      return;
    }
    await this.runStopAgent(false);
  }

  protected dismissStopAgentConfirm(): void {
    this.stopAgentConfirm.set(null);
  }

  protected onStopAgentConfirmStateChange(next: string): void {
    if (next === 'closed') this.dismissStopAgentConfirm();
  }

  protected async confirmStopAgent(): Promise<void> {
    this.stopAgentConfirm.set(null);
    await this.runStopAgent(true);
  }

  private async runStopAgent(force: boolean): Promise<void> {
    if (this.stoppingAgent()) return;
    this.stoppingAgent.set(true);
    const exit = await this.runtime.run(stopAgent(this.sessionId(), force ? true : undefined), {
      signal: this.aborts.signal,
    });
    this.stoppingAgent.set(false);
    if (Exit.isSuccess(exit)) {
      if (exit.value._tag === 'confirmRequired') {
        this.stopAgentConfirm.set({
          agentName: exit.value.agentName,
          otherWorkingCount: exit.value.otherWorkingCount,
        });
      }
      return;
    }
    if (this.aborts.signal.aborted) return;
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (
      failure !== undefined &&
      failure._tag === 'SessionError' &&
      failure.reason === 'ExitUnconfirmed'
    ) {
      toast.error(failure.detail);
    } else {
      toast.error($localize`Could not stop the Agent.`);
    }
  }

  protected async onRetryAgent(): Promise<void> {
    const exit = await this.runtime.run(retryAgent(this.sessionId()), {
      signal: this.aborts.signal,
    });
    if (Exit.isSuccess(exit) || this.aborts.signal.aborted) return;
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (
      failure !== undefined &&
      failure._tag === 'SessionError' &&
      failure.reason === 'ExitUnconfirmed'
    ) {
      toast.error(failure.detail);
    }
  }

  protected async onLoginAgent(): Promise<void> {
    if (this.loggingIn()) return;
    this.loginAborts = new AbortController();
    const signal = AbortSignal.any([this.aborts.signal, this.loginAborts.signal]);
    this.loggingIn.set(true);
    const exit = await this.runtime.run(loginAgent(this.sessionId()), { signal });
    this.loggingIn.set(false);
    this.loginAborts = null;
    if (!Exit.isSuccess(exit) && !signal.aborted) {
      toast.error($localize`Log in did not finish.`);
    }
  }

  protected onCancelLogin(): void {
    this.loginAborts?.abort();
    this.loginAborts = null;
    this.loggingIn.set(false);
  }

  protected async onOpenAgentLog(): Promise<void> {
    await this.runtime.run(openAgentLog(this.sessionId()), { signal: this.aborts.signal });
  }

  protected async onLocateProject(): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    const exit = await this.runtime.run(locateProject(projectId), { signal: this.aborts.signal });
    if (Exit.isSuccess(exit) && exit.value !== null) {
      this.folderMissing.set(exit.value.folderMissing);
    }
  }

  private async refreshProjectFolder(): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    const exit = await this.runtime.run(checkProject(projectId), { signal: this.aborts.signal });
    if (Exit.isSuccess(exit)) {
      this.folderMissing.set(exit.value.folderMissing);
    }
  }

  private async attachFiles(files: FileList | ReadonlyArray<File> | null): Promise<void> {
    if (files === null) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    const candidates = await Promise.all(list.map((file) => readCandidate(file)));
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
          if (item._tag === 'Live' && item.state.runningTurn !== undefined) {
            this.sentTurn = item.state.runningTurn;
          }
          const previousSeq = this.thread().lastSeq;
          this.thread.update((thread) => foldThread(thread, item));
          if (
            item._tag === 'Transcript' &&
            item.event.seq > previousSeq &&
            item.event.item._tag === 'TurnEnded'
          ) {
            const outcome = item.event.item.outcome;
            if (this.sentTurn === item.event.item.turnId) {
              if (outcome._tag === 'failed') this.restoreFailedTurn(item.event.item.turnId);
              this.sentTurn = null;
            }
          }
          this.updateTicker(this.thread().running !== null);
        },
      ),
      { signal: this.aborts.signal },
    );
    if (Exit.isFailure(exit) && !this.aborts.signal.aborted) this.following.set('failed');
  }

  private updateTicker(running: boolean): void {
    if (running) {
      this.now.set(Date.now());
      if (this.ticker === undefined) {
        this.ticker = setInterval(() => this.now.set(Date.now()), TICKER_INTERVAL_MS);
      }
    } else {
      this.stopTicker();
    }
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private mayAnswerWithKey(target: EventTarget | null): boolean {
    if (target === null) return true;
    const composer = this.composerInput()?.nativeElement;
    if (composer === undefined) return false;
    if (target === composer) return composer.value === '';
    if (isTextInputTarget(target)) return false;
    return true;
  }
}
