import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { HlmTooltipImports } from '@ui/tooltip';
import type {
  GitCapability,
  WorktreeBinding,
  WorktreeEntry,
  WorktreeInventory,
} from '../../../shared/worktrees/worktrees.rpc';
import { Keymap } from '../../core/keymap';

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
 * Quiet Composer-bottom Worktree status control and read-only `Session Worktree` modal (#98).
 */
@Component({
  selector: 'app-worktree-pill',
  imports: [HlmButtonImports, HlmDialogImports, HlmTooltipImports],
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
          <p hlmDialogDescription i18n>Git repository and Worktrees discovered for this Session.</p>
        </hlm-dialog-header>

        <div class="flex flex-col gap-3">
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
              <p class="text-muted-foreground text-xs" i18n>Discovered Worktrees</p>
              @for (entry of worktrees(); track entry.id) {
                <div
                  class="border-border flex items-start justify-between gap-2 rounded-md border px-3 py-2"
                  data-testid="worktree-entry"
                >
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate font-mono font-normal text-xs">
                      {{ headText(entry) }}
                    </span>
                    <span class="text-muted-foreground font-mono font-normal text-xs break-all">
                      {{ entry.path }}
                    </span>
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
                  </div>
                </div>
              }
            </div>
          }
        </div>

        <hlm-dialog-footer>
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
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class WorktreePill {
  private readonly document = inject(DOCUMENT);
  private readonly keymap = inject(Keymap);
  private readonly pillButton = viewChild<ElementRef<HTMLButtonElement>>('pillButton');

  readonly binding = input<WorktreeBinding | undefined>(undefined);
  readonly inventory = input<WorktreeInventory | undefined>(undefined);
  readonly refreshing = input<boolean>(false);

  readonly refreshRequested = output<void>();

  protected readonly dialogOpen = signal(false);
  private opener: HTMLElement | null = null;

  protected readonly worktrees = computed(() => this.inventory()?.worktrees ?? []);

  protected readonly pill = computed(() =>
    formatCapabilityLabel(
      this.binding(),
      this.inventory()?.capability,
      this.worktrees(),
      this.inventory()?.currentWorktreeId,
    ),
  );

  constructor() {
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
      onCleanup(() => {
        release();
        if (!this.dialogOpen()) this.opener = null;
      });
    });
  }

  /** Opens the Worktree modal, requests an inventory refresh, and remembers `opener` for focus restore. */
  open(opener?: HTMLElement | null): void {
    this.opener = opener ?? this.pillButton()?.nativeElement ?? null;
    this.dialogOpen.set(true);
    this.refreshRequested.emit();
  }

  /** Closes the Worktree modal cleanly. */
  close(): void {
    this.dialogOpen.set(false);
  }

  protected onDialogStateChange(state: 'open' | 'closed'): void {
    this.dialogOpen.set(state === 'open');
  }

  protected headText(entry: WorktreeEntry): string {
    return formatHead(entry);
  }

  protected isCurrent(entry: WorktreeEntry): boolean {
    const activeId = this.inventory()?.currentWorktreeId ?? this.binding()?.worktreeId;
    return activeId !== undefined && entry.id === activeId;
  }
}
