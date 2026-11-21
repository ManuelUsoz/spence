import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import type { ChangedFile, DiffResult } from '../../../shared/source-control/source-control.rpc';
import { DiffModeToggle } from './diff-mode-toggle';
import { DiffViewer, type DiffMode } from './diff-viewer';
import { FilePath, LineCounts, StatusMark } from './file-label';
import { Icon } from './icon';
import type { Load } from './load';

/**
 * The right side of Changes: the open file's path and counts, the Unified / Split switch, Discard for that file,
 * "1 of 4" with Previous / Next, and its diff.
 */
@Component({
  selector: 'app-file-diff-pane',
  imports: [DiffModeToggle, DiffViewer, FilePath, HlmButtonImports, Icon, LineCounts, StatusMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col', 'data-testid': 'file-diff-pane' },
  template: `
    @if (file(); as current) {
      <div
        class="border-border/60 flex min-h-12 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b py-1.5 pr-3 pl-4"
      >
        <app-status-mark [status]="current.status" />
        <app-file-path [path]="current.path" data-testid="diff-path" />
        <app-line-counts [additions]="current.additions" [deletions]="current.deletions" />
        <span class="flex-1"></span>
        <app-diff-mode-toggle
          [mode]="mode()"
          testIdPrefix="diff-mode"
          (modeChange)="modeChange.emit($event)"
        />
        <button
          type="button"
          hlmBtn
          variant="ghost"
          size="icon"
          data-testid="diff-discard"
          aria-label="Discard changes to this file"
          i18n-aria-label
          title="Discard changes to this file"
          i18n-title
          [disabled]="current.status === 'Conflicted'"
          (click)="discard.emit()"
        >
          <app-icon name="undo" />
        </button>
        <span
          class="text-muted-foreground text-xs whitespace-nowrap tabular-nums"
          data-testid="diff-position"
          >{{ position() }}</span
        >
        <button
          type="button"
          hlmBtn
          variant="ghost"
          size="icon"
          data-testid="diff-prev"
          aria-label="Previous file"
          i18n-aria-label
          title="Previous file"
          i18n-title
          [disabled]="index() <= 0"
          (click)="prev.emit()"
        >
          <app-icon name="chevron-up" />
        </button>
        <button
          type="button"
          hlmBtn
          variant="ghost"
          size="icon"
          data-testid="diff-next"
          aria-label="Next file"
          i18n-aria-label
          title="Next file"
          i18n-title
          [disabled]="index() >= total() - 1"
          (click)="next.emit()"
        >
          <app-icon name="chevron-down" />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto p-4">
        <app-diff-viewer [state]="state()" [mode]="mode()" />
      </div>
    } @else {
      <p class="text-muted-foreground p-6 text-sm" data-testid="diff-empty" i18n>
        Choose a file to see its diff.
      </p>
    }
  `,
})
export class FileDiffPane {
  /** The open file, or null when none is chosen. */
  readonly file = input<ChangedFile | null>(null);
  readonly state = input.required<Load<DiffResult>>();
  /** Zero-based place of the file in the list. */
  readonly index = input<number>(0);
  readonly total = input<number>(0);
  readonly mode = input<DiffMode>('unified');

  readonly modeChange = output<DiffMode>();
  readonly discard = output<void>();
  readonly prev = output<void>();
  readonly next = output<void>();

  protected position(): string {
    const place = this.index() + 1;
    const total = this.total();
    return $localize`${place} of ${total}`;
  }
}
