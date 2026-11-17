import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HlmLabelImports } from '@ui/label';

/** One Setting: a label and an optional hint on the left, its control (projected) on the right. */
@Component({
  selector: 'app-settings-row',
  imports: [HlmLabelImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="border-border/60 flex items-center gap-6 border-t py-3">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        @if (controlId(); as id) {
          <label hlmLabel [for]="id" class="text-sm font-normal">{{ label() }}</label>
        } @else {
          <span hlmLabel [attr.id]="labelId() ?? null" class="text-sm font-normal">{{
            label()
          }}</span>
        }
        @if (hint(); as text) {
          <span class="text-muted-foreground text-xs">{{ text }}</span>
        }
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <ng-content />
      </div>
    </div>
  `,
})
export class SettingsRow {
  readonly label = input.required<string>();
  readonly hint = input<string>();
  /** The id of the form control to label; without it, the label is a span with `labelId` for `aria-labelledby`. */
  readonly controlId = input<string>();
  readonly labelId = input<string>();
}
