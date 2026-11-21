import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmKbdImports } from '@ui/kbd';
import { HlmProgressImports } from '@ui/progress';
import { HlmTooltipImports } from '@ui/tooltip';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { PaneId } from '../../../shared/tabs/tabs.rpc';
import { Keymap } from '../../core/keymap';
import { SessionToolbar } from '../../core/session-toolbar';
import { Tabs } from '../../core/tabs';
import { SessionsState, type SessionTarget } from './sessions-state';

/**
 * Per-Session `⋯` actions menu in `PanelHeader`: context usage bar, toolbar actions,
 * Rename / Archive / Delete, `Add to stack`, and the `Mod+Shift+K` shortcut.
 */
@Component({
  selector: 'app-panel-session-actions',
  imports: [
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmKbdImports,
    HlmProgressImports,
    HlmTooltipImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (hasMenu()) {
      <button
        #actionsTrigger
        hlmBtn
        type="button"
        variant="ghost"
        size="icon"
        data-testid="session-actions-trigger"
        class="text-muted-foreground"
        aria-label="Session actions"
        i18n-aria-label
        aria-haspopup="menu"
        [hlmTooltip]="actionsTip"
        [hlmDropdownMenuTrigger]="actionsMenu"
      >
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
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </svg>
      </button>
    }

    <ng-template #actionsMenu>
      <hlm-dropdown-menu class="w-72 rounded-xl" data-testid="session-actions-menu">
        @if (toolbarEntry(); as entry) {
          @let context = entry.context();
          <div class="flex flex-col gap-1.5 px-2.5 pt-1.5 pb-2" data-testid="session-context">
            <div class="text-muted-foreground flex justify-between text-xs tabular-nums">
              <span i18n>Context</span>
              <span data-testid="session-context-label">{{ context.label }}</span>
            </div>
            @if (context.fraction !== null) {
              <hlm-progress
                aria-hidden="true"
                [value]="contextPercent(context.fraction)"
                [max]="100"
                class="bg-accent h-1 rounded-full"
                data-testid="session-context-progress"
              >
                <hlm-progress-indicator class="bg-muted-foreground rounded-full" />
              </hlm-progress>
            }
          </div>
          @for (action of entry.actions(); track action.id) {
            <button
              type="button"
              hlmDropdownMenuItem
              class="h-auto min-h-8 py-1.5"
              [disabled]="action.disabled"
              [attr.data-testid]="'session-action-' + action.id"
              (triggered)="entry.run(action.operation)"
            >
              <span class="flex min-w-0 flex-1 flex-col text-left">
                <span>{{ action.label }}</span>
                @if (action.disabled && action.reason; as reason) {
                  <span
                    class="text-muted-foreground text-xs leading-4 font-normal"
                    data-testid="session-action-reason"
                    >{{ reason }}</span
                  >
                }
              </span>
              @if (action.command; as command) {
                <span class="text-muted-foreground font-mono text-xs">{{ command }}</span>
              }
            </button>
          }
        }
        @if (keptSessionId() !== null) {
          @if (toolbarEntry()) {
            <hlm-dropdown-menu-separator />
          }
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="menu-rename"
            (triggered)="startRename.emit()"
            i18n
          >
            Rename
          </button>
          @if (archived()) {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-unarchive"
              (triggered)="unarchive()"
              i18n
            >
              Unarchive
            </button>
          } @else {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-archive"
              (triggered)="archive()"
              i18n
            >
              Archive
            </button>
          }
          <button
            type="button"
            hlmDropdownMenuItem
            variant="destructive"
            data-testid="menu-delete"
            (triggered)="remove()"
            i18n
          >
            Delete…
          </button>
        }
        @if (paneId() !== null) {
          @if (toolbarEntry() || keptSessionId() !== null) {
            <hlm-dropdown-menu-separator />
          }
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="panel-add-to-stack"
            (triggered)="addToStack()"
            i18n
          >
            Add to stack
          </button>
        }
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #actionsTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>Session actions</span>
        <kbd hlmKbd class="font-mono font-normal">{{
          keymap.format({ mod: true, shift: true, key: 'k' })
        }}</kbd>
      </span>
    </ng-template>
  `,
})
export class PanelSessionActions {
  readonly isSessionPanel = input.required<boolean>();
  readonly paneId = input<PaneId | null>(null);
  readonly keptSessionId = input<SessionId | null>(null);
  readonly liveSessionId = input<SessionId | null>(null);
  readonly focused = input(true);
  readonly title = input.required<string>();

  readonly startRename = output<void>();

  protected readonly keymap = inject(Keymap);
  private readonly toolbar = inject(SessionToolbar);
  private readonly tabs = inject(Tabs);
  private readonly sessionsState = inject(SessionsState);
  private readonly destroyRef = inject(DestroyRef);

  private readonly actionsTrigger = viewChild<ElementRef<HTMLButtonElement>>('actionsTrigger');

  protected readonly toolbarEntry = computed(() => this.toolbar.entryFor(this.liveSessionId()));

  /** A draft has no kept Session to rename or archive, but still exposes context and stack actions when in a Pane. */
  protected readonly hasMenu = computed(
    () =>
      this.isSessionPanel() &&
      (this.keptSessionId() !== null || this.toolbarEntry() !== null || this.paneId() !== null),
  );

  protected readonly archived = computed(() => {
    const id = this.keptSessionId();
    return id !== null && this.sessionsState.isArchived(id);
  });

  constructor() {
    this.keymap.register({
      binding: { mod: true, shift: true, key: 'k' },
      when: () => this.focused() && this.hasMenu() && !this.keymap.modalOpen(),
      run: () => {
        this.actionsTrigger()?.nativeElement.click();
        return true;
      },
      destroyRef: this.destroyRef,
    });
  }

  /** Restores focus to the `⋯` trigger button after inline rename completes via Enter. */
  focusTrigger(): void {
    this.actionsTrigger()?.nativeElement.focus();
  }

  protected contextPercent(fraction: number): number {
    return Math.min(100, Math.max(0, fraction * 100));
  }

  protected addToStack(): void {
    const id = this.paneId();
    if (id !== null) this.tabs.addPanelToStack(id);
  }

  protected archive(): void {
    const target = this.target();
    if (target !== null) void this.sessionsState.archive([target]);
  }

  protected unarchive(): void {
    const target = this.target();
    if (target !== null) void this.sessionsState.unarchive([target]);
  }

  protected remove(): void {
    const target = this.target();
    if (target !== null) void this.sessionsState.delete([target]);
  }

  private target(): SessionTarget | null {
    const id = this.keptSessionId();
    return id === null ? null : { id, title: this.title() };
  }
}
