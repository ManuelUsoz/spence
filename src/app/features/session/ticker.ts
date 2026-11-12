import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { HlmTraceImports } from '@ui/trace';
import { activityIconName, stepIconName, threadIcons } from './step-icons';
import { activityLabel, formatElapsed, stepKindLabel, stepTarget, type TurnWork } from './thread';

/** A short tail of the Thought, shown while the Agent is thinking. */
const THOUGHT_TAIL_LENGTH = 60;

/** A fixed spinner, the current kind icon, the target and the elapsed time of a running Turn. */
@Component({
  selector: 'app-ticker',
  imports: [NgIcon, HlmTraceImports],
  providers: [provideIcons(threadIcons)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', 'data-testid': 'ticker', '[attr.title]': 'accessibleName()' },
  template: `
    <div hlmTrace>
      <div hlmTraceLine class="w-full max-w-full">
        <ng-icon name="lucideLoaderCircle" class="size-4 shrink-0 animate-spin" />
        @if (icon(); as iconName) {
          <ng-icon [name]="iconName" class="size-4 shrink-0" />
        }
        @if (thinking(); as tail) {
          <span class="min-w-0 flex-1 truncate italic" [attr.aria-label]="accessibleName()">{{
            tail
          }}</span>
        } @else {
          <span
            class="font-mono text-xs min-w-0 flex-1 truncate"
            [attr.aria-label]="accessibleName()"
            >{{ target() }}</span
          >
        }
        <span class="tabular-nums shrink-0">{{ elapsed() }}</span>
      </div>
    </div>
  `,
})
export class Ticker {
  readonly work = input.required<TurnWork>();
  readonly now = input.required<number>();

  protected readonly elapsed = computed(() => formatElapsed(this.now() - this.work().startedAt));

  protected readonly thinking = computed(() => {
    const work = this.work();
    return work.activity === 'thinking' ? work.thought.slice(-THOUGHT_TAIL_LENGTH) : null;
  });

  protected readonly target = computed(() => {
    const work = this.work();
    if (work.activity === 'step') {
      const step = work.steps.at(-1);
      if (step !== undefined) return stepTarget(step);
    }
    return '';
  });

  protected readonly icon = computed(() => {
    const work = this.work();
    if (work.activity === 'step') {
      const step = work.steps.at(-1);
      if (step !== undefined) return stepIconName(step.kind);
    }
    return activityIconName(work.activity);
  });

  protected readonly accessibleName = computed(() => {
    const work = this.work();
    if (work.activity === 'step') {
      const step = work.steps.at(-1);
      if (step !== undefined) return `${stepKindLabel(step.kind)} ${stepTarget(step)}`;
    }
    return activityLabel(work.activity);
  });
}
