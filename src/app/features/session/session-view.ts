import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  type OnInit,
} from '@angular/core';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmKbdImports } from '@ui/kbd';
import { HlmButtonImports } from '@ui/button';
import { HlmNativeSelectImports } from '@ui/native-select';
import { HlmTextareaImports } from '@ui/textarea';
import { HlmToggleGroupImports } from '@ui/toggle-group';
import { HlmTooltipImports } from '@ui/tooltip';
import { toast } from '@ui/toast';
import { Cause, Effect, Exit, Option, Schedule, Schema, Stream } from 'effect';
import { PermissionMode, type ProjectId } from '../../../shared/projects/projects.rpc';
import { AgentId, type Agent, type Effort } from '../../../shared/agents/agents.rpc';
import {
  STOP_AGENT_INTERRUPTED_DETAIL,
  type Command,
  type ComposerDraft,
  type ForkLineage,
  type ForkTarget,
  type HandoffAttempt,
  type HandoffKind,
  type MessagePart,
  type PermissionRequestId,
  type SessionId,
  type SessionStreamItem,
  type TurnId,
} from '../../../shared/sessions/sessions.rpc';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFolder } from '@ng-icons/lucide';
import type { FilesRootTarget } from '../../../shared/files/files.rpc';
import type { WorktreeInventory } from '../../../shared/worktrees/worktrees.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { isTextInputTarget, Keymap } from '../../core/keymap';
import { Tabs } from '../../core/tabs';
import { AgentBar } from './agent-bar';
import { HandoffDialog } from './handoff-dialog';
import { MemoryLostBar } from './memory-lost-bar';
import { WorktreePill } from './worktree-pill';
import { SessionInspector } from './session-inspector';
import { ComposerCarets } from './composer-carets';
import { Dock } from './dock';
import { Receipt } from './receipt';
import { Ticker } from './ticker';
import { ThreadAsideComponent } from './thread-aside';
import {
  emptyThread,
  foldThread,
  runningWork,
  textRuns,
  threadRows,
  turnWork,
  type Thread,
  type ThreadDivider,
  type ThreadRow,
} from './thread';

import { ContextRing } from './context-ring';
import { ImageStrip } from './image-strip';
import { admitImages, imageParts, readCandidate, type Attached, type Refusal } from './images';
import { SessionActionPicker, type SessionOperation } from './session-action-picker';

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

