import { DiffPatch, type DiffHunk } from '@ui/diff';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButtonImports } from '@ui/button';
import { HlmTraceImports } from '@ui/trace';
import {
  changedFiles,
  diffStats,
  formatElapsed,
  formatStepDuration,
  hunksForDiff,
  stepTarget,
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
  imports: [NgIcon, HlmBadgeImports, HlmButtonImports, HlmTraceImports, DiffPatch],
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
            class="font-mono text-xs"
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
      <div hlmTraceCollapsible>
        <button type="button" hlmTraceCollapsibleTrigger hlmTraceLine>
          <span hlmTraceTitle i18n>
            {work().steps.length, plural, =1 {1 step} other {{{ work().steps.length }} steps}}
          </span>
          <span hlmTraceDescription>{{ totalTime() }}</span>
        </button>
        <hlm-trace-collapsible-content contentInnerClasses="flex flex-col gap-1">
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
                <div
                  class="border-border/60 mt-1 mb-1.5 ml-3 flex flex-col gap-2 border-l pl-3 text-xs"
                  data-testid="receipt-step-details"
                >
                  @if (step.cwd) {
                    <div class="flex flex-col gap-1">
                      <span class="text-muted-foreground" i18n>Working directory</span>
                      <div
                        class="text-foreground font-mono text-xs break-all"
                        data-testid="receipt-step-cwd"
                      >
                        {{ step.cwd }}
                      </div>
                    </div>
                  }
                  @if (step.input) {
                    <div class="flex flex-col gap-1">
                      <span class="text-muted-foreground" i18n>Input</span>
                      <pre
                        class="bg-tray border-border/60 text-foreground max-h-48 overflow-auto rounded-md border px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all"
                        data-testid="receipt-step-input"
                        >{{ step.input }}</pre>
                    </div>
                  }
                  @if (step.output !== '' || step.exitCode !== undefined) {
                    <div class="flex flex-col gap-1">
                      <div class="flex items-center gap-2">
                        <span class="text-muted-foreground" i18n>Output</span>
                        @if (step.exitCode !== undefined) {
                          <span
                            hlmBadge
                            [variant]="step.exitCode === 0 ? 'secondary' : 'destructive'"
                            class="tabular-nums"
                            data-testid="receipt-step-exit-code"
                            i18n
                            >Exit {{ step.exitCode }}</span
                          >
                        }
                      </div>
                      @if (step.output !== '') {
                        <pre
                          class="bg-tray border-border/60 text-foreground max-h-60 overflow-auto rounded-md border px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all"
                          data-testid="receipt-step-output"
                          >{{ step.output }}</pre>
                      }
                      @if (step.outputTruncated) {
                        <p
                          class="text-muted-foreground text-xs"
                          data-testid="receipt-step-truncated"
                          i18n
                        >
                          Output truncated to the last 32 KB.
                        </p>
                      }
                    </div>
                  }
                  @for (diff of step.diffs; track diff.path + '-' + $index) {
                    <div class="flex flex-col gap-1" data-testid="receipt-step-diff">
                      <div class="text-muted-foreground font-mono text-xs break-all">
                        {{ diff.path }}
                      </div>
                      <app-diff-patch [hunks]="hunksForDiff(diff)" />
                    </div>
                  }
                  @if (!hasStepDetails(step)) {
                    <p class="text-muted-foreground text-xs" i18n>No details recorded.</p>
                  }
                </div>
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
          <hlm-trace-collapsible-content>
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
  protected isMachineTarget(step: StepItem): boolean {
    return (
      step.kind === 'execute' ||
      ((step.kind === 'read' ||
        step.kind === 'edit' ||
        step.kind === 'delete' ||
        step.kind === 'move') &&
        step.files.length > 0)
    );
  }

  protected readonly selectedFile = signal<string | null>(null);
  protected readonly expandedSteps = signal<ReadonlySet<StepItem['id']>>(new Set());

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

  protected hasStepDetails(step: StepItem): boolean {
    return (
      Boolean(step.cwd) ||
      Boolean(step.input) ||
      step.output !== '' ||
      step.exitCode !== undefined ||
      step.diffs.length > 0
    );
  }

  protected readonly hunksForDiff = hunksForDiff;

  protected diffFor(path: string): ReadonlyArray<DiffHunk> {
    const file = changedFiles(this.work()).find((entry) => entry.path === path);
    return file === undefined ? [] : hunksForDiff(file.diff);
  }

  protected stepStatus(status: StepItem['status']): 'running' | 'error' | 'pending' | undefined {
    switch (status) {
      case 'running':
        return 'running';
      case 'failed':
        return 'error';
      case 'pending':
        return 'pending';
      case 'done':
      case 'cancelled':
        return undefined;
    }
  }

  protected readonly stepIconName = stepIconName;
  protected readonly stepTarget = stepTarget;
}
