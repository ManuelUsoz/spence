import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { HlmTraceImports } from '@ui/trace';
import type { Compaction, Notice } from '../../../shared/sessions/sessions.rpc';
import type { ThreadAside } from './thread';

const isNotice = (item: Notice | Compaction): item is Notice => item._tag === 'Notice';
const isCompaction = (item: Notice | Compaction): item is Compaction => item._tag === 'Compaction';

/** A Notice or Compaction shown in the thread, in order. */
@Component({
  selector: 'app-thread-aside',
  imports: [HlmTraceImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'text-sm' },
  template: `
    @if (notice(); as notice) {
      <div class="bg-muted border-border rounded-md border px-3 py-2">
        <p class="font-medium" [class.text-destructive]="notice.severity === 'error'">
          {{ notice.title }}
        </p>
        @if (notice.description; as description) {
          <p class="text-muted-foreground">{{ description }}</p>
        }
      </div>
    }
    @if (compaction(); as compaction) {
      <div hlmTrace [attr.data-testid]="'compaction'" [attr.data-status]="compaction.status">
        <div hlmTraceCollapsible>
          <button hlmTraceCollapsibleTrigger hlmTraceLine>
            <span hlmTraceTitle i18n>Summary</span>
            <span class="text-muted-foreground ms-auto text-xs" data-testid="compaction-status">
              @switch (compaction.status) {
                @case ('running') {
                  <span i18n>Compacting…</span>
                }
                @case ('done') {
                  <span i18n>Compacted</span>
                }
                @case ('failed') {
                  <span i18n>Compaction failed</span>
                }
                @case ('cancelled') {
                  <span i18n>Compaction cancelled</span>
                }
              }
            </span>
          </button>
          <hlm-trace-collapsible-content>
            <p class="whitespace-pre-wrap">{{ compaction.summary }}</p>
          </hlm-trace-collapsible-content>
        </div>
      </div>
    }
  `,
})
export class ThreadAsideComponent {
  readonly item = input.required<ThreadAside>();

  protected readonly notice = computed(() => {
    const item = this.item().item;
    return isNotice(item) ? item : null;
  });

  protected readonly compaction = computed(() => {
    const item = this.item().item;
    return isCompaction(item) ? item : null;
  });

  protected readonly status = computed(() => {
    const item = this.item().item;
    return item._tag === 'Compaction' ? item.status : undefined;
  });
}