const refreshWorktrees = Effect.fnUntraced(function* (path: string, projectId?: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.refresh'](projectId === undefined ? { path } : { path, projectId });
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
@Component({
  selector: 'app-session-view',
  imports: [
    HlmAlertDialogImports,
    HlmButtonImports,
    HlmNativeSelectImports,
    HlmTextareaImports,
    HlmToggleGroupImports,
    HlmTooltipImports,
    ContextRing,
    SessionActionPicker,
    ImageStrip,
    HlmKbdImports,
    AgentBar,
    HandoffDialog,
    MemoryLostBar,
    WorktreePill,
    SessionInspector,
    NgIcon,
    Dock,
    Ticker,
    Receipt,
    ThreadAsideComponent,
  ],
  providers: [provideIcons({ lucideFolder })],
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
    <div
      class="flex w-full items-start"
      [class.gap-6]="inspectorOpen() && following() !== 'failed'"
    >
      <div class="flex min-w-0 flex-1 flex-col">
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

                @if (row.message.role === 'user') {
                  <div
                    class="bg-muted max-w-[80%] self-end rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
                    data-testid="message-user"
                    [attr.data-turn-id]="row.message.turnId"
                  >
                    @if (row.message.images.length > 0) {
                      <app-image-strip
                        class="mb-2"
                        [images]="row.message.images"
                        data-testid="message-images"
                      />
                    }
                    {{ row.message.text }}
                  </div>
                } @else {
                  <div
                    class="text-sm leading-relaxed whitespace-pre-wrap"
                    data-testid="message-agent"
                  >
                    @if (row.message.images.length > 0) {
                      <app-image-strip
                        class="mb-2"
                        [images]="row.message.images"
                        data-testid="message-images"
                      />
                    }
                    @for (run of runs(row.message.text); track $index) {
                      @switch (run.kind) {
                        @case ('prose') {
                          <span>{{ run.text }}</span>
                        }
                        @case ('code') {
                          <code class="bg-muted rounded px-1 font-mono text-xs">{{
                            run.text
                          }}</code>
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
          <div
            class="flex items-center gap-2 pb-2 text-sm text-muted-foreground"
            data-testid="ticker"
          >
            <span class="size-2 rounded-full bg-[var(--attention)]"></span>
            <span i18n>Waiting for you below</span>
          </div>
          <div
            class="border-border mb-2 flex flex-col gap-2 rounded-lg border p-3"
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
          <div class="bg-background sticky bottom-0 flex flex-col gap-2 pb-2">
            @if (memoryLost()) {
              <app-memory-lost-bar
                [resolving]="resolvingMemoryLost()"
                [canPrepareHandoff]="!running() && !compacting() && !clearing()"
                (prepareSummaryHandoff)="openHandoff('memoryLost')"
                (startEmptyContext)="onStartEmptyContext()"
              />
            }
            @if (worktreeMissing()) {
              <div
                class="bg-muted flex flex-wrap items-center justify-between gap-2 rounded-md p-2 text-sm"
                data-testid="worktree-missing-bar"
              >
                @if (worktreeBinding()?.reason === 'ReplacedFolder') {
                  <span i18n>Bound Worktree folder was replaced; Send is disabled.</span>
                } @else {
                  <span i18n>Bound Worktree is missing; Send is disabled.</span>
                }
                <button
                  #missingDetailsBtn
                  hlmBtn
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="worktree-missing-details"
                  (click)="worktreePill.open(missingDetailsBtn)"
                  i18n
                >
                  Details
                </button>
              </div>
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
              class="flex flex-col gap-2"
              data-testid="composer"
              (submit)="$event.preventDefault(); send()"
            >
              <div class="flex items-center justify-between gap-2">
                @if (showDraftAgentPicker()) {
                  <hlm-native-select
                    data-testid="draft-agent-picker"
                    selectId="draft-agent-picker"
                    size="sm"
                    aria-label="Agent"
                    i18n-aria-label
                    [value]="activeAgentId()"
                    [disabled]="changingAgent() || running()"
                    (valueChange)="setAgent($event)"
                  >
                    @for (agent of availableAgents(); track agent.id) {
                      <option [value]="agent.id">{{ agent.name }}</option>
                    }
                  </hlm-native-select>
                }
                <div
                  hlmToggleGroup
                  variant="outline"
                  size="sm"
                  data-testid="permission-mode"
                  [hlmTooltip]="permissionModeTip"
                  aria-label="Permission mode"
                  i18n-aria-label
                  [nullable]="false"
                  [value]="permissionMode()"
                  (valueChange)="onModeChange($event)"
                >
                  <button
                    hlmToggleGroupItem
                    value="ask"
                    data-testid="permission-mode-ask"
                    [disabled]="!askSupported()"
                    i18n
                  >
                    Ask
                  </button>
                  <button hlmToggleGroupItem value="auto" data-testid="permission-mode-auto" i18n>
                    Auto
                  </button>
                </div>
              </div>
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
              <div class="flex flex-wrap items-center gap-2">
                @if (controlsLoading()) {
                  <span class="text-muted-foreground text-xs" data-testid="controls-loading" i18n>
                    Starting the Agent…
                  </span>
                } @else {
                  @if (!modelsSupported()) {
                    <span
                      class="text-muted-foreground text-xs"
                      data-testid="models-unavailable"
                      i18n
                    >
                      Model selection isn't available for {{ agentName() }}
                    </span>
                  } @else if (model(); as modelOption) {
                    <hlm-native-select
                      data-testid="model-picker"
                      selectId="model-picker"
                      size="sm"
                      [hlmTooltip]="modelTip"
                      aria-label="Model"
                      i18n-aria-label
                      [value]="modelOption.value ?? ''"
                      [disabled]="controlsDisabled()"
                      (valueChange)="setModel($event)"
                    >
                      @if (modelOption.value === undefined) {
                        <option value="" disabled i18n>Select model…</option>
                      }
                      @for (choice of modelOption.choices; track choice.id) {
                        <option [value]="choice.id">{{ choice.name }}</option>
                      }
                    </hlm-native-select>
                  }
                  @if (!effortSupported()) {
                    <span
                      class="text-muted-foreground text-xs"
                      data-testid="effort-unavailable"
                      i18n
                    >
                      Effort selection isn't available for {{ agentName() }}
                    </span>
                  } @else if (effort(); as effortOption) {
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
                  (paste)="onPaste($event)"
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
                      <div class="text-muted-foreground px-3 py-2 text-sm" i18n>
                        No commands match.
                      </div>
                    }
                  </div>
                }
              </div>

              <div class="flex items-center justify-end gap-2">
                <app-context-ring [usage]="contextUsage()" [agentName]="agentName()" />
                <app-session-action-picker
                  #actionPicker
                  [(open)]="actionPickerOpen"
                  [running]="running()"
                  [compacting]="compacting()"
                  [clearing]="clearing()"
                  [agentStatus]="agentStatus()"
                  [supportsCompaction]="supportsCompaction()"
                  [agentName]="agentName()"
                  (invokeOperation)="onSessionOperation($event)"
                />
                <span
                  [hlmTooltip]="attachTooltip() ?? ''"
                  [tooltipDisabled]="attachTooltip() === null"
                >
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
                <button hlmBtn type="submit" data-testid="send" [disabled]="!canSend()" i18n>
                  Send
                </button>
              </div>
            </form>
            <div
              class="flex items-center justify-between gap-2 px-1 pt-0.5"
              data-testid="composer-bottom"
            >
              <app-worktree-pill
                #worktreePill
                [binding]="worktreeBinding()"
                [inventory]="effectiveWorktreeInventory()"
                [refreshing]="refreshingWorktrees()"
                (refreshRequested)="onRefreshWorktrees()"
              />
              @if (projectId() !== null) {
                <button
                  #filesTrigger
                  type="button"
                  hlmBtn
                  variant="ghost"
                  size="xs"
                  data-testid="files-inspector-toggle"
                  class="text-muted-foreground hover:text-foreground h-6 gap-1.5 rounded-md px-2 text-xs font-normal"
                  [class.bg-accent]="inspectorOpen()"
                  [class.text-foreground]="inspectorOpen()"
                  [attr.aria-expanded]="inspectorOpen()"
                  (click)="toggleInspector()"
                >
                  <ng-icon name="lucideFolder" class="size-3.5" aria-hidden="true" />
                  <span i18n>Files</span>
                </button>
              }
            </div>
          </div>
        }
      </div>

      @if (inspectorOpen() && following() !== 'failed') {
        <aside
          data-testid="session-inspector-pane"
          class="bg-card/40 sticky top-6 flex h-[calc(100vh-7rem)] w-[340px] shrink-0 flex-col overflow-hidden rounded-lg border lg:w-[380px]"
        >
          <app-session-inspector
            [target]="filesTarget()"
            [rootContextLabel]="filesRootContextLabel()"
            [rootFolderName]="filesRootFolderName()"
            [worktreeMissing]="worktreeMissing() || folderMissing()"
            [liveRefreshTick]="filesRefreshTick()"
            (closeRequested)="closeInspector()"
          />
        </aside>
      }
    </div>

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
  `,
})
export class SessionView implements OnInit {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  protected readonly keymap = inject(Keymap);
  private readonly carets = inject(ComposerCarets);
  private readonly destroyRef = inject(DestroyRef);
  private readonly runtime = inject(EffectRuntime);
  private readonly tabs = inject(Tabs);
  private readonly aborts = new AbortController();
  private readonly composerInput = viewChild<ElementRef<HTMLTextAreaElement>>('composerInput');
  private readonly actionPicker = viewChild<SessionActionPicker>('actionPicker');
  private ticker: ReturnType<typeof setInterval> | undefined;
  private initialFocusDone = false;
  private caretApplied = false;

  readonly sessionId = input.required<SessionId>();
  readonly projectId = input<ProjectId | null>(null);
  readonly messageSent = output<SessionId>();

  protected readonly thread = signal<Thread>(emptyThread);
  /** Whether the Session's events arrive: before the first one, while they do, or never (the Session is gone). */
  protected readonly following = signal<'loading' | 'following' | 'failed'>('loading');
  protected readonly folderMissing = signal(false);
  private readonly projectPath = signal<string | null>(null);
  protected readonly inspectorOpen = signal(false);
  private readonly filesTrigger = viewChild<ElementRef<HTMLButtonElement>>('filesTrigger');
  protected readonly refreshingWorktrees = signal(false);
  private readonly refreshedWorktrees = signal<WorktreeInventory | undefined>(undefined);
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
  protected readonly actionPickerOpen = signal(false);
  /** The `/` Commands list is open. */
  protected readonly commandsOpen = signal(false);
  /** Selected index in the filtered Commands list. */
  protected readonly selectedCommand = signal(0);

  protected readonly running = computed(() => this.thread().running !== null);
  protected readonly live = computed(() => this.thread().live);
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

  protected readonly forkLineage = computed(() => this.live()?.forkLineage);
  protected readonly forks = computed(() => this.live()?.forks ?? []);
  protected readonly rows = computed(() => threadRows(this.thread(), this.forks()));
  protected readonly runningPlan = computed(() => runningWork(this.thread())?.plan ?? null);

  protected readonly commandFilter = computed(() => {
    const draft = this.draft();
    return draft.startsWith('/') ? draft.slice(1).trimStart() : '';
  });

  protected readonly filteredCommands = computed(() => {
    const filter = this.commandFilter().toLowerCase();
    if (filter === '') return this.commands();
    return this.commands().filter((command) => command.name.toLowerCase().startsWith(filter));
  });

  private dragCount = 0;
  private sentTurn: Thread['messages'][number]['turnId'] | null = null;

  protected readonly agentName = computed(() => this.thread().live?.agentName ?? $localize`Agent`);
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
  protected readonly worktreeBinding = computed(() => this.live()?.worktreeBinding);
  protected readonly worktreeMissing = computed(() => this.worktreeBinding()?.state === 'missing');
  protected readonly filesTarget = computed<FilesRootTarget | null>(() => {
    const projectId = this.projectId();
    const live = this.live();
    if (projectId === null || live === null || this.folderMissing() || this.worktreeMissing()) {
      return null;
    }
    const binding = live.worktreeBinding;
    if (binding?.state === 'resolved' && binding.worktreeId !== undefined) {
      return { projectId, worktreeId: binding.worktreeId };
    }
    return { projectId };
  });
  protected readonly filesRootContextLabel = computed<string>(() => {
    const binding = this.worktreeBinding();
    const inventory = this.effectiveWorktreeInventory();
    const entry =
      binding?.worktreeId === undefined
        ? undefined
        : inventory?.worktrees.find((item) => item.id === binding.worktreeId);
    if (entry) {
      switch (entry.head._tag) {
        case 'Branch':
          return entry.head.branch;
        case 'Detached':
          return entry.head.commit ? entry.head.commit.slice(0, 7) : $localize`Detached HEAD`;
        case 'Unborn':
          return entry.head.branch ?? $localize`Unborn branch`;
      }
    }
    if (binding?.lastKnownBranch) return binding.lastKnownBranch;
    if (binding?.reason === 'NonGit' || inventory?.capability._tag === 'NonGit') {
      return $localize`Local folder`;
    }
    return $localize`Project folder`;
  });
  protected readonly filesRootFolderName = computed<string>(() => {
    const binding = this.worktreeBinding();
    const inventory = this.effectiveWorktreeInventory();
    const entry =
      binding?.worktreeId === undefined
        ? undefined
        : inventory?.worktrees.find((item) => item.id === binding.worktreeId);
    if (entry?.folderName) return entry.folderName;
    const raw = binding?.expectedPath ?? this.projectPath();
    if (!raw) return '';
    const trimmed = raw.replace(/[\\/]+$/, '');
    const parts = trimmed.split(/[\\/]/);
    return parts.at(-1) ?? '';
  });
  protected readonly filesRefreshTick = computed<number>(() => {
    const current = this.thread();
    let completedSteps = 0;
    for (const step of current.steps) {
      if (step.status !== 'running') completedSteps += 1;
    }
    return completedSteps + current.outcomes.size;
  });
  protected readonly effectiveWorktreeInventory = computed(() => {
    const liveInv = this.live()?.worktreeInventory;
    const localInv = this.refreshedWorktrees();
    if (liveInv === undefined) return localInv;
    if (localInv === undefined) return liveInv;
    return localInv.refreshedAt >= liveInv.refreshedAt ? localInv : liveInv;
  });
  protected readonly canSend = computed(() => {
    if (
      this.running() ||
      this.compacting() ||
      this.sending() ||
      this.stoppingAgent() ||
      this.imagesBlocked() ||
      this.folderMissing() ||
      this.unconfirmedExit() !== undefined ||
      this.memoryLost() ||
      this.worktreeMissing()
    ) {
      return false;
    }
    const status = this.agentStatus();
    if (status !== 'ready' && status !== 'stopped') return false;
    return this.draft().trim() !== '' || this.images().length > 0;
  });

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

  protected workForTurn(turnId: TurnId) {
    return turnWork(this.thread(), turnId);
  }

  protected rowIndex(index: number, row: ThreadRow): string {
    return `${index}-${row.type}`;
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
      case 'Fork':
        this.openHandoff('fork');
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

  protected pickCommand(command: Command & { readonly isSpence?: boolean }): void {
    if (command.name === 'clear' && command.isSpence) {
      void this.onClear();
      return;
    }
    if (command.name === 'compact' && this.supportsCompaction()) {
      void this.onCompact();
      return;
    }
    this.draft.set(`/${command.name} `);
    this.commandsOpen.set(false);
    this.composerInput()?.nativeElement.focus();
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
      binding: { key: 'k', mod: true, shift: true },
      allowInModal: true,
      when: () =>
        this.actionPickerOpen() || (!this.keymap.modalOpen() && this.following() !== 'failed'),
      run: () => {
        const picker = this.actionPicker();
        if (picker === undefined) return false;
        if (this.actionPickerOpen()) {
          picker.dismiss(true);
          return true;
        }
        const active = this.document.activeElement;
        picker.openWithOpener(active instanceof HTMLElement ? active : null);
        return true;
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
        if (target instanceof HTMLSelectElement) {
          try {
            target.showPicker();
          } catch {
            // showPicker may be unsupported in headless/test environments.
          }
        }
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
    return (
      root.querySelector<HTMLSelectElement>('select#model-picker') ??
      root.querySelector<HTMLElement>('[data-testid="effort-picker"] button, #effort-picker') ??
      root.querySelector<HTMLElement>('[data-testid="model-picker"], [data-testid="effort-picker"]')
    );
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
    const text = this.draft();
    const images = this.images();
    const trimmed = text.trim();
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
    const parts: Array<MessagePart> = [...imageParts(images)];
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
        this.carets.clear(this.sessionId());
      }
      this.messageSent.emit(this.sessionId());
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

  protected toggleInspector(): void {
    const next = !this.inspectorOpen();
    this.inspectorOpen.set(next);
    if (!next) {
      this.filesTrigger()?.nativeElement.focus();
    }
  }

  protected closeInspector(): void {
    this.inspectorOpen.set(false);
    this.filesTrigger()?.nativeElement.focus();
  }

  protected async onLocateProject(): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    const exit = await this.runtime.run(locateProject(projectId), { signal: this.aborts.signal });
    if (Exit.isSuccess(exit) && exit.value !== null) {
      this.projectPath.set(exit.value.path);
      this.folderMissing.set(exit.value.folderMissing);
    }
  }

  private async refreshProjectFolder(): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    const exit = await this.runtime.run(checkProject(projectId), { signal: this.aborts.signal });
    if (Exit.isSuccess(exit)) {
      this.projectPath.set(exit.value.path);
      this.folderMissing.set(exit.value.folderMissing);
    }
  }

  protected async onRefreshWorktrees(): Promise<void> {
    if (this.refreshingWorktrees()) return;
    let targetPath =
      this.effectiveWorktreeInventory()?.cwd ??
      this.worktreeBinding()?.expectedPath ??
      this.projectPath();
    if ((targetPath === null || targetPath === undefined) && this.projectId() !== null) {
      await this.refreshProjectFolder();
      targetPath = this.projectPath();
    }
    if (targetPath === null || targetPath === undefined) return;
    const projectId = this.projectId() ?? undefined;
    this.refreshingWorktrees.set(true);
    try {
      const exit = await this.runtime.run(refreshWorktrees(targetPath, projectId), {
        signal: this.aborts.signal,
      });
      if (!this.aborts.signal.aborted && Exit.isSuccess(exit)) {
        this.refreshedWorktrees.set(exit.value);
      }
    } finally {
      this.refreshingWorktrees.set(false);
    }
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
