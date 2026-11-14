import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { HlmTraceImports } from '@ui/trace';
import type {
  Compaction,
  ForkLineage,
  HandoffBoundary,
  Notice,
} from '../../../shared/sessions/sessions.rpc';
import type { ThreadAside } from './thread';

const isNotice = (item: Notice | Compaction | HandoffBoundary): item is Notice =>
  item._tag === 'Notice';
const isCompaction = (item: Notice | Compaction | HandoffBoundary): item is Compaction =>
  item._tag === 'Compaction';
const isHandoffBoundary = (item: Notice | Compaction | HandoffBoundary): item is HandoffBoundary =>
  item._tag === 'HandoffBoundary';

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
    @if (handoff(); as boundary) {
      <div hlmTrace data-testid="handoff-boundary" [attr.data-kind]="boundary.kind">
        @if (boundary.kind === 'fork') {
          <div class="flex flex-wrap items-center gap-2 pb-1 text-xs">
            @if (forkLineage(); as lineage) {
              @if (lineage.sourceDeleted) {
                <span class="text-muted-foreground" data-testid="fork-source-deleted" i18n
                  >Source deleted</span
                >
                <span class="text-muted-foreground" i18n
                  >(was {{ lineage.sourceTitle }} · Turn {{ lineage.sourceTurnNumber }})</span
                >
              } @else {
                <button
                  type="button"
                  class="text-foreground hover:underline font-medium"
                  data-testid="fork-source-link"
                  (click)="openSource.emit(lineage)"
                  i18n
                >
                  Forked from {{ lineage.sourceTitle }} · Turn {{ lineage.sourceTurnNumber }}
                </button>
              }
            } @else {
              <span class="font-medium" i18n>Forked session</span>
            }
          </div>
        }
        <div hlmTraceCollapsible>
          <button hlmTraceCollapsibleTrigger hlmTraceLine>
            <span hlmTraceTitle>
              @if (boundary.kind === 'modelChange') {
                <span i18n>Model handoff to {{ boundary.toModel ?? boundary.toAgentId }}</span>
              } @else if (boundary.kind === 'memoryLost') {
                <span i18n>Summary handoff (restored context)</span>
              } @else if (boundary.kind === 'fork') {
                <span i18n>Approved handoff summary</span>
              } @else {
                <span i18n>Switched to {{ boundary.toAgentId }}</span>
              }
            </span>
            <span class="text-muted-foreground ms-auto text-xs" i18n>Inspect summary</span>
          </button>
          <hlm-trace-collapsible-content>
            <p class="whitespace-pre-wrap" data-testid="handoff-boundary-summary">
              {{ boundary.summary }}
            </p>
          </hlm-trace-collapsible-content>
        </div>
      </div>
    }
  `,
})
export class ThreadAsideComponent {
  readonly item = input.required<ThreadAside>();
  readonly forkLineage = input<ForkLineage | undefined>(undefined);
  readonly openSource = output<ForkLineage>();

  protected readonly notice = computed(() => {
    const item = this.item().item;
    return isNotice(item) ? item : null;
  });

  protected readonly compaction = computed(() => {
    const item = this.item().item;
    return isCompaction(item) ? item : null;
  });

  protected readonly handoff = computed(() => {
    const item = this.item().item;
    return isHandoffBoundary(item) ? item : null;
  });

  protected readonly status = computed(() => {
    const item = this.item().item;
    return item._tag === 'Compaction' ? item.status : undefined;
  });
}
