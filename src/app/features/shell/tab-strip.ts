import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { HlmContextMenuImports } from '@ui/context-menu';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmKbdImports } from '@ui/kbd';
import { ActivityMark } from '@ui/activity-mark';
import { HlmTooltipImports } from '@ui/tooltip';
import { Keymap } from '../../core/keymap';
import { Tabs, type Tab } from '../../core/tabs';
import { SessionsState } from './sessions-state';

/** One Tab per open Session, from any Project; scrolls sideways, no cap. Closing a Tab never stops its Session. */
@Component({
  selector: 'app-tab-strip',
  imports: [
    HlmTooltipImports,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    HlmKbdImports,
    ActivityMark,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0 flex-1' },
  template: `
    <div
      role="tablist"
      class="flex min-w-0 items-end gap-1 overflow-x-auto"
      data-testid="tab-strip"
      aria-label="Open Sessions"
      i18n-aria-label
    >
      @for (tab of tabs.tabs(); track tab.id) {
        @if (editing() === tab.id) {
          <div class="bg-accent flex h-8 max-w-56 shrink-0 items-center rounded-md px-2 text-sm">
            <input
              #editor
              data-testid="tab-rename"
              class="bg-background w-36 rounded px-1.5 py-0.5 text-sm"
              [value]="tab.title ?? ''"
              aria-label="Session title"
              i18n-aria-label
              (keydown.enter)="$event.preventDefault(); saveRename(tab, editor.value, true)"
              (blur)="saveRename(tab, editor.value, false)"
            />
          </div>
        } @else {
          <div
            class="group flex h-8 max-w-56 shrink-0 items-center rounded-md text-sm"
            [class]="
              tab.id === tabs.activeId()
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50'
            "
            data-testid="tab"
            [hlmContextMenuTrigger]="tabMenu"
            [hlmContextMenuTriggerData]="{ $implicit: tab.id }"
            [disabled]="tab.session === null"
          >
            <button
              #tabButton
              type="button"
              role="tab"
              [attr.data-tab-id]="tab.id"
              class="focus-visible:ring-ring flex min-w-0 items-center gap-1.5 rounded-l-md py-1 pr-1 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
              [class.text-muted-foreground]="tab.title === null"
              [attr.aria-selected]="tab.id === tabs.activeId()"
              [hlmTooltip]="label(tab)"
              (click)="tabs.activate(tab.id)"
            >
              @if (tab.attention; as attention) {
                <span data-testid="tab-attention" class="inline-flex shrink-0">
                  <app-activity-mark [kind]="attention" />
                </span>
              } @else if (tab.running) {
                <span data-testid="tab-running" class="inline-flex shrink-0">
                  <app-activity-mark kind="running" />
                </span>
              }
              <span class="min-w-0 truncate" data-testid="tab-label">{{ label(tab) }}</span>
            </button>
            <button
              type="button"
              class="hover:bg-background/60 focus-visible:ring-ring mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2"
              data-testid="tab-close"
              [hlmTooltip]="closeTabTip"
              [attr.aria-label]="closeLabel(tab)"
              (click)="tabs.close(tab.id)"
            >
              <svg
                class="size-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        }
      }
    </div>

    <ng-template #tabMenu let-tabId>
      @if (tabById(tabId); as tab) {
        @if (tab.session; as sessionId) {
          <hlm-dropdown-menu class="w-48" data-testid="tab-context-menu">
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-open"
              (triggered)="tabs.activate(tab.id)"
              i18n
            >
              Open
            </button>
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-rename"
              (triggered)="startRename(tab)"
              i18n
            >
              Rename
            </button>
            <hlm-dropdown-menu-separator />
            @if (sessionsState.isArchived(sessionId)) {
              <button
                type="button"
                hlmDropdownMenuItem
                data-testid="menu-unarchive"
                (triggered)="sessionsState.unarchive([{ id: sessionId, title: label(tab) }])"
                i18n
              >
                Unarchive
              </button>
            } @else {
              <button
                type="button"
                hlmDropdownMenuItem
                data-testid="menu-archive"
                (triggered)="sessionsState.archive([{ id: sessionId, title: label(tab) }])"
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
              (triggered)="sessionsState.delete([{ id: sessionId, title: label(tab) }])"
              i18n
            >
              Delete…
            </button>
          </hlm-dropdown-menu>
        }
      }
    </ng-template>

    <ng-template #closeTabTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>Close Tab</span>
        <kbd hlmKbd class="font-mono font-normal">{{ keymap.format({ mod: true, key: 'w' }) }}</kbd>
      </span>
    </ng-template>
  `,
})
export class TabStrip {
  protected readonly keymap = inject(Keymap);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly tabs = inject(Tabs);
  protected readonly sessionsState = inject(SessionsState);
  protected readonly editing = signal<string | null>(null);
  private readonly pendingFocusId = signal<string | null>(null);
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');

  constructor() {
    this.keymap.registerEscape({
      layer: 'rename',
      when: () => this.editing() !== null,
      run: () => this.cancelRename(true),
      destroyRef: this.destroyRef,
    });
    effect(() => {
      const input = this.editor()?.nativeElement;
      if (input !== undefined) {
        input.focus();
        input.select();
      }
    });
    effect(() => {
      const id = this.pendingFocusId();
      if (id === null || this.editing() !== null) return;
      const button = this.tabButtons().find(
        (ref) => ref.nativeElement.getAttribute('data-tab-id') === id,
      )?.nativeElement;
      if (button === undefined) return;
      untracked(() => this.pendingFocusId.set(null));
      button.focus({ preventScroll: true });
    });
  }

  protected startRename(tab: Tab): void {
    if (tab.session === null) return;
    this.editing.set(tab.id);
  }

  protected saveRename(tab: Tab, title: string, restoreFocus: boolean): void {
    if (this.editing() !== tab.id) return;
    this.editing.set(null);
    if (restoreFocus) this.pendingFocusId.set(tab.id);
    if (tab.session === null) return;
    const trimmed = title.trim();
    const initial = tab.title ?? '';
    if (trimmed !== initial) void this.sessionsState.rename(tab.session, title);
  }

  protected cancelRename(restoreFocus = false): void {
    const id = this.editing();
    this.editing.set(null);
    if (restoreFocus && id !== null) this.pendingFocusId.set(id);
  }

  protected tabById(id: string): Tab | undefined {
    return this.tabs.tabs().find((tab) => tab.id === id);
  }

  protected label(tab: Tab): string {
    return tab.title ?? $localize`New Session`;
  }

  protected closeLabel(tab: Tab): string {
    return $localize`Close ${this.label(tab)}:title:`;
  }
}
