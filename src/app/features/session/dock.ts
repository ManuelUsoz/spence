import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { Plan } from '../../../shared/sessions/sessions.rpc';
import { completedPlanCount, currentPlanEntry } from './thread';

/**
 * The area just above the Composer for what a running Turn wants from the user. Right now that is the Plan;
 * the permission request issue will fill the same slot.
 */
@Component({
  selector: 'app-dock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-2', 'data-testid': 'dock' },
  template: `
    @if (plan(); as plan) {
      <button
        type="button"
        class="flex flex-col gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
        (click)="expanded.set(!expanded())"
        [attr.aria-expanded]="expanded()"
      >
        <span class="text-muted-foreground" i18n>
          Plan {{ completed() }} of {{ total() }} · {{ currentEntry()?.content }}
        </span>
        <span class="flex w-full gap-1" aria-hidden="true">
          @for (entry of plan.entries; track $index) {
            <span
              data-plan-segment
              class="h-1 flex-1 rounded-full"
              [class.bg-primary]="entry.status === 'completed'"
              [class.bg-muted]="entry.status !== 'completed'"
            ></span>
          }
        </span>
      </button>
      @if (expanded()) {
        <div class="border-border border rounded-md px-3 py-2">
          @for (entry of plan.entries; track $index) {
            <div class="flex items-center gap-2 py-1 text-sm">
              <span
                class="size-2 shrink-0 rounded-full"
                [class.bg-primary]="entry.status === 'completed'"
                [class.bg-muted]="entry.status !== 'completed'"
              ></span>
              <span [class.line-through]="entry.status === 'completed'">{{ entry.content }}</span>
            </div>
          }
        </div>
      }
    }
  `,
})
export class Dock {
  readonly plan = input<Plan | null>(null);

  protected readonly expanded = signal(false);

  protected readonly completed = computed(() => {
    const plan = this.plan();
    return plan === null ? 0 : completedPlanCount(plan);
  });

  protected readonly total = computed(() => this.plan()?.entries.length ?? 0);

  protected readonly currentEntry = computed(() => {
    const plan = this.plan();
    return plan === null ? undefined : currentPlanEntry(plan);
  });
}
