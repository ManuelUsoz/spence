import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { HlmButtonImports } from '@ui/button';

/**
 * Notice bar docked above the Composer when a reopened Session's Agent context could not be restored.
 * Gates Send until the user chooses to prepare a summary handoff (#75) or start with an empty context.
 */
@Component({
  selector: 'app-memory-lost-bar',
  imports: [HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="bg-muted flex flex-wrap items-center justify-between gap-2 rounded-md p-2 text-sm"
      data-testid="memory-lost-bar"
    >
      <span i18n>Previous context couldn't be restored.</span>
      <div class="flex flex-wrap items-center gap-2">
        @if (canPrepareHandoff()) {
          <button
            hlmBtn
            type="button"
            variant="outline"
            size="sm"
            data-testid="prepare-summary-handoff"
            [disabled]="resolving()"
            (click)="prepareSummaryHandoff.emit()"
            i18n
          >
            Prepare summary handoff
          </button>
        }
        <button
          hlmBtn
          type="button"
          size="sm"
          data-testid="start-empty-context"
          [disabled]="resolving()"
          (click)="startEmptyContext.emit()"
          i18n
        >
          Start with empty context
        </button>
      </div>
    </div>
  `,
})
export class MemoryLostBar {
  readonly resolving = input<boolean>(false);
  /** Seam for #75 to enable the Prepare summary handoff action. */
  readonly canPrepareHandoff = input<boolean>(false);
  readonly startEmptyContext = output<void>();
  readonly prepareSummaryHandoff = output<void>();
}
