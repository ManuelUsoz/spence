import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { HlmButtonImports } from '@ui/button';
import { HlmTraceImports } from '@ui/trace';
import {
  changedFiles,
  diffLines,
  diffStats,
  formatElapsed,
  stepTarget,
  type TurnWork,
} from './thread';
import { stepIconName, threadIcons } from './step-icons';

/** The finished Turn folded into a Receipt: changed files, Steps, Thought and total time. */
@Component({
  selector: 'app-receipt',
  imports: [NgIcon, HlmButtonImports, HlmTraceImports],
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
      <div
        class="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs"
        data-testid="file-diff"
      >
        @for (line of diffFor(path); track $index) {
          <div [class]="lineClass(line.mark)">
            <span class="select-none">{{ line.mark }}</span>
            {{ line.text }}
          </div>
        }
      </div>
    }

    <div hlmTrace>
      <div hlmTraceCollapsible>
        <button hlmTraceCollapsibleTrigger hlmTraceLine>
          <span hlmTraceTitle i18n>{{ work().steps.length }} steps</span>
          <span hlmTraceDescription>{{ totalTime() }}</span>
        </button>
        <hlm-trace-collapsible-content>
          @for (step of work().steps; track step.id) {
            <div hlmTraceLine [status]="stepStatus(step.status)">
              <ng-icon hlmTraceIcon [name]="stepIconName(step.kind)" />
              <span hlmTraceTitle class="font-mono text-xs">{{ stepTarget(step) }}</span>
              @if (step.status === 'failed') {
                <span class="text-destructive" aria-label="Failed">✕</span>
              }
            </div>
          }
        </hlm-trace-collapsible-content>
      </div>
    </div>

    @if (work().thought !== '') {
      <div hlmTrace>
        <div hlmTraceCollapsible>
          <button hlmTraceCollapsibleTrigger hlmTraceLine>
            <span hlmTraceTitle i18n>Thought {{ thoughtSeconds() }}s</span>
          </button>
          <hlm-trace-collapsible-content>
            <p class="whitespace-pre-wrap italic">{{ work().thought }}</p>
          </hlm-trace-collapsible-content>
        </div>
      </div>
    }
  `,
})
export class Receipt {
  readonly work = input.required<TurnWork>();

  protected readonly selectedFile = signal<string | null>(null);

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

  protected readonly thoughtSeconds = computed(() =>
    Math.max(0, Math.round(this.work().thoughtMs / 1000)),
  );

  protected toggleFile(path: string): void {
    this.selectedFile.update((current) => (current === path ? null : path));
  }

  protected diffFor(path: string): ReadonlyArray<{ mark: '-' | '+' | ' '; text: string }> {
    const file = changedFiles(this.work()).find((f) => f.path === path);
    if (file === undefined) return [];
    return diffLines(file.diff.before, file.diff.after);
  }

  protected lineClass(mark: '-' | '+' | ' '): string {
    switch (mark) {
      case '-':
        return 'text-destructive';
      case '+':
        return 'text-foreground';
      case ' ':
        return 'text-muted-foreground';
    }
  }

  protected stepStatus(
    status: TurnWork['steps'][number]['status'],
  ): 'running' | 'error' | 'pending' | undefined {
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
