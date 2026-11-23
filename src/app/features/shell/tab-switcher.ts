import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  signal,
} from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmBadgeImports } from '@ui/badge';
import type {
  PaneId,
  PaneLayout,
  PaneNode,
  TabId,
  WorkspaceTab,
} from '../../../shared/tabs/tabs.rpc';
import { Keymap } from '../../core/keymap';
import { Tabs } from '../../core/tabs';

/**
 * Windows `Alt+Tab`-style MRU Tab switcher overlay driven by `Ctrl+Tab` / `Ctrl+Shift+Tab`:
 * renders visual preview cards with mini split-Pane wireframes and wallpaper tints,
 * commits on `Ctrl` release or card click, and cancels on `Esc`.
 */
@Component({
  selector: 'app-tab-switcher',
  imports: [ActivityMark, HlmBadgeImports, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div
        class="bg-background/45 fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-xs"
        data-testid="tab-switcher-backdrop"
        (click)="cancel()"
      >
        <div
          role="listbox"
          aria-label="Switch Tab"
          i18n-aria-label
          data-testid="tab-switcher"
          class="bg-popover/90 border-border text-popover-foreground flex max-w-4xl flex-wrap items-stretch justify-center gap-3 rounded-2xl border p-4 shadow-xl backdrop-blur-xl"
          (click)="$event.stopPropagation()"
        >
          @for (tab of items(); track tab.id; let i = $index) {
            @let title = tabs.tabTitle(tab);
            @let activity = tabs.tabActivity(tab);
            @let overlay = tabs.tabOverlay(tab.id);
            @let selected = i === selectedIndex();
            <button
              type="button"
              role="option"
              data-testid="tab-switcher-card"
              [attr.data-tab-id]="tab.id"
              [attr.aria-selected]="selected"
              class="flex w-52 flex-col gap-2 rounded-xl border p-2.5 text-left transition-all outline-none"
              [class]="
                selected
                  ? 'border-ring bg-accent/70 ring-ring/40 ring-2'
                  : 'border-border/60 bg-card/60 hover:bg-accent/40'
              "
              (mouseenter)="selectedIndex.set(i)"
              (click)="pick(tab.id)"
            >
              <div class="flex min-w-0 items-center gap-1.5">
                @if (activity !== null) {
                  <span class="shrink-0">
                    <app-activity-mark [kind]="activity" />
                  </span>
                }
                <span
                  class="min-w-0 flex-1 truncate text-xs font-medium"
                  [class.text-muted-foreground]="title.untitled"
                  data-testid="tab-switcher-title"
                >
                  {{ title.label }}
                </span>
                @if (overlay; as ov) {
                  <span
                    hlmBadge
                    variant="secondary"
                    class="h-4 shrink-0 px-1.5 text-[10px]"
                    data-testid="tab-switcher-overlay-badge"
                  >
                    @if (ov.kind === 'Changes') {
                      <ng-container i18n>Changes</ng-container>
                    } @else {
                      <ng-container i18n>Workers</ng-container>
                    }
                  </span>
                }
              </div>

              <div
                class="border-border/50 bg-background/80 flex h-24 w-full overflow-hidden rounded-lg border p-1"
                data-testid="tab-switcher-preview"
              >
                <ng-container
                  *ngTemplateOutlet="
                    miniNode;
                    context: {
                      $implicit: tab.layout.rootPaneId,
                      nodeMap: nodeMapFor(tab.layout),
                    }
                  "
                />
              </div>
            </button>
          }
        </div>
      </div>

      <ng-template #miniNode let-nodeId let-nodeMap="nodeMap">
        @if (nodeOf(nodeMap, nodeId); as node) {
          @if (node._tag === 'Split') {
            <div
              class="flex min-h-0 min-w-0 flex-1 gap-1"
              [class.flex-row]="node.direction === 'horizontal'"
              [class.flex-col]="node.direction === 'vertical'"
            >
              <div
                class="flex min-h-0 min-w-0 overflow-hidden"
                [style.flex]="flexStyle(node.ratio)"
              >
                <ng-container
                  *ngTemplateOutlet="miniNode; context: { $implicit: node.first, nodeMap: nodeMap }"
                />
              </div>
              <div
                class="flex min-h-0 min-w-0 overflow-hidden"
                [style.flex]="flexStyle(1 - node.ratio)"
              >
                <ng-container
                  *ngTemplateOutlet="
                    miniNode;
                    context: { $implicit: node.second, nodeMap: nodeMap }
                  "
                />
              </div>
            </div>
          } @else {
            @let panel = node.panels[0];
            @let wp = panel ? tabs.panelWallpaper(panel) : null;
            <div
              class="border-border/50 bg-muted/40 relative flex min-h-0 min-w-0 flex-1 items-end overflow-hidden rounded-md border p-1.5"
              [attr.data-wallpaper-id]="wp?.id ?? null"
            >
              @if (wp) {
                <img [src]="wp.url" alt="" class="absolute inset-0 h-full w-full object-cover" />
                <div class="session-wallpaper-scrim absolute inset-0"></div>
              }
              <span
                class="text-foreground/90 relative z-10 truncate text-[10px] leading-tight font-medium"
              >
                {{ panel ? (tabs.panelTitle(panel) ?? untitledLabel) : '' }}
              </span>
            </div>
          }
        }
      </ng-template>
    }
  `,
})
export class TabSwitcher {
  protected readonly tabs = inject(Tabs);
  private readonly keymap = inject(Keymap);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly untitledLabel = $localize`New Session`;
  protected readonly items = signal<ReadonlyArray<WorkspaceTab>>([]);
  protected readonly selectedIndex = signal(0);
  readonly open = computed(() => this.items().length > 0);

  private readonly onWindowKeyUp = (event: KeyboardEvent): void => {
    if (!this.open()) return;
    if (event.key === 'Control' || !event.ctrlKey) {
      this.commit();
    }
  };

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (!this.open()) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      this.step(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      this.step(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this.commit();
    }
  };

  private readonly onWindowBlur = (): void => {
    if (this.open()) this.cancel();
  };

  constructor() {
    const view = this.document.defaultView;
    if (view !== null) {
      view.addEventListener('keyup', this.onWindowKeyUp, { capture: true });
      view.addEventListener('keydown', this.onWindowKeyDown, { capture: true });
      view.addEventListener('blur', this.onWindowBlur);
      this.destroyRef.onDestroy(() => {
        view.removeEventListener('keyup', this.onWindowKeyUp, { capture: true });
        view.removeEventListener('keydown', this.onWindowKeyDown, { capture: true });
        view.removeEventListener('blur', this.onWindowBlur);
      });
    }
    this.keymap.registerEscape({
      layer: 'menu',
      when: () => this.open(),
      run: () => this.cancel(),
      destroyRef: this.destroyRef,
    });
  }

  /** Opens the MRU switcher (if closed) and moves selection forward (`1`) or backward (`-1`). */
  step(delta: 1 | -1): void {
    const currentItems = this.items();
    if (currentItems.length === 0) {
      const mru = this.tabs.mruTabs();
      if (mru.length < 2) {
        const only = mru[0];
        if (only !== undefined) this.tabs.activateTab(only.id);
        return;
      }
      this.items.set(mru);
      this.selectedIndex.set(delta === 1 ? 1 : mru.length - 1);
      return;
    }
    const len = currentItems.length;
    this.selectedIndex.set((this.selectedIndex() + delta + len) % len);
  }

  /** Activates the currently highlighted Tab and closes the switcher. */
  commit(): void {
    const selected = this.items()[this.selectedIndex()];
    this.items.set([]);
    if (selected !== undefined) {
      this.tabs.activateTab(selected.id);
    }
  }

  /** Immediately switches to `tabId` (e.g. from clicking a preview card). */
  protected pick(tabId: TabId): void {
    this.items.set([]);
    this.tabs.activateTab(tabId);
  }

  /** Closes the switcher without changing the active Tab. */
  cancel(): void {
    this.items.set([]);
  }

  protected nodeMapFor(layout: PaneLayout): ReadonlyMap<PaneId, PaneNode> {
    return new Map(layout.nodes.map((node) => [node.id, node]));
  }

  protected nodeOf(nodeMap: ReadonlyMap<PaneId, PaneNode>, paneId: PaneId): PaneNode | undefined {
    return nodeMap.get(paneId);
  }

  protected flexStyle(ratio: number): string {
    return `${ratio} 1 0%`;
  }
}
