import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmButtonImports } from '@ui/button';
import { HlmContextMenuImports } from '@ui/context-menu';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import { HlmKbdImports } from '@ui/kbd';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmTooltipImports } from '@ui/tooltip';
import { TabId, type WorkspaceTab } from '../../../shared/tabs/tabs.rpc';
import { Keymap } from '../../core/keymap';
import { Tabs } from '../../core/tabs';
import { HostChip } from './host-chip';
import { wireEditorFocus, wirePendingFocus } from './sidebar-keys';
import { WorkspaceDragService } from './workspace-drag';

/**
 * The per-Project Tab strip at the top of the workspace: sidebar toggle, active Project's Tabs (`role="tablist"`),
 * inline Tab rename, close buttons, `+` to open a new draft Tab, and connected Remote viewer indicator.
 */
@Component({
  selector: 'app-tab-strip',
  imports: [
    ActivityMark,
    HlmButtonImports,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    HlmKbdImports,
    HlmSidebarImports,
    HlmTooltipImports,
    HostChip,
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
              hlmInput
              data-testid="tab-rename-input"
              class="bg-background h-7 w-44 shrink-0 text-xs font-medium md:text-xs"
              [value]="renameInitial()"
              aria-label="Tab name"
              i18n-aria-label
              (keydown.enter)="$event.preventDefault(); saveRename(tab.id, renameInput.value, true)"
              (blur)="saveRename(tab.id, renameInput.value, false)"
            />
          } @else {
            <div
              class="group flex h-7 max-w-56 shrink-0 items-center rounded-md border text-xs transition-colors"
              [class]="tabContainerClasses(tab.id, isActive)"
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
                [attr.data-drop-target]="isDropTarget(tab.id) ? 'true' : null"
                [attr.data-dragging]="drag.draggingTabId() === tab.id ? 'true' : null"
                class="focus-visible:ring-ring flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-md px-2.5 text-left outline-none select-none focus-visible:ring-2"
                (pointerdown)="onTabPointerDown($event, tab)"
                (click)="onTabClick(tab.id)"
                (dblclick)="startRename(tab)"
              >
                @if (activity !== null) {
                  <span data-testid="tab-activity-indicator" class="shrink-0">
                    <app-activity-mark [kind]="activity" />
                  </span>
                }
                <span
                  class="truncate font-medium"
                  [class.text-muted-foreground]="title.untitled"
                  data-testid="tab-title"
                  >{{ title.label }}</span
                >
              </button>
              <button
                hlmBtn
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="tab-close"
                aria-label="Close Tab"
                i18n-aria-label
                class="text-muted-foreground mr-1 size-4 rounded-sm"
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
          hlmBtn
          type="button"
          variant="ghost"
          size="icon"
          data-testid="new-tab"
          aria-label="New Tab"
          i18n-aria-label
          [hlmTooltip]="newTabTip"
          class="text-muted-foreground"
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
      <app-host-chip />
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
  protected readonly drag = inject(WorkspaceDragService);
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
    effect((onCleanup) => {
      const buttons = this.tabButtons();
      const unregisters = buttons
        .map((ref) => {
          const id = ref.nativeElement.getAttribute('data-tab-id');
          if (id === null) return null;
          const tabId = TabId.make(id);
          return this.drag.registerTab({
            projectId: () => this.tabs.activeProjectId(),
            tabId: () => tabId,
            element: ref.nativeElement,
          });
        })
        .filter((fn): fn is () => void => fn !== null);
      onCleanup(() => {
        for (const unregister of unregisters) unregister();
      });
    });
    this.keymap.registerEscape({
      layer: 'rename',
      when: () => this.editingTabId() !== null,
      run: () => this.cancelRename(true),
      destroyRef: this.destroyRef,
    });
  }

  protected isDropTarget(tabId: TabId): boolean {
    return this.drag.tabDropTarget()?.overTabId === tabId;
  }

  protected tabContainerClasses(tabId: TabId, isActive: boolean): string {
    const base = isActive
      ? 'bg-accent text-foreground border-border'
      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground border-transparent';
    const target = this.isDropTarget(tabId) ? ' ring-ring border-ring ring-2' : '';
    const dragging = this.drag.draggingTabId() === tabId ? ' opacity-60' : '';
    return `${base}${target}${dragging}`;
  }

  protected onTabPointerDown(event: PointerEvent, tab: WorkspaceTab): void {
    if (event.button !== 0 || this.editingTabId() !== null) return;
    const projectId = this.tabs.activeProjectId();
    if (projectId === null) return;
    this.drag.beginTabDrag({
      pointerId: typeof event.pointerId === 'number' ? event.pointerId : null,
      clientX: event.clientX,
      clientY: event.clientY,
      projectId,
      tabId: tab.id,
    });
  }

  protected onTabClick(tabId: TabId): void {
    if (this.drag.consumeSuppressedClick()) return;
    this.tabs.activateTab(tabId);
  }

  protected newTab(): void {
    const projectId = this.tabs.activeProjectId();
    if (projectId !== null) this.tabs.newTab(projectId, this.tabs.projectDevice(projectId));
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
