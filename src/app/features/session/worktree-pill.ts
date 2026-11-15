import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmProgressImports } from '@ui/progress';
import { HlmTooltipImports } from '@ui/tooltip';
import { toast } from '@ui/toast';
import { Exit } from 'effect';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type {
  OperationId,
  OperationSnapshot,
} from '../../../shared/source-control/source-control.rpc';
import type { SessionLocateWorktreeResult } from '../../../shared/sessions/sessions.rpc';
import type {
  GitCapability,
  WorktreeBinding,
  WorktreeChangeSummary,
  WorktreeEntry,
  WorktreeId,
  WorktreeInventory,
  WorktreeLocateMismatchReason,
} from '../../../shared/worktrees/worktrees.rpc';
import { EffectRuntime } from '../../core/effect-runtime';
import { Keymap } from '../../core/keymap';
import { CreateWorktreeForm } from './create-worktree-form';
import {
  cancelSourceControlOperation,
  dismissSourceControlOperation,
  extractTypedRpcError,
  followSourceControlOperations,
  listSourceControlOperations,
  progressStepLabel,
  progressStepPercent,
  reconcileSourceControlOperation,
  upsertOperationSnapshot,
} from './worktree-operations';

type PillKind = 'git' | 'nonGit' | 'missing' | 'missingGit' | 'unsupported' | 'pending';

interface PillDisplay {
  readonly kind: PillKind;
  readonly label: string;
  readonly ariaLabel: string;
  readonly tooltip: string;
  readonly mono: boolean;
}

const formatHead = (entry: WorktreeEntry): string => {
  switch (entry.head._tag) {
    case 'Branch':
    case 'Unborn':
      return entry.head.branch;
    case 'Detached':
      return `@${entry.head.commit.slice(0, 7)}`;
  }
};

const formatCapabilityLabel = (
  binding: WorktreeBinding | undefined,
  capability: GitCapability | undefined,
  worktrees: ReadonlyArray<WorktreeEntry>,
  currentWorktreeId: WorktreeInventory['currentWorktreeId'],
): PillDisplay => {
  if (binding?.state === 'missing') {
    const label =
      binding.reason === 'ReplacedFolder'
        ? $localize`Worktree replaced`
        : $localize`Worktree missing`;
    return {
      kind: 'missing',
      label,
      ariaLabel: $localize`Session Worktree: ${label}`,
      tooltip:
        binding.detail ??
        binding.expectedPath ??
        $localize`Bound Worktree is missing; Send is disabled.`,
      mono: false,
    };
  }

  if (capability !== undefined) {
    switch (capability._tag) {
      case 'MissingGit': {
        const label = $localize`Git unavailable`;
        return {
          kind: 'missingGit',
          label,
          ariaLabel: $localize`Session Worktree: ${label}`,
          tooltip: capability.detail,
          mono: false,
        };
      }
      case 'UnsupportedRepo': {
        const label = $localize`Unsupported repo`;
        return {
          kind: 'unsupported',
          label,
          ariaLabel: $localize`Session Worktree: ${label}`,
          tooltip: capability.detail,
          mono: false,
        };
      }
      case 'MissingPath': {
        const label = $localize`Folder missing`;
        return {
          kind: 'missing',
          label,
          ariaLabel: $localize`Session Worktree: ${label}`,
          tooltip: capability.detail,
          mono: false,
        };
      }
      case 'Available': {
        const activeId = currentWorktreeId ?? binding?.worktreeId;
        const current = worktrees.find((w) => w.id === activeId);
        const branchLabel =
          current !== undefined
            ? formatHead(current)
            : (binding?.lastKnownBranch ?? currentWorktreeId);
        if (branchLabel !== undefined && branchLabel !== '') {
          return {
            kind: 'git',
            label: branchLabel,
            ariaLabel: $localize`Session Worktree: ${branchLabel}`,
            tooltip: current?.path ?? binding?.expectedPath ?? $localize`Session Worktree`,
            mono: true,
          };
        }
        const fallback = $localize`Git repository`;
        return {
          kind: 'git',
          label: fallback,
          ariaLabel: $localize`Session Worktree: ${fallback}`,
          tooltip: binding?.expectedPath ?? $localize`Session Worktree`,
          mono: false,
        };
      }
      case 'NonGit': {
        const label = $localize`Local folder`;
        return {
          kind: 'nonGit',
          label,
          ariaLabel: $localize`Session Worktree: ${label}`,
          tooltip: capability.detail,
          mono: false,
        };
      }
    }
  }

  if (binding?.state === 'resolved' && binding.reason !== 'NonGit') {
    const branchLabel = binding.lastKnownBranch ?? binding.expectedPath;
    if (branchLabel !== undefined && branchLabel !== '') {
      return {
        kind: 'git',
        label: branchLabel,
        ariaLabel: $localize`Session Worktree: ${branchLabel}`,
        tooltip: binding.expectedPath ?? branchLabel,
        mono: true,
      };
    }
  }

  if (binding?.state === 'undiscovered' && binding.reason === 'MissingGit') {
    const label = $localize`Git unavailable`;
    return {
      kind: 'missingGit',
      label,
      ariaLabel: $localize`Session Worktree: ${label}`,
      tooltip: binding.detail ?? $localize`Git executable was not found on PATH.`,
      mono: false,
    };
  }

  const label = $localize`Local folder`;
  return {
    kind: 'nonGit',
    label,
    ariaLabel: $localize`Session Worktree: ${label}`,
    tooltip: binding?.expectedPath ?? $localize`Session Worktree`,
    mono: false,
  };
};

