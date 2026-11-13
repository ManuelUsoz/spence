import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmContextMenuImports } from '@ui/context-menu';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmTooltipImports } from '@ui/tooltip';
import { Tabs, type Tab } from '../../core/tabs';
import { SessionsState } from './sessions-state';

/** One Tab per open Session, from any Project; scrolls sideways, no cap. Closing a Tab never stops its Session. */
@Component({
  selector: 'app-tab-strip',
  imports: [HlmTooltipImports, HlmContextMenuImports, HlmDropdownMenuImports],
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
            type="button"
            role="tab"
            class="min-w-0 truncate py-1 pr-1 pl-3 text-left"
            [class.text-muted-foreground]="tab.title === null"
            [attr.aria-selected]="tab.id === tabs.activeId()"
            [hlmTooltip]="label(tab)"
            data-testid="tab-label"
            (click)="tabs.activate(tab.id)"
          >
            {{ label(tab) }}
          </button>
          <button
            type="button"
            class="hover:bg-background/60 mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded"
            data-testid="tab-close"
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
              [disabled]="true"
              data-testid="menu-rename"
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
  `,
})
export class TabStrip {
  protected readonly tabs = inject(Tabs);
  protected readonly sessionsState = inject(SessionsState);

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
