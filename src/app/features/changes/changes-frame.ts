import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Icon } from './icon';

/** Which pane of a narrow frame is showing. */
export type FramePane = 'list' | 'viewer';

/**
 * The frame Changes, History and Files share: a list on the left that is always 340px wide and a viewer on the
 * right, so switching tabs moves nothing. When the frame is narrower than 48rem only one pane shows at a time:
 * `view` says which, and the viewer gets a Back button that emits `back`. It knows nothing about Git or files.
 */
@Component({
  selector: 'app-changes-frame',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: '@container flex min-h-0 min-w-0 flex-1', 'data-testid': 'changes-frame' },
  template: `
    <aside
      class="border-border/60 flex min-h-0 w-full flex-col border-r data-[view=viewer]:@max-3xl:hidden @3xl:w-[340px] @3xl:shrink-0"
      [attr.data-view]="view()"
      data-testid="changes-list-pane"
    >
      <ng-content select="[list]" />
    </aside>
    <section
      class="flex min-h-0 min-w-0 flex-1 flex-col data-[view=list]:@max-3xl:hidden"
      [attr.data-view]="view()"
      data-testid="changes-viewer-pane"
    >
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring border-border/60 flex h-9 shrink-0 items-center gap-1 border-b px-3 text-left text-xs outline-none focus-visible:ring-2 @3xl:hidden"
        data-testid="changes-viewer-back"
        (click)="back.emit()"
      >
        <app-icon name="back" />
        <span i18n>Back to the list</span>
      </button>
      <ng-content select="[viewer]" />
    </section>
  `,
})
export class ChangesFrame {
  /** Which pane a narrow frame shows. A wide frame shows both. */
  readonly view = input<FramePane>('list');
  readonly back = output<void>();
}
