import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  inject,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmContextMenuImports } from '@ui/context-menu';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmKbdImports } from '@ui/kbd';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmTooltipImports } from '@ui/tooltip';
import type { TabId, WorkspaceTab } from '../../../shared/tabs/tabs.rpc';
import { Keymap } from '../../core/keymap';
import { Tabs } from '../../core/tabs';
import { wireEditorFocus, wirePendingFocus } from './sidebar-keys';

/**
 * The per-Project Tab strip at the top of the workspace: sidebar toggle, active Project's Tabs (`role="tablist"`),
 * inline Tab rename, close buttons, and `+` to open a new draft Tab.
 */
@Component({
  selector: 'app-tab-strip',
  imports: [
    ActivityMark,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    HlmKbdImports,
    HlmSidebarImports,
    HlmTooltipImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block shrink-0' },
  template: `
    <div
      class="border-border/60 flex h-11 min-w-0 items-center gap-1.5 border-b px-3"
      data-testid="tab-strip"
    >
      <button hlmSidebarTrigger srOnlyText="Toggle sidebar" i18n-srOnlyText></button>

      <div
        role="tablist"
        aria-label="Project Tabs"
        i18n-aria-label
        class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        @for (tab of tabs.tabs(); track tab.id) {
          @let title = tabs.tabTitle(tab);
          @let activity = tabs.tabActivity(tab);
          @let isActive = tabs.activeTab()?.id === tab.id;
          @if (editingTabId() === tab.id) {
            <input
              #renameInput
              data-testid="tab-rename-input"
              class="bg-background border-input focus-visible:ring-ring h-7 w-44 shrink-0 rounded-md border px-2 text-xs font-medium outline-none focus-visible:ring-2"
              [value]="renameInitial()"
              aria-label="Tab name"
              i18n-aria-label
              (keydown.enter)="$event.preventDefault(); saveRename(tab.id, renameInput.value, true)"
              (blur)="saveRename(tab.id, renameInput.value, false)"
            />
          } @else {
            <div
              class="group flex h-7 max-w-56 shrink-0 items-center rounded-md border text-xs transition-colors"
              [class]="
                isActive
                  ? 'bg-accent text-foreground border-border'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground border-transparent'
              "
              [hlmContextMenuTrigger]="tabMenu"
              [hlmContextMenuTriggerData]="{ $implicit: tab }"
            >
              <button
                #tabBtn
                type="button"
                role="tab"
                data-testid="tab-item"
                [attr.data-tab-id]="tab.id"
                [attr.aria-selected]="isActive"
                class="focus-visible:ring-ring flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-md px-2.5 text-left outline-none focus-visible:ring-2"
                (click)="tabs.activateTab(tab.id)"
                (dblclick)="startRename(tab)"
              >
                @if (activity !== null) {
                  <app-activity-mark [kind]="activity" />
                }
                <span
                  class="truncate font-medium"
                  [class.text-muted-foreground]="title.untitled"
                  data-testid="tab-title"
                  >{{ title.label }}</span
                >
              </button>
              <button
                type="button"
                data-testid="tab-close"
                aria-label="Close Tab"
                i18n-aria-label
                class="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring mr-1 flex size-4 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
                [class.opacity-0]="!isActive"
                [class.group-hover:opacity-100]="!isActive"
                [class.focus-visible:opacity-100]="!isActive"
                (click)="tabs.closeTab(tab.id)"
              >
                <svg
                  class="size-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          }
        }

        <button
          type="button"
          data-testid="new-tab"
          aria-label="New Tab"
          i18n-aria-label
          [hlmTooltip]="newTabTip"
          class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
          (click)="newTab()"
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
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
    </div>

    <ng-template #tabMenu let-tab>
      <hlm-dropdown-menu class="w-44" data-testid="tab-context-menu">
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="tab-menu-rename"
          (triggered)="startRename(tab)"
          i18n
        >
          Rename Tab
        </button>
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="tab-menu-close"
          (triggered)="tabs.closeTab(tab.id)"
          i18n
        >
          Close Tab
        </button>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #newTabTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>New Tab</span>
        <kbd hlmKbd class="font-mono font-normal">{{ keymap.format({ mod: true, key: 't' }) }}</kbd>
      </span>
    </ng-template>
  `,
})
export class TabStrip {
  protected readonly tabs = inject(Tabs);
  protected readonly keymap = inject(Keymap);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly editingTabId = signal<TabId | null>(null);
  protected readonly renameInitial = signal('');
  private readonly pendingFocusId = signal<TabId | null>(null);
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');
  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabBtn');

  constructor() {
    wireEditorFocus(this.renameInput);
    wirePendingFocus({
      pendingId: this.pendingFocusId,
      isEditing: () => this.editingTabId() !== null,
      elements: this.tabButtons,
      attribute: 'data-tab-id',
    });
    this.keymap.registerEscape({
      layer: 'rename',
      when: () => this.editingTabId() !== null,
      run: () => this.cancelRename(true),
      destroyRef: this.destroyRef,
    });
  }

  protected newTab(): void {
    const projectId = this.tabs.activeProjectId();
    if (projectId !== null) this.tabs.newTab(projectId);
  }

  protected startRename(tab: WorkspaceTab): void {
    const title = this.tabs.tabTitle(tab);
    this.renameInitial.set(tab.customTitle ?? (title.untitled ? '' : title.label));
    this.editingTabId.set(tab.id);
  }

  protected cancelRename(restoreFocus: boolean): void {
    const id = this.editingTabId();
    if (id === null) return;
    this.editingTabId.set(null);
    if (restoreFocus) this.pendingFocusId.set(id);
  }

  protected saveRename(tabId: TabId, value: string, restoreFocus: boolean): void {
    if (this.editingTabId() !== tabId) return;
    this.editingTabId.set(null);
    if (restoreFocus) this.pendingFocusId.set(tabId);
    this.tabs.renameTab(tabId, value);
  }
}