/**
 * Composer-bottom Worktree status pill and `Session Worktree` modal (discovery, creation, operations, recovery).
 */
@Component({
  selector: 'app-worktree-pill',
  imports: [
    HlmButtonImports,
    HlmDialogImports,
    HlmProgressImports,
    HlmTooltipImports,
    CreateWorktreeForm,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex items-center' },
  template: `
    <button
      #pillButton
      type="button"
      data-testid="worktree-pill"
      class="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      [class.font-mono]="pill().mono"
      [class.font-normal]="pill().mono"
      [class.font-sans]="!pill().mono"
      [class.text-destructive]="pill().kind === 'missing'"
      [class.text-muted-foreground]="pill().kind !== 'missing'"
      [class.hover:text-foreground]="pill().kind !== 'missing'"
      [hlmTooltip]="pill().tooltip"
      [attr.aria-label]="pill().ariaLabel"
      aria-haspopup="dialog"
      [attr.aria-expanded]="dialogOpen()"
      (click)="open(pillButton)"
    >
      @if (pill().kind === 'git') {
        <svg
          aria-hidden="true"
          class="size-3 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="6" x2="6" y1="3" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      } @else if (pill().kind === 'missing') {
        <svg
          aria-hidden="true"
          class="size-3 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" x2="12" y1="8" y2="12" />
          <line x1="12" x2="12.01" y1="16" y2="16" />
        </svg>
      } @else {
        <svg
          aria-hidden="true"
          class="size-3 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"
          />
        </svg>
      }
      <span>{{ pill().label }}</span>
      @if (currentChanges(); as changes) {
        @if (changes.changedFiles > 0) {
          <span
            class="text-muted-foreground font-sans text-xs tabular-nums"
            data-testid="worktree-pill-changes"
          >
            +{{ changes.additions }} −{{ changes.deletions }}
          </span>
        }
      }
    </button>

    <hlm-dialog
      [state]="dialogOpen() ? 'open' : 'closed'"
      (stateChanged)="onDialogStateChange($event)"
    >
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[85vh] overflow-y-auto sm:max-w-lg"
        data-testid="worktree-dialog"
        closeLabel="Close"
        i18n-closeLabel
      >
        <hlm-dialog-header>
          <h2 hlmDialogTitle class="text-base font-medium" i18n>Session Worktree</h2>
          <p hlmDialogDescription i18n>
            Switch this Session's Worktree, inspect changes, or locate a moved checkout.
          </p>
        </hlm-dialog-header>

        <div class="flex flex-col gap-3">
          @if (viewMode() === 'create' && sourcePath(); as sp) {
            <app-create-worktree-form
              [sourcePath]="sp"
              [projectId]="projectId()"
              [operations]="operations()"
              (cancelled)="viewMode.set('list')"
              (operationUpserted)="onOperationUpserted($event)"
              (inventoryUpdated)="inventoryUpdated.emit($event)"
              (completed)="onCreateCompleted($event)"
            />
          } @else {
            @if (locateMismatch(); as mismatch) {
              <div
                class="border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-md border p-3 text-xs"
                data-testid="worktree-rebind-confirm"
              >
                <p class="text-destructive font-medium">
                  {{ mismatchReasonLabel(mismatch.mismatchReason) }}
                </p>
                <p class="text-foreground">{{ mismatch.detail }}</p>
                <code class="text-muted-foreground font-mono text-xs font-normal break-all">
                  {{ mismatch.candidatePath }}
                </code>
                <p class="text-muted-foreground" i18n>
                  Rebinding changes only this Session and starts a fresh Agent context. Other
                  Sessions keep their existing bindings.
                </p>
                <div class="flex flex-wrap justify-end gap-2 pt-1">
                  <button
                    hlmBtn
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="worktree-rebind-cancel"
                    [disabled]="locating()"
                    (click)="dismissRebindRequested.emit()"
                    i18n
                  >
                    Cancel
                  </button>
                  <button
                    hlmBtn
                    type="button"
                    variant="destructive"
                    size="sm"
                    data-testid="worktree-rebind-confirm-btn"
                    [disabled]="busy() || locating()"
                    (click)="confirmRebindRequested.emit(mismatch.candidatePath)"
                    i18n
                  >
                    Rebind this Session
                  </button>
                </div>
              </div>
            }

            @if (binding(); as currentBinding) {
              @if (currentBinding.state === 'missing') {
                <div
                  class="border-destructive/30 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3 text-xs"
                  data-testid="worktree-missing-detail"
                >
                  <p class="text-destructive font-medium">
                    @if (currentBinding.reason === 'ReplacedFolder') {
                      <span i18n>Bound Worktree folder was replaced</span>
                    } @else {
                      <span i18n>Bound Worktree is missing</span>
                    }
                  </p>
                  @if (currentBinding.detail; as detail) {
                    <p class="text-foreground">{{ detail }}</p>
                  }
                  @if (currentBinding.expectedPath; as expectedPath) {
                    <code class="text-muted-foreground font-mono font-normal text-xs break-all">
                      {{ expectedPath }}
                    </code>
                  }
                  <p class="text-muted-foreground" i18n>
                    Sending is disabled while this Worktree binding is unresolved. Existing messages
                    remain readable.
                  </p>
                </div>
              }
            }

            @for (op of visibleRecoveryOperations(); track op.id) {
              <div
                class="border-destructive/30 bg-destructive/5 flex flex-col gap-2 rounded-md border p-3 text-xs"
                data-testid="worktree-operation-recovery"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-destructive font-medium">{{ op.title }}</span>
                  <span class="text-muted-foreground font-mono font-normal text-xs">
                    {{ op.outcome ?? op.phase }}
                  </span>
                </div>
                @if (op.recovery; as rec) {
                  <p class="text-foreground font-medium">{{ rec.summary }}</p>
                  <p class="text-muted-foreground">{{ rec.detail }}</p>
                  <div class="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                    <span>
                      @if (rec.observedFolderExists) {
                        <span i18n>Folder exists</span>
                      } @else {
                        <span i18n>Folder missing</span>
                      }
                    </span>
                    <span>
                      @if (rec.observedRegisteredInGit) {
                        <span i18n>Registered in Git</span>
                      } @else {
                        <span i18n>Not registered in Git</span>
                      }
                    </span>
                    <span>
                      @if (rec.observedBranchExists) {
                        <span i18n>Branch exists</span>
                      } @else {
                        <span i18n>Branch missing</span>
                      }
                    </span>
                  </div>
                  <div class="flex flex-wrap gap-2 pt-1">
                    @if (rec.canReconcile) {
                      <button
                        hlmBtn
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="worktree-op-reconcile"
                        [disabled]="recoveryActionId() === op.id"
                        (click)="onReconcile(op.id)"
                        i18n
                      >
                        Reconcile
                      </button>
                    }
                    @if (rec.canDismiss) {
                      <button
                        hlmBtn
                        type="button"
                        variant="secondary"
                        size="sm"
                        data-testid="worktree-op-dismiss"
                        [disabled]="recoveryActionId() === op.id"
                        (click)="onDismiss(op.id)"
                        i18n
                      >
                        Dismiss
                      </button>
                    }
                  </div>
                } @else if (op.unknownReason ?? op.errorDetail; as detail) {
                  <p class="text-foreground">{{ detail }}</p>
                }
              </div>
            }

            @for (op of visibleActiveOperations(); track op.id) {
              <div
                class="border-border bg-muted/40 flex flex-col gap-1.5 rounded-md border p-3 text-xs"
                data-testid="worktree-operation-active"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="font-medium">{{ op.title }}</span>
                  <span class="text-muted-foreground">{{ stepLabel(op) }}</span>
                </div>
                <hlm-progress [value]="stepPercent(op)">
                  <hlm-progress-indicator />
                </hlm-progress>
                @if (op.progress?.detail; as detail) {
                  <p class="text-muted-foreground">{{ detail }}</p>
                }
                @if (op.phase === 'Prepared') {
                  <div>
                    <button
                      hlmBtn
                      type="button"
                      variant="secondary"
                      size="sm"
                      [disabled]="recoveryActionId() === op.id"
                      (click)="onCancelOp(op.id)"
                      i18n
                    >
                      Cancel
                    </button>
                  </div>
                }
              </div>
            }

            @if (inventory()?.capability; as cap) {
              @switch (cap._tag) {
                @case ('MissingGit') {
                  <div
                    class="bg-muted flex flex-col gap-1 rounded-md p-3 text-xs"
                    data-testid="worktree-missing-git-detail"
                  >
                    <p class="font-medium" i18n>Git executable not found</p>
                    <p class="text-muted-foreground">{{ cap.detail }}</p>
                    <p class="text-muted-foreground" i18n>
                      Install Git or ensure it is on PATH, then refresh to discover Worktrees.
                    </p>
                  </div>
                }
                @case ('UnsupportedRepo') {
                  <div
                    class="bg-muted flex flex-col gap-1 rounded-md p-3 text-xs"
                    data-testid="worktree-unsupported-detail"
                  >
                    <p class="font-medium" i18n>Unsupported Git repository</p>
                    <p class="text-muted-foreground">{{ cap.detail }}</p>
                  </div>
                }
                @case ('NonGit') {
                  @if (binding()?.state !== 'missing') {
                    <div
                      class="bg-muted flex flex-col gap-1 rounded-md p-3 text-xs"
                      data-testid="worktree-non-git-detail"
                    >
                      <p class="font-medium" i18n>Local folder (not a Git repository)</p>
                      <code class="text-muted-foreground font-mono font-normal text-xs break-all">
                        {{ cap.path }}
                      </code>
                    </div>
                  }
                }
                @case ('MissingPath') {
                  @if (binding()?.state !== 'missing') {
                    <div
                      class="border-destructive/30 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3 text-xs"
                      data-testid="worktree-missing-path-detail"
                    >
                      <p class="text-destructive font-medium" i18n>Folder not found</p>
                      <code class="text-muted-foreground font-mono font-normal text-xs break-all">
                        {{ cap.path }}
                      </code>
                    </div>
                  }
                }
                @default {}
              }
            }

            @if (worktrees().length > 0) {
              <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between gap-2">
                  <p class="text-muted-foreground text-xs" i18n>Discovered Worktrees</p>
                </div>
                @if (busy()) {
                  <p class="text-muted-foreground text-xs" data-testid="worktree-busy-note" i18n>
                    Finish or cancel the active Turn before switching or locating Worktrees.
                  </p>
                }
                @for (entry of worktrees(); track entry.id) {
                  @let sessionCount = sessionCountFor(entry);
                  <div
                    class="border-border flex items-start justify-between gap-2 rounded-md border px-3 py-2"
                    data-testid="worktree-entry"
                  >
                    <div class="flex min-w-0 flex-col gap-0.5">
                      <span class="truncate font-mono text-xs font-normal">
                        {{ headText(entry) }}
                      </span>
                      <span class="text-muted-foreground font-mono text-xs font-normal break-all">
                        {{ entry.path }}
                      </span>
                      <div
                        class="text-muted-foreground font-sans flex flex-wrap items-center gap-2 pt-0.5 text-xs tabular-nums"
                      >
                        @if (sessionCount > 0) {
                          <span data-testid="worktree-entry-sessions">
                            @if (sessionCount === 1) {
                              <ng-container i18n>1 Session</ng-container>
                            } @else {
                              <ng-container i18n>{{ sessionCount }} Sessions</ng-container>
                            }
                          </span>
                        }
                        @if (entry.changes; as changes) {
                          <span data-testid="worktree-entry-changes">
                            @if (changes.changedFiles === 0) {
                              <ng-container i18n>Clean</ng-container>
                            } @else {
                              <ng-container i18n>{{ changes.changedFiles }} changed</ng-container>
                              @if (changes.additions > 0 || changes.deletions > 0) {
                                <span> · +{{ changes.additions }} −{{ changes.deletions }}</span>
                              }
                            }
                          </span>
                        }
                      </div>
                    </div>
                    <div class="flex shrink-0 flex-wrap items-center gap-1.5 text-xs">
                      @if (isCurrent(entry)) {
                        <span class="bg-muted text-foreground rounded px-1.5 py-0.5" i18n>
                          Current
                        </span>
                      }
                      @if (entry.isPrimary) {
                        <span class="text-muted-foreground" i18n>Primary</span>
                      }
                      @if (entry.missing) {
                        <span class="text-destructive" i18n>Missing</span>
                      }
                      @if (entry.lockedReason !== undefined) {
                        <span class="text-muted-foreground" i18n>Locked</span>
                      }
                      @if (!isCurrent(entry) && !entry.missing) {
                        <button
                          hlmBtn
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="worktree-switch"
                          [attr.data-worktree-id]="entry.id"
                          [disabled]="busy() || switching()"
                          (click)="switchRequested.emit(entry)"
                          i18n
                        >
                          Switch
                        </button>
                      }
                    </div>
                  </div>
                }
              </div>
            }
          }
        </div>

        @if (viewMode() === 'list') {
          <hlm-dialog-footer>
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="worktree-locate"
              [disabled]="busy() || locating()"
              (click)="locateRequested.emit()"
            >
              @if (locating()) {
                <span i18n>Locating…</span>
              } @else {
                <span i18n>Locate…</span>
              }
            </button>
            @if (canCreateWorktree()) {
              <button
                hlmBtn
                type="button"
                variant="default"
                size="sm"
                data-testid="worktree-create"
                (click)="viewMode.set('create')"
                i18n
              >
                Create Worktree…
              </button>
            }
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="worktree-refresh"
              [disabled]="refreshing()"
              (click)="refreshRequested.emit()"
            >
              @if (refreshing()) {
                <span i18n>Refreshing…</span>
              } @else {
                <span i18n>Refresh</span>
              }
            </button>
            <button
              hlmBtn
              type="button"
              variant="secondary"
              size="sm"
              data-testid="worktree-close"
              (click)="close()"
              i18n
            >
              Close
            </button>
          </hlm-dialog-footer>
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class WorktreePill {
  private readonly document = inject(DOCUMENT);
  private readonly keymap = inject(Keymap);
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyRef = inject(DestroyRef);
  private readonly hostAborts = new AbortController();
  private readonly pillButton = viewChild<ElementRef<HTMLButtonElement>>('pillButton');

  readonly binding = input<WorktreeBinding | undefined>(undefined);
  readonly inventory = input<WorktreeInventory | undefined>(undefined);
  readonly projectId = input<ProjectId | undefined>(undefined);
  readonly sessionCounts = input<Partial<Record<WorktreeId, number>> | undefined>(undefined);
  readonly refreshing = input<boolean>(false);
  readonly busy = input<boolean>(false);
  readonly switching = input<boolean>(false);
  readonly locating = input<boolean>(false);
  readonly locateMismatch = input<Extract<
    SessionLocateWorktreeResult,
    { _tag: 'RequiresRebind' }
  > | null>(null);

  readonly refreshRequested = output<void>();
  readonly inventoryUpdated = output<WorktreeInventory>();
  readonly switchRequested = output<WorktreeEntry>();
  readonly locateRequested = output<void>();
  readonly confirmRebindRequested = output<string>();
  readonly dismissRebindRequested = output<void>();

  protected readonly dialogOpen = signal(false);
  protected readonly viewMode = signal<'list' | 'create'>('list');
  protected readonly operations = signal<ReadonlyArray<OperationSnapshot>>([]);
  protected readonly recoveryActionId = signal<OperationId | null>(null);
  private opener: HTMLElement | null = null;

  protected readonly worktrees = computed(() => this.inventory()?.worktrees ?? []);
  protected readonly sourcePath = computed(
    () => this.inventory()?.cwd ?? this.binding()?.expectedPath ?? null,
  );
  protected readonly canCreateWorktree = computed(
    () =>
      this.inventory()?.capability._tag === 'Available' &&
      this.binding()?.state !== 'missing' &&
      this.sourcePath() !== null,
  );

  protected readonly visibleRecoveryOperations = computed(() =>
    this.operations().filter((op) => op.phase === 'NeedsRecovery'),
  );
  protected readonly visibleActiveOperations = computed(() =>
    this.operations().filter(
      (op) =>
        op.phase === 'Prepared' ||
        op.phase === 'Applying' ||
        op.phase === 'LocalRestored' ||
        op.phase === 'TranscriptFinalizing',
    ),
  );
  protected readonly currentChanges = computed<WorktreeChangeSummary | undefined>(() => {
    if (this.binding()?.state === 'missing') return undefined;
    const activeId = this.inventory()?.currentWorktreeId ?? this.binding()?.worktreeId;
    if (activeId === undefined) return undefined;
    return this.worktrees().find((w) => w.id === activeId)?.changes;
  });

  protected readonly pill = computed(() =>
    formatCapabilityLabel(
      this.binding(),
      this.inventory()?.capability,
      this.worktrees(),
      this.inventory()?.currentWorktreeId,
    ),
  );

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.hostAborts.abort();
    });
    effect((onCleanup) => {
      if (!this.dialogOpen()) return;
      const opener =
        this.opener ??
        (this.document.activeElement as HTMLElement | null) ??
        this.pillButton()?.nativeElement ??
        null;
      const release = this.keymap.pushModal({
        opener,
        onEscape: () => this.close(),
      });
      const streamAborts = new AbortController();
      void this.loadOperations(streamAborts.signal);
      void this.followOperations(streamAborts.signal);
      onCleanup(() => {
        streamAborts.abort();
        release();
        if (!this.dialogOpen()) this.opener = null;
      });
    });
  }

  /** Opens the Worktree modal, requests an inventory refresh, and remembers `opener` for focus restore. */
  open(opener?: HTMLElement | null): void {
    this.opener = opener ?? this.pillButton()?.nativeElement ?? null;
    this.viewMode.set('list');
    this.dialogOpen.set(true);
    this.refreshRequested.emit();
  }

  /** Closes the Worktree modal cleanly. */
  close(): void {
    this.viewMode.set('list');
    this.dialogOpen.set(false);
  }

  protected onDialogStateChange(state: 'open' | 'closed'): void {
    if (state === 'closed') this.viewMode.set('list');
    this.dialogOpen.set(state === 'open');
  }

  protected headText(entry: WorktreeEntry): string {
    return formatHead(entry);
  }

  protected isCurrent(entry: WorktreeEntry): boolean {
    const activeId = this.inventory()?.currentWorktreeId ?? this.binding()?.worktreeId;
    return activeId !== undefined && entry.id === activeId;
  }

  protected stepLabel(op: OperationSnapshot): string {
    return progressStepLabel(op.progress?.step ?? 'Preparing');
  }

  protected stepPercent(op: OperationSnapshot): number {
    return progressStepPercent(op.progress?.step ?? 'Preparing');
  }

  protected onOperationUpserted(snapshot: OperationSnapshot): void {
    this.operations.update((prev) => upsertOperationSnapshot(prev, snapshot));
  }

  protected onCreateCompleted(outcome: { readonly recoveryNeeded: boolean }): void {
    void outcome;
    this.viewMode.set('list');
  }

  protected async onReconcile(operationId: OperationId): Promise<void> {
    if (this.recoveryActionId() !== null) return;
    this.recoveryActionId.set(operationId);
    const exit = await this.runtime.run(reconcileSourceControlOperation(operationId), {
      signal: this.hostAborts.signal,
    });
    if (this.hostAborts.signal.aborted) return;
    this.recoveryActionId.set(null);
    if (Exit.isSuccess(exit)) {
      this.onOperationUpserted(exit.value);
      if (exit.value.outcome === 'Succeeded') {
        toast.success($localize`Worktree state verified.`);
        this.refreshRequested.emit();
      } else {
        toast.error(
          exit.value.recovery?.summary ??
            exit.value.errorDetail ??
            $localize`Reconciliation still needs inspection.`,
        );
      }
      return;
    }
    const err = extractTypedRpcError(exit.cause);
    toast.error(err?.detail || $localize`Failed to reconcile Worktree operation.`);
  }

  protected async onDismiss(operationId: OperationId): Promise<void> {
    if (this.recoveryActionId() !== null) return;
    this.recoveryActionId.set(operationId);
    const exit = await this.runtime.run(dismissSourceControlOperation(operationId), {
      signal: this.hostAborts.signal,
    });
    if (this.hostAborts.signal.aborted) return;
    this.recoveryActionId.set(null);
    if (Exit.isSuccess(exit)) {
      this.onOperationUpserted(exit.value);
      toast.success($localize`Dismissed operation notice.`);
      return;
    }
    const err = extractTypedRpcError(exit.cause);
    toast.error(err?.detail || $localize`Failed to dismiss operation.`);
  }

  protected async onCancelOp(operationId: OperationId): Promise<void> {
    if (this.recoveryActionId() !== null) return;
    this.recoveryActionId.set(operationId);
    const exit = await this.runtime.run(cancelSourceControlOperation(operationId), {
      signal: this.hostAborts.signal,
    });
    if (this.hostAborts.signal.aborted) return;
    this.recoveryActionId.set(null);
    if (Exit.isSuccess(exit)) {
      this.onOperationUpserted(exit.value);
      return;
    }
    const err = extractTypedRpcError(exit.cause);
    toast.error(err?.detail || $localize`Unable to cancel running operation.`);
  }

  private matchesCurrentRepo(op: OperationSnapshot): boolean {
    const repoKey = this.inventory()?.repositoryId;
    if (op.repositoryKey !== undefined && repoKey !== undefined) {
      return op.repositoryKey === repoKey;
    }
    const cwd = this.sourcePath();
    if (op.sourcePath !== undefined && cwd !== null) {
      return op.sourcePath === cwd;
    }
    return true;
  }

  private async loadOperations(signal: AbortSignal): Promise<void> {
    const repoKey = this.inventory()?.repositoryId;
    const src = this.sourcePath();
    const exit = await this.runtime.run(
      listSourceControlOperations({
        ...(repoKey === undefined ? {} : { repositoryKey: repoKey }),
        ...(src === null ? {} : { sourcePath: src }),
      }),
      { signal },
    );
    if (signal.aborted || !Exit.isSuccess(exit)) return;
    const relevant = exit.value.filter((op) => this.matchesCurrentRepo(op));
    this.operations.set([...relevant].sort((a, b) => b.updatedAt - a.updatedAt));
  }

  private async followOperations(signal: AbortSignal): Promise<void> {
    await this.runtime.run(
      followSourceControlOperations((snapshot) => {
        if (!this.matchesCurrentRepo(snapshot)) return;
        this.onOperationUpserted(snapshot);
        if (snapshot.phase === 'Completed' && snapshot.outcome === 'Succeeded') {
          this.refreshRequested.emit();
        }
      }),
      { signal },
    );
  }

  protected sessionCountFor(entry: WorktreeEntry): number {
    return this.sessionCounts()?.[entry.id] ?? 0;
  }

  protected mismatchReasonLabel(reason: WorktreeLocateMismatchReason): string {
    switch (reason) {
      case 'DifferentRepository':
        return $localize`Different Git repository`;
      case 'DifferentCheckout':
        return $localize`Different Worktree checkout`;
      case 'UnregisteredWorktree':
        return $localize`Unregistered Worktree folder`;
      case 'ReplacedFolder':
        return $localize`Replaced folder`;
      case 'NonGit':
        return $localize`Folder is not a Git repository`;
      case 'MissingPath':
        return $localize`Folder no longer exists`;
      case 'MissingGit':
        return $localize`Git executable unavailable`;
      case 'UnsupportedRepo':
        return $localize`Unsupported Git repository`;
      case 'NoPriorIdentity':
        return $localize`Worktree identity could not be verified`;
    }
  }
}
