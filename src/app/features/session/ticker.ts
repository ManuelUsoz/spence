import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  untracked,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { HlmButtonImports } from '@ui/button';
import { DiffPatch, type DiffHunk } from '@ui/diff';
import { HlmTraceImports } from '@ui/trace';
import type { Step, StepId, TurnId } from '../../../shared/sessions/sessions.rpc';
import { hasStepDetails, StepDetails } from './step-details';
import { activityIconName, stepIconName, threadIcons } from './step-icons';
import {
  activityLabel,
  formatElapsed,
  formatStepDuration,
  hunksForDiff,
  isMachineStepTarget,
  stepKindLabel,
  stepTarget,
  touchedFiles,
  traceStepStatus,
  type TurnWork,
} from './thread';

/** A short tail of the Thought, shown while the Agent is thinking. */
const THOUGHT_TAIL_LENGTH = 60;
let nextDrawerId = 0;

/**
 * A fixed spinner, the current kind icon, the target and the elapsed time of a running Turn,
 * expandable on demand into an inline drawer of Steps, live tails, and touched files.
 */
@Component({
  selector: 'app-ticker',
  imports: [NgTemplateOutlet, NgIcon, HlmButtonImports, HlmTraceImports, DiffPatch, StepDetails],
  providers: [provideIcons(threadIcons)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', 'data-testid': 'ticker', '[attr.title]': 'accessibleName()' },
  template: `
    <div hlmTrace>
      <div
        hlmTraceCollapsible
        [expanded]="expanded()"
        [disabled]="work().endedAt !== null"
        (expandedChange)="onExpandedChange($event)"
      >
        <button
          type="button"
          hlmTraceCollapsibleTrigger
          hlmTraceLine
          class="w-full max-w-full cursor-pointer text-left"
          data-testid="ticker-toggle"
        >
          <ng-icon name="lucideLoaderCircle" class="size-4 shrink-0 animate-spin" />
          @if (icon(); as iconName) {
            <ng-icon [name]="iconName" class="size-4 shrink-0" />
          }
          @if (thinking(); as tail) {
            <span class="min-w-0 flex-1 truncate italic" [attr.aria-label]="accessibleName()">{{
              tail
            }}</span>
          } @else if (target(); as text) {
            <span
              class="min-w-0 flex-1 truncate"
              [class.font-mono]="isTargetMachine()"
              [class.text-xs]="isTargetMachine()"
              [attr.aria-label]="accessibleName()"
              >{{ text }}</span
            >
          } @else {
            <span class="min-w-0 flex-1 truncate" [attr.aria-label]="accessibleName()" i18n>
              Starting…
            </span>
          }
          <span class="tabular-nums shrink-0">{{ elapsed() }}</span>
        </button>

        @if (expanded()) {
          <hlm-trace-collapsible-content
            [id]="drawerId"
            contentInnerClasses="flex flex-col gap-2 text-xs"
            data-testid="ticker-drawer"
          >
            @if (work().steps.length === 0) {
              <p class="text-muted-foreground text-xs" data-testid="ticker-empty" i18n>
                No steps yet.
              </p>
            } @else {
              <div class="flex flex-col gap-1" data-testid="ticker-steps">
                @for (step of work().steps; track step.id) {
                  <div class="flex min-w-0 flex-col">
                    @if (canExpandStep(step)) {
                      <button
                        type="button"
                        hlmTraceLine
                        class="w-full text-left"
                        [status]="stepStatus(step.status)"
                        [attr.data-step-status]="step.status"
                        [attr.aria-expanded]="isStepExpanded(step.id)"
                        (click)="toggleStep(step.id)"
                        data-testid="ticker-step"
                      >
                        <ng-container
                          *ngTemplateOutlet="stepRowContent; context: { $implicit: step }"
                        />
                      </button>
                    } @else {
                      <div
                        hlmTraceLine
                        class="w-full"
                        [status]="stepStatus(step.status)"
                        [attr.data-step-status]="step.status"
                        data-testid="ticker-step"
                      >
                        <ng-container
                          *ngTemplateOutlet="stepRowContent; context: { $implicit: step }"
                        />
                      </div>
                    }
                    @if (canExpandStep(step) && isStepExpanded(step.id)) {
                      <app-step-details [step]="step" prefix="ticker-step" [live]="true" />
                    }
                  </div>
                }
              </div>
            }
            @if (files().length > 0) {
              <div class="flex flex-col gap-1.5 pt-1">
                <div class="flex flex-wrap items-center gap-1.5" data-testid="ticker-touched-files">
                  <span class="text-muted-foreground shrink-0 text-[11px]" i18n>Files touched</span>
                  @for (file of files(); track file.path) {
                    @if (file.diff !== null) {
                      <button
                        type="button"
                        hlmBtn
                        variant="outline"
                        size="sm"
                        class="h-6 px-2 font-mono text-xs font-normal"
                        [class.ring-primary]="selectedFile() === file.path"
                        [attr.aria-expanded]="selectedFile() === file.path"
                        [attr.title]="file.path"
                        (click)="toggleFile(file.path)"
                        data-testid="ticker-touched-file"
                      >
                        {{ file.name }}
                        @if (file.stats; as stats) {
                          <span class="text-muted-foreground tabular-nums">
                            +{{ stats.added }} −{{ stats.removed }}
                          </span>
                        }
                      </button>
                    } @else {
                      <span
                        class="bg-tray border-border/60 text-muted-foreground inline-flex h-6 items-center rounded-md border px-2 font-mono text-xs"
                        [attr.title]="file.path"
                        data-testid="ticker-touched-file"
                        >{{ file.name }}</span
                      >
                    }
                  }
                </div>
                @if (selectedFile(); as path) {
                  @if (diffFor(path); as hunks) {
                    <div class="max-h-60 overflow-auto" data-testid="ticker-file-diff">
                      <app-diff-patch [hunks]="hunks" />
                    </div>
                  }
                }
              </div>
            }
          </hlm-trace-collapsible-content>
        }
      </div>
    </div>

    <ng-template #stepRowContent let-step>
      <ng-icon hlmTraceIcon [name]="stepIconName(step.kind)" />
      <span
        hlmTraceTitle
        [class.font-mono]="isMachineTarget(step)"
        [class.text-xs]="isMachineTarget(step)"
        data-testid="ticker-step-title"
        >{{ stepTarget(step) }}</span
      >
      <span class="ms-auto flex shrink-0 items-center gap-2">
        <span
          class="text-xs"
          [class.text-destructive]="step.status === 'failed'"
          [class.text-muted-foreground]="step.status !== 'failed'"
          data-testid="ticker-step-status"
          >{{ stepStatusLabel(step.status) }}</span
        >
        @if (stepDurationLabel(step); as duration) {
          <span class="text-muted-foreground tabular-nums" data-testid="ticker-step-duration">{{
            duration
          }}</span>
        }
      </span>
    </ng-template>
  `,
})
export class Ticker {
  readonly work = input.required<TurnWork>();
  readonly now = input.required<number>();
  readonly turnId = input<TurnId | null>(null);

  protected readonly drawerId = `ticker-drawer-${++nextDrawerId}`;

  private readonly activeTurnKey = computed(() => {
    const work = this.work();
    if (work.endedAt !== null) return null;
    return `${this.turnId() ?? ''}:${work.startedAt}`;
  });

  protected readonly expanded = linkedSignal<string | null, boolean>({
    source: this.activeTurnKey,
    computation: (key) => key !== null && untracked(() => this.work().workflow !== undefined),
  });

  private readonly expandedSteps = linkedSignal<string | null, ReadonlySet<StepId>>({
    source: this.activeTurnKey,
    computation: () => new Set(),
  });

  protected readonly selectedFile = linkedSignal<string | null, string | null>({
    source: this.activeTurnKey,
    computation: () => null,
  });

  protected readonly files = computed(() => touchedFiles(this.work()));

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

  protected readonly isTargetMachine = computed(() => {
    const work = this.work();
    if (work.activity !== 'step') return false;
    const step = work.steps.at(-1);
    return step !== undefined && isMachineStepTarget(step);
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

  protected onExpandedChange(next: boolean): void {
    if (this.work().endedAt !== null) return;
    this.expanded.set(next);
  }

  protected canExpandStep(step: Step): boolean {
    return step.kind === 'execute' || hasStepDetails(step);
  }

  protected isStepExpanded(id: StepId): boolean {
    return this.expandedSteps().has(id);
  }

  protected toggleStep(id: StepId): void {
    this.expandedSteps.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected toggleFile(path: string): void {
    this.selectedFile.update((current) => (current === path ? null : path));
  }

  protected diffFor(path: string): ReadonlyArray<DiffHunk> | null {
    const file = this.files().find((entry) => entry.path === path);
    return file?.diff ? hunksForDiff(file.diff) : null;
  }

  protected stepDurationLabel(step: Step): string | null {
    if (step.startedAt === undefined) return null;
    const end = step.endedAt ?? this.now();
    return formatStepDuration(Math.max(0, end - step.startedAt));
  }

  protected stepStatusLabel(status: Step['status']): string {
    switch (status) {
      case 'pending':
        return $localize`Pending`;
      case 'running':
        return $localize`Running`;
      case 'done':
        return $localize`Done`;
      case 'failed':
        return $localize`Failed`;
      case 'cancelled':
        return $localize`Cancelled`;
    }
  }

  protected readonly stepIconName = stepIconName;
  protected readonly stepTarget = stepTarget;
  protected readonly isMachineTarget = isMachineStepTarget;
  protected readonly stepStatus = traceStepStatus;
}
