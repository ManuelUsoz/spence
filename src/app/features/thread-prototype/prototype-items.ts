// PROTOTYPE (throwaway, branch prototype/calm-thread): items whose look the earlier tickets mostly settled
// (Turn outcome lines from #10, Notices, Compaction, Context cleared from #7). Variants decide where they go.
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Entry, TurnOutcome } from './prototype-model';
import { outcomeLine } from './prototype-model';
import { ProtoFold, ProtoIcon } from './prototype-shared';

@Component({
  selector: 'proto-outcome',
  imports: [ProtoIcon, ProtoFold],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let o = outcome();
    @switch (o.kind) {
      @case ('done') {}
      @case ('cancelled') {
        <div class="text-muted-foreground flex items-center gap-2 text-[13px]">
          <span class="bg-muted-foreground/50 size-2 rounded-[2px]"></span>
          {{ line() }}
        </div>
      }
      @case ('refused') {
        <div class="text-muted-foreground flex items-center gap-2 text-[13px]">
          <proto-icon name="x" [size]="13" />
          {{ line() }}
        </div>
      }
      @case ('cutShort') {
        <div class="flex items-center gap-2 text-[13px] text-amber-700 dark:text-amber-400">
          <proto-icon name="alert" [size]="13" />
          {{ line() }}
          <span class="text-muted-foreground">· Say “continue” to pick up where it stopped.</span>
        </div>
      }
      @case ('failed') {
        <div class="border-destructive/25 bg-destructive/5 flex flex-col gap-2 rounded-xl border px-3.5 py-2.5 text-[13px]">
          <div class="text-destructive flex items-center gap-2 font-medium">
            <proto-icon name="alert" [size]="14" />
            {{ line() }}
          </div>
          @if (o.reason === 'agentError') {
            <p class="m-0 font-mono text-xs break-all">{{ o.detail }}</p>
            <p class="text-muted-foreground m-0">Your Message is back in the composer.</p>
          } @else {
            <p class="text-muted-foreground m-0">{{ o.detail }}. It will start again with your next Message.</p>
            <div class="flex items-start gap-4">
              @if (o.stderrTail) {
                <proto-fold class="flex-1" label="Last lines of its log" [text]="o.stderrTail" />
              }
              <button type="button" class="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline">
                Open log
              </button>
            </div>
          }
        </div>
      }
    }
  `,
})
export class ProtoOutcome {
  readonly outcome = input.required<TurnOutcome>();
  protected line(): string {
    return outcomeLine(this.outcome());
  }
}

/** Notice, Compaction and Context cleared: entries that are neither text nor work. */
@Component({
  selector: 'proto-aside-item',
  imports: [ProtoIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let e = entry();
    @switch (e.type) {
      @case ('notice') {
        <div
          class="flex items-start gap-2 text-[13px]"
          [class]="e.severity === 'error' ? 'text-destructive' : e.severity === 'warning' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'"
        >
          <proto-icon [name]="e.severity === 'info' ? 'info' : 'alert'" [size]="14" class="mt-[3px]" />
          <div class="flex flex-col">
            <span>{{ e.title }}</span>
            @if (e.description) {
              <span class="text-muted-foreground text-xs">{{ e.description }}</span>
            }
          </div>
        </div>
      }
      @case ('compaction') {
        <details class="text-[13px]">
          <summary class="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-2">
            <proto-icon name="compress" [size]="13" />
            {{ e.status === 'running' ? 'Compacting the conversation…' : 'Conversation compacted' }}
          </summary>
          <p class="text-muted-foreground mt-1.5 mb-0 ml-5 border-l pl-3 text-[13px] leading-5">{{ e.summary }}</p>
        </details>
      }
      @case ('cleared') {
        <div class="text-muted-foreground flex items-center gap-3 text-xs" role="separator">
          <span class="bg-border h-px flex-1"></span>
          <proto-icon name="eraser" [size]="13" />
          {{ e.reason === 'user' ? 'Context cleared' : 'The Agent lost this conversation. It starts fresh from here.' }}
          <span class="bg-border h-px flex-1"></span>
        </div>
      }
      @default {}
    }
  `,
})
export class ProtoAsideItem {
  readonly entry = input.required<Entry>();
}
