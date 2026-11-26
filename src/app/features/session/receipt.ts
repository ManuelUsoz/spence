import { DiffPatch, type DiffHunk } from '@ui/diff';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { HlmButtonImports } from '@ui/button';
import { HlmTraceImports } from '@ui/trace';
import { StepDetails } from './step-details';
import {
  changedFiles,
  diffStats,
  formatElapsed,
  formatStepDuration,
  hunksForDiff,
  isMachineStepTarget,
  stepTarget,
  traceStepStatus,
  permissionMark,
  type ThreadPermission,
  type TurnWork,
} from './thread';
import { stepIconName, threadIcons } from './step-icons';

const SLOW_STEP_MS = 10_000;
type StepItem = TurnWork['steps'][number];

/** The finished Turn folded into a Receipt: changed files, Steps, Thought and total time. */
@Component({
  selector: 'app-receipt',
  imports: [NgIcon, HlmButtonImports, HlmTraceImports, DiffPatch, StepDetails],
  providers: [provideIcons(threadIcons)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-2 text-sm', 'data-testid': 'receipt' },
  template: `
    @if (files().length > 0) {
      <div class="flex flex-wrap gap-2">
        @for (file of files(); track file.path) {
          <button
            type="button"
            hlmBtn
            variant="outline"
            size="sm"
            class="font-mono text-xs font-normal"
            [class.ring-primary]="selectedFile() === file.path"
            (click)="toggleFile(file.path)"
            [attr.aria-expanded]="selectedFile() === file.path"
          >
            {{ file.name }}
            <span class="tabular-nums text-muted-foreground">
              +{{ file.stats.added }} −{{ file.stats.removed }}
            </span>
          </button>
        }
      </div>
    }

    @if (selectedFile(); as path) {
      <div data-testid="file-diff">
        <app-diff-patch [hunks]="diffFor(path)" />
      </div>
    }

    <div hlmTrace>
      <div
        hlmTraceCollapsible
        [expanded]="stepsExpanded()"
        (expandedChange)="stepsExpanded.set($event)"
      >
        <button type="button" hlmTraceCollapsibleTrigger hlmTraceLine>
          <span hlmTraceTitle i18n>
            {work().steps.length, plural, =1 {1 step} other {{{ work().steps.length }} steps}}
          </span>
          <span hlmTraceDescription>{{ totalTime() }}</span>
        </button>
        <hlm-trace-collapsible-content
          class="data-[state=closed]:invisible"
          contentInnerClasses="flex flex-col gap-1"
        >
          @for (step of work().steps; track step.id) {
            <div class="flex min-w-0 flex-col">
              <button
                type="button"
                hlmTraceLine
                class="w-full text-left"
                [status]="stepStatus(step.status)"
                [attr.aria-expanded]="isStepExpanded(step.id)"
                [attr.data-slow]="isSlowStep(step) ? 'true' : null"
                (click)="toggleStep(step.id)"
                data-testid="receipt-step"
              >
                <ng-icon hlmTraceIcon [name]="stepIconName(step.kind)" />
                <span
                  hlmTraceTitle
                  [class.font-mono]="isMachineTarget(step)"
                  [class.text-xs]="isMachineTarget(step)"
                  data-testid="receipt-step-title"
                  >{{ stepTarget(step) }}</span
                >
                @if (permissionMark(step, permissions()); as mark) {
                  @switch (mark) {
                    @case ('auto') {
                      <span class="text-xs" data-testid="receipt-mark" i18n>auto</span>
                    }
                    @case ('rejected') {
                      <span class="text-xs" data-testid="receipt-mark" i18n>rejected</span>
                    }
                  }
                }
                @if (step.status === 'failed') {
                  <span class="text-destructive" aria-label="Failed" i18n-aria-label>✕</span>
                }
                @if (stepDurationLabel(step); as duration) {
                  <span
                    class="ms-auto shrink-0 tabular-nums"
                    [class.text-[var(--attention)]]="isSlowStep(step)"
                    [class.font-medium]="isSlowStep(step)"
                    [class.bg-[var(--attention)]/10]="isSlowStep(step)"
                    [class.rounded]="isSlowStep(step)"
                    [class.px-1.5]="isSlowStep(step)"
                    [attr.data-slow]="isSlowStep(step) ? 'true' : null"
                    data-testid="receipt-step-duration"
                    >{{ duration }}</span
                  >
                }
              </button>
              @if (isStepExpanded(step.id)) {
                <app-step-details [step]="step" prefix="receipt-step" />
              }
            </div>
          }
        </hlm-trace-collapsible-content>
      </div>
    </div>

    @if (work().thought !== '') {
      <div hlmTrace>
        <div hlmTraceCollapsible>
          <button type="button" hlmTraceCollapsibleTrigger hlmTraceLine>
            <span hlmTraceTitle i18n>Thought {{ thoughtSeconds() }}s</span>
          </button>
          <hlm-trace-collapsible-content class="data-[state=closed]:invisible">
            <p class="whitespace-pre-wrap italic">{{ displayThought() }}</p>
          </hlm-trace-collapsible-content>
        </div>
      </div>
    }
  `,
})
export class Receipt {
  readonly work = input.required<TurnWork>();
  readonly permissions = input.required<ReadonlyArray<ThreadPermission>>();

  protected readonly permissionMark = permissionMark;
  protected readonly isMachineTarget = isMachineStepTarget;

  protected readonly selectedFile = signal<string | null>(null);
  protected readonly expandedSteps = signal<ReadonlySet<StepItem['id']>>(new Set());
  /** Workflow Steps are part of the Turn's Receipt like any other Step: quiet and folded until opened. */
  protected readonly stepsExpanded = signal(false);

  protected readonly files = computed(() =>
    changedFiles(this.work()).map((file) => {
      const name = file.path.split('/').at(-1) ?? file.path;
      return { path: file.path, name, stats: diffStats(file.diff.before, file.diff.after) };
    }),
  );

  protected readonly totalTime = computed(() => {
    const work = this.work();
    return work.endedAt === null ? '' : formatElapsed(work.endedAt - work.startedAt);
  });

  protected readonly displayThought = computed(() =>
    this.work()
      .thought.trim()
      .replace(/\r?\n(?:[\t ]*\r?\n)+/g, '\n'),
  );

  protected readonly thoughtSeconds = computed(() =>
    Math.max(0, Math.round(this.work().thoughtMs / 1000)),
  );

  protected toggleFile(path: string): void {
    this.selectedFile.update((current) => (current === path ? null : path));
  }

  protected isStepExpanded(id: StepItem['id']): boolean {
    return this.expandedSteps().has(id);
  }

  protected toggleStep(id: StepItem['id']): void {
    this.expandedSteps.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected stepDurationMs(step: StepItem): number | null {
    if (step.startedAt === undefined || step.endedAt === undefined) return null;
    return Math.max(0, step.endedAt - step.startedAt);
  }

  protected stepDurationLabel(step: StepItem): string | null {
    const ms = this.stepDurationMs(step);
    return ms === null ? null : formatStepDuration(ms);
  }

  protected isSlowStep(step: StepItem): boolean {
    const ms = this.stepDurationMs(step);
    return ms !== null && ms >= SLOW_STEP_MS;
  }

  protected diffFor(path: string): ReadonlyArray<DiffHunk> {
    const file = changedFiles(this.work()).find((entry) => entry.path === path);
    return file === undefined ? [] : hunksForDiff(file.diff);
  }

  protected readonly stepStatus = traceStepStatus;

  protected readonly stepIconName = stepIconName;
  protected readonly stepTarget = stepTarget;
}
