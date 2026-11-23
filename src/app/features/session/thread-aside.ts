import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { HlmDialogImports } from '@ui/dialog';
import { HlmTraceImports } from '@ui/trace';
import { HlmButtonImports } from '@ui/button';
import type {
  Compaction,
  ForkLineage,
  HandoffBoundary,
  Notice,
} from '../../../shared/sessions/sessions.rpc';
import { Keymap } from '../../core/keymap';
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
  imports: [HlmDialogImports, HlmTraceImports, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'text-sm' },
  template: `
    @if (notice(); as notice) {
      @if (notice.sent; as sent) {
        <div
          class="border-border w-fit max-w-[82%] rounded-xl border px-3.5 py-2.5"
          data-testid="message-sent"
        >
          <button
            hlmBtn
            variant="link"
            size="xs"
            type="button"
            (click)="openRecipient.emit(sent)"
            i18n
          >
            Sent to {{ sent.title }} in {{ sent.projectName }}
          </button>
          @if (sent.queued) {
            <span class="text-muted-foreground ms-2 text-xs" i18n>Queued at send</span>
          }
          <p class="whitespace-pre-wrap">{{ notice.description }}</p>
        </div>
      } @else {
        <div class="bg-muted border-border rounded-md border px-3 py-2">
          <p class="font-medium" [class.text-destructive]="notice.severity === 'error'">
            {{ notice.title }}
          </p>
          @if (notice.description; as description) {
            <p class="text-muted-foreground">{{ description }}</p>
          }
        </div>
      }
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
      @if (boundary.kind === 'fork') {
        <div
          class="text-muted-foreground flex items-center gap-3 text-xs"
          data-testid="handoff-boundary"
          [attr.data-kind]="boundary.kind"
        >
          <span class="bg-border h-px flex-1"></span>
          <span class="flex flex-wrap items-center justify-center gap-1.5">
            @if (forkLineage(); as lineage) {
              @if (lineage.sourceDeleted) {
                <span data-testid="fork-source-deleted" i18n>Source deleted</span>
                <span i18n
                  >(was {{ lineage.sourceTitle }} · Turn {{ lineage.sourceTurnNumber }})</span
                >
              } @else {
                <button
                  type="button"
                  class="hover:text-foreground cursor-pointer font-medium transition-colors hover:underline"
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
            <span aria-hidden="true">·</span>
            <button
              type="button"
              class="hover:text-foreground cursor-pointer transition-colors hover:underline"
              data-testid="fork-summary-trigger"
              (click)="openSummaryDialog()"
              i18n
            >
              View summary
            </button>
          </span>
          <span class="bg-border h-px flex-1"></span>
        </div>

        <hlm-dialog
          [state]="summaryOpen() ? 'open' : 'closed'"
          (stateChanged)="onSummaryDialogStateChange($event)"
        >
          <hlm-dialog-content
            *hlmDialogPortal="let ctx"
            class="sm:max-w-xl"
            data-testid="fork-summary-dialog"
          >
            <hlm-dialog-header>
              <h2 hlmDialogTitle i18n>Fork summary</h2>
              <p hlmDialogDescription>
                @if (forkLineage(); as lineage) {
                  <span i18n
                    >Carried over from {{ lineage.sourceTitle }} · Turn
                    {{ lineage.sourceTurnNumber }}.</span
                  >
                } @else {
                  <span i18n>Summary carried over from the source Session.</span>
                }
              </p>
            </hlm-dialog-header>
            <div
              class="border-border bg-muted/40 max-h-[60vh] overflow-y-auto rounded-md border p-3 text-sm whitespace-pre-wrap"
              data-testid="handoff-boundary-summary"
            >
              {{ boundary.summary }}
            </div>
            <hlm-dialog-footer>
              <button
                hlmBtn
                type="button"
                variant="outline"
                data-testid="fork-summary-close"
                (click)="closeSummaryDialog()"
                i18n
              >
                Close
              </button>
            </hlm-dialog-footer>
          </hlm-dialog-content>
        </hlm-dialog>
      } @else {
        <div hlmTrace data-testid="handoff-boundary" [attr.data-kind]="boundary.kind">
          <div hlmTraceCollapsible>
            <button hlmTraceCollapsibleTrigger hlmTraceLine>
              <span hlmTraceTitle>
                @if (boundary.kind === 'modelChange') {
                  <span i18n>Model handoff to {{ boundary.toModel ?? boundary.toAgentId }}</span>
                } @else if (boundary.kind === 'memoryLost') {
                  <span i18n>Summary handoff (restored context)</span>
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
    }
  `,
})
export class ThreadAsideComponent {
  private readonly keymap = inject(Keymap);

  readonly item = input.required<ThreadAside>();
  readonly forkLineage = input<ForkLineage | undefined>(undefined);
  readonly openSource = output<ForkLineage>();
  readonly openRecipient = output<NonNullable<Notice['sent']>>();

  protected readonly summaryOpen = signal(false);

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

  constructor() {
    effect((onCleanup) => {
      if (!this.summaryOpen()) return;
      const release = this.keymap.pushModal({ onEscape: () => this.closeSummaryDialog() });
      onCleanup(release);
    });
  }

  protected openSummaryDialog(): void {
    this.summaryOpen.set(true);
  }

  protected closeSummaryDialog(): void {
    this.summaryOpen.set(false);
  }

  protected onSummaryDialogStateChange(state: 'open' | 'closed'): void {
    this.summaryOpen.set(state === 'open');
  }
}
