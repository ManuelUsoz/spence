import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmInputImports } from '@ui/input';
import { HlmKbdImports } from '@ui/kbd';
import { HlmTooltipImports } from '@ui/tooltip';
import type { LiveState } from '../../../shared/sessions/sessions.rpc';
import { Keymap } from '../../core/keymap';

/** Context & handoff operations exposed in the Session action picker. */
export type SessionOperation = 'Compact' | 'Clear' | 'Switch Agent' | 'Fork';

interface PickerAction {
  readonly id: string;
  readonly operation: SessionOperation;
  readonly label: string;
  readonly description: string;
  readonly command?: string;
  readonly disabled: boolean;
  readonly reason?: string;
}

/** Quiet Composer launcher + searchable popover for Session context/handoff actions (`Mod+Shift+K`). */
@Component({
  selector: 'app-session-action-picker',
  imports: [HlmButtonImports, HlmInputImports, HlmKbdImports, HlmTooltipImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative inline-flex items-center' },
  template: `
    <button
      #triggerButton
      hlmBtn
      type="button"
      variant="ghost"
      size="icon"
      data-testid="session-actions-trigger"
      [hlmTooltip]="triggerTip"
      aria-label="Session actions"
      i18n-aria-label
      aria-haspopup="dialog"
      [attr.aria-expanded]="open()"
      (click)="toggleFromTrigger()"
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
        <line x1="21" x2="14" y1="4" y2="4" />
        <line x1="10" x2="3" y1="4" y2="4" />
        <line x1="21" x2="12" y1="12" y2="12" />
        <line x1="8" x2="3" y1="12" y2="12" />
        <line x1="21" x2="16" y1="20" y2="20" />
        <line x1="12" x2="3" y1="20" y2="20" />
        <line x1="14" x2="14" y1="2" y2="6" />
        <line x1="8" x2="8" y1="10" y2="14" />
        <line x1="16" x2="16" y1="18" y2="22" />
      </svg>
    </button>

    <ng-template #triggerTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>Session actions</span>
        <kbd hlmKbd class="font-mono font-normal">{{ shortcutLabel() }}</kbd>
      </span>
    </ng-template>

    @if (open()) {
      <div class="fixed inset-0 z-40" (click)="dismiss(true)"></div>
      <div
        class="bg-popover text-popover-foreground border-border absolute right-0 bottom-full z-50 mb-2 w-80 rounded-lg border p-2 shadow-md"
        role="dialog"
        aria-label="Session actions"
        i18n-aria-label
        data-testid="session-actions-picker"
      >
        <input
          #searchInput
          hlmInput
          type="search"
          class="mb-2 h-8 text-sm"
          data-testid="session-actions-search"
          placeholder="Search session actions…"
          i18n-placeholder
          aria-label="Search session actions"
          i18n-aria-label
          [value]="query()"
          (input)="onQuery($any($event.target).value)"
          (keydown)="onSearchKeydown($event)"
        />

        @if (busyReason(); as notice) {
          <p
            class="text-muted-foreground mb-1.5 px-2 text-xs"
            data-testid="session-actions-busy-note"
          >
            {{ notice }}
          </p>
        }

        <div
          class="flex flex-col gap-0.5"
          role="listbox"
          aria-label="Session actions"
          i18n-aria-label
        >
          @for (action of filteredActions(); track action.id; let i = $index) {
            <button
              type="button"
              role="option"
              class="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors"
              [class]="
                action.disabled
                  ? i === clampedIndex()
                    ? 'bg-accent/50 text-muted-foreground cursor-not-allowed opacity-70'
                    : 'text-muted-foreground cursor-not-allowed opacity-70'
                  : i === clampedIndex()
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/60'
              "
              [disabled]="action.disabled"
              [attr.aria-selected]="i === clampedIndex()"
              [attr.data-testid]="'session-action-' + action.id"
              (mouseenter)="selectedIndex.set(i)"
              (click)="invoke(action)"
            >
              <span class="flex w-full items-center justify-between gap-2">
                <span class="font-medium">{{ action.label }}</span>
                @if (action.command; as command) {
                  <code class="text-muted-foreground font-mono text-xs">{{ command }}</code>
                }
              </span>
              <span class="text-muted-foreground text-xs">
                {{ action.reason ?? action.description }}
              </span>
            </button>
          } @empty {
            <p class="text-muted-foreground px-2.5 py-2 text-sm" i18n>No matching actions.</p>
          }
        </div>
      </div>
    }
  `,
})
export class SessionActionPicker {
  private readonly document = inject(DOCUMENT);
  private readonly keymap = inject(Keymap);
  private readonly triggerButton = viewChild<ElementRef<HTMLButtonElement>>('triggerButton');
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  readonly open = model(false);
  readonly running = input(false);
  readonly compacting = input(false);
  readonly clearing = input(false);
  readonly agentStatus = input<LiveState['agentStatus'] | undefined>(undefined);
  readonly supportsCompaction = input(false);
  readonly agentName = input('Agent');

  readonly invokeOperation = output<SessionOperation>();

  protected readonly query = signal('');
  protected readonly selectedIndex = signal(0);

  private modalRelease: (() => void) | null = null;
  private opener: HTMLElement | null = null;

  protected readonly shortcutLabel = computed(() =>
    this.keymap.format({ mod: true, shift: true, key: 'k' }),
  );

  private readonly busy = computed(() => this.running() || this.compacting() || this.clearing());

  protected readonly busyReason = computed(() => {
    if (!this.busy()) return null;
    if (this.compacting()) {
      return $localize`Compaction is running. Stop or wait for it to finish first.`;
    }
    if (this.clearing()) {
      return $localize`Context is clearing. Wait for it to finish first.`;
    }
    return $localize`A Turn is running. Wait for it to finish or stop it first.`;
  });

  protected readonly actions = computed<ReadonlyArray<PickerAction>>(() => {
    const busy = this.busy();
    const busyReason = this.busyReason() ?? undefined;
    const status = this.agentStatus();
    const readyOrStopped = status === 'ready' || status === 'stopped';
    const unavailableReason =
      status === 'starting'
        ? $localize`Wait until ${this.agentName()} finishes starting.`
        : !readyOrStopped
          ? $localize`${this.agentName()} is not ready.`
          : undefined;
    const compactSupported = this.supportsCompaction();

    return [
      {
        id: 'compact',
        operation: 'Compact',
        label: $localize`Compact`,
        description: $localize`Summarize earlier messages to free context space.`,
        ...(compactSupported ? { command: '/compact' } : {}),
        disabled: busy || !compactSupported || !readyOrStopped,
        ...(busyReason !== undefined
          ? { reason: busyReason }
          : !compactSupported
            ? { reason: $localize`${this.agentName()} doesn't offer compaction.` }
            : unavailableReason !== undefined
              ? { reason: unavailableReason }
              : {}),
      },
      {
        id: 'clear',
        operation: 'Clear',
        label: $localize`Clear`,
        description: $localize`Start a fresh context window for this Session.`,
        command: '/clear',
        disabled: busy || status === undefined,
        ...(busyReason !== undefined ? { reason: busyReason } : {}),
      },
      {
        id: 'switch-agent',
        operation: 'Switch Agent',
        label: $localize`Switch Agent`,
        description: $localize`Hand off this Session to another Agent.`,
        disabled: true,
        reason: busyReason ?? $localize`Coming soon.`,
      },
      {
        id: 'fork',
        operation: 'Fork',
        label: $localize`Fork`,
        description: $localize`Branch a new Session from this point.`,
        disabled: true,
        reason: busyReason ?? $localize`Coming soon.`,
      },
    ];
  });

  protected readonly filteredActions = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (needle === '') return this.actions();
    return this.actions().filter(
      (action) =>
        action.label.toLowerCase().includes(needle) ||
        action.operation.toLowerCase().includes(needle) ||
        action.description.toLowerCase().includes(needle) ||
        (action.command?.toLowerCase().includes(needle) ?? false),
    );
  });

  protected readonly clampedIndex = computed(() => {
    const count = this.filteredActions().length;
    if (count === 0) return 0;
    return Math.min(this.selectedIndex(), count - 1);
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const opener = this.opener ?? (this.document.activeElement as HTMLElement | null);
      this.opener = opener;
      this.query.set('');
      this.selectedIndex.set(0);
      this.modalRelease = this.keymap.pushModal({
        opener,
        restoreFocus: false,
        onEscape: () => this.dismiss(true),
      });
      queueMicrotask(() => {
        if (this.open()) {
          this.searchInput()?.nativeElement.focus({ preventScroll: true });
        }
      });
      onCleanup(() => {
        this.modalRelease?.();
        this.modalRelease = null;
      });
    });
  }

  /** Opens the picker, remembering `opener` to restore focus on Esc dismissal. */
  openWithOpener(opener: HTMLElement | null): void {
    this.opener = opener;
    this.open.set(true);
  }

  /** Closes the picker, optionally restoring focus to the opener synchronously. */
  dismiss(restoreFocus: boolean): void {
    const target = this.opener;
    this.opener = null;
    this.open.set(false);
    this.modalRelease?.();
    this.modalRelease = null;
    if (restoreFocus && target !== null && target.isConnected) {
      target.focus({ preventScroll: true });
    }
  }

  protected toggleFromTrigger(): void {
    if (this.open()) {
      this.dismiss(true);
      return;
    }
    this.openWithOpener(this.triggerButton()?.nativeElement ?? null);
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    this.selectedIndex.set(0);
  }

  protected onSearchKeydown(event: KeyboardEvent): void {
    const list = this.filteredActions();
    switch (event.key) {
      case 'ArrowDown': {
        if (list.length === 0) return;
        event.preventDefault();
        this.selectedIndex.set((this.clampedIndex() + 1) % list.length);
        return;
      }
      case 'ArrowUp': {
        if (list.length === 0) return;
        event.preventDefault();
        this.selectedIndex.set((this.clampedIndex() - 1 + list.length) % list.length);
        return;
      }
      case 'Enter': {
        const selected = list[this.clampedIndex()];
        if (selected === undefined || selected.disabled) return;
        event.preventDefault();
        this.invoke(selected);
        return;
      }
    }
  }

  protected invoke(action: PickerAction): void {
    if (action.disabled) return;
    this.dismiss(false);
    this.invokeOperation.emit(action.operation);
  }
}
