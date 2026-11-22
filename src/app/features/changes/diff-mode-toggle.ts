import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { DiffMode } from './diff-viewer';
import { segmentClass } from './segment';

/** The Unified / Split switch above a diff. `testIdPrefix` keeps each place's buttons apart for tests. */
@Component({
  selector: 'app-diff-mode-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bg-accent flex shrink-0 gap-0.5 rounded-[9px] p-0.5',
    role: 'group',
    '[attr.aria-label]': 'label',
  },
  template: `
    <button
      type="button"
      class="h-6 rounded-[7px] px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      [class]="segmentClass(mode() === 'unified')"
      [attr.data-testid]="testIdPrefix() + '-unified'"
      [attr.aria-pressed]="mode() === 'unified'"
      (click)="modeChange.emit('unified')"
      i18n
    >
      Unified
    </button>
    <button
      type="button"
      class="h-6 rounded-[7px] px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      [class]="segmentClass(mode() === 'split')"
      [attr.data-testid]="testIdPrefix() + '-split'"
      [attr.aria-pressed]="mode() === 'split'"
      (click)="modeChange.emit('split')"
      i18n
    >
      Split
    </button>
  `,
})
export class DiffModeToggle {
  readonly mode = input.required<DiffMode>();
  readonly testIdPrefix = input<string>('diff-mode');
  readonly modeChange = output<DiffMode>();

  protected readonly label = $localize`Diff layout`;
  protected readonly segmentClass = segmentClass;
}
