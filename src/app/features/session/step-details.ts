import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { HlmBadgeImports } from '@ui/badge';
import { DiffPatch } from '@ui/diff';
import type { Step } from '../../../shared/sessions/sessions.rpc';
import { hunksForDiff } from './thread';

/** Whether a Step has recorded structured details (`cwd`, `input`, `output`, `outputTruncated`, `exitCode`, or `diffs`). */
export const hasStepDetails = (step: Step): boolean =>
  Boolean(step.cwd) ||
  Boolean(step.input) ||
  step.output !== '' ||
  Boolean(step.outputTruncated) ||
  step.exitCode !== undefined ||
  step.diffs.length > 0;

/** Shared inline Step inspection panel used by both `<app-receipt>` and `<app-ticker>`. */
@Component({
  selector: 'app-step-details',
  imports: [HlmBadgeImports, DiffPatch],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let item = step();
    <div
      [class]="
        live()
          ? 'border-border/60 mt-1 mb-1 ml-3 flex flex-col gap-1.5 border-l pl-3 text-xs'
          : 'border-border/60 mt-1 mb-1.5 ml-3 flex flex-col gap-2 border-l pl-3 text-xs'
      "
      [attr.data-testid]="prefix() === 'ticker-step' ? 'ticker-step-tail' : 'receipt-step-details'"
    >
      @if (item.cwd) {
        <div class="flex flex-col gap-1">
          <span class="text-muted-foreground" i18n>Working directory</span>
          <div
            class="text-foreground font-mono text-xs break-all"
            [attr.data-testid]="prefix() + '-cwd'"
          >
            {{ item.cwd }}
          </div>
        </div>
      }
      @if (item.input) {
        <div class="flex flex-col gap-1">
          <span class="text-muted-foreground" i18n>Input</span>
          <pre
            class="bg-tray border-border/60 text-foreground max-h-48 overflow-auto rounded-md border px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all"
            [attr.data-testid]="prefix() + '-input'"
            >{{ item.input }}</pre>
        </div>
      }
      @if (hasOutputSection()) {
        <div class="flex flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-muted-foreground" i18n>Output</span>
            @if (item.exitCode !== undefined) {
              <span
                hlmBadge
                [variant]="item.exitCode === 0 ? 'secondary' : 'destructive'"
                class="tabular-nums"
                [attr.data-testid]="prefix() + '-exit-code'"
                i18n
                >Exit {{ item.exitCode }}</span
              >
            }
            @if (item.outputTruncated) {
              <span class="flex items-center gap-1.5" [attr.data-testid]="prefix() + '-truncated'">
                <span hlmBadge variant="secondary" i18n>Truncated</span>
                <span class="text-muted-foreground text-xs" i18n>Showing the last 32 KB.</span>
              </span>
            }
          </div>
          @if (item.output !== '') {
            <pre
              class="bg-tray border-border/60 text-foreground max-h-60 overflow-auto rounded-md border px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all"
              [attr.data-testid]="prefix() + '-output'"
              >{{ item.output }}</pre>
          }
        </div>
      } @else if (live() && item.kind === 'execute') {
        <p
          class="text-muted-foreground text-xs"
          [attr.data-testid]="prefix() + '-output-empty'"
          i18n
        >
          Waiting for output…
        </p>
      }
      @for (diff of item.diffs; track diff.path + '-' + $index) {
        <div class="flex flex-col gap-1" [attr.data-testid]="prefix() + '-diff'">
          <div class="text-muted-foreground font-mono text-xs break-all">
            {{ diff.path }}
          </div>
          <app-diff-patch [hunks]="hunksForDiff(diff)" />
        </div>
      }
      @if (!live() && !hasDetails()) {
        <p class="text-muted-foreground text-xs" i18n>No details recorded.</p>
      }
    </div>
  `,
})
export class StepDetails {
  readonly step = input.required<Step>();
  readonly prefix = input<'receipt-step' | 'ticker-step'>('receipt-step');
  readonly live = input(false);

  protected readonly hasDetails = computed(() => hasStepDetails(this.step()));
  protected readonly hasOutputSection = computed(() => {
    const item = this.step();
    return item.output !== '' || Boolean(item.outputTruncated) || item.exitCode !== undefined;
  });
  protected readonly hunksForDiff = hunksForDiff;
}
