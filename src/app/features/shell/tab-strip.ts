import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmTooltipImports } from '@ui/tooltip';
import { Tabs, type Tab } from '../../core/tabs';

/** One Tab per open Session, from any Project; scrolls sideways, no cap. Closing a Tab never stops its Session. */
@Component({
  selector: 'app-tab-strip',
  imports: [HlmTooltipImports, ActivityMark],
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
        >
          <button
            type="button"
            role="tab"
            class="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-3 text-left"
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
  `,
})
export class TabStrip {
  protected readonly tabs = inject(Tabs);

  protected label(tab: Tab): string {
    return tab.title ?? $localize`New Session`;
  }

  protected closeLabel(tab: Tab): string {
    return $localize`Close ${this.label(tab)}:title:`;
  }
}
