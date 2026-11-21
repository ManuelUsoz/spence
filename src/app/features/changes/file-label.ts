import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { FileChangeStatus } from '../../../shared/source-control/source-control.rpc';
import { splitPath, statusClass, statusLabel, statusMark } from './file-status';

/** The one-letter mark of a file's status; screen readers get the word. */
@Component({
  selector: 'app-status-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'w-3 shrink-0 text-[11px] font-semibold',
    role: 'img',
    '[class]': 'colour()',
    '[attr.aria-label]': 'label()',
  },
  template: `{{ mark() }}`,
})
export class StatusMark {
  readonly status = input.required<FileChangeStatus>();
  protected readonly mark = computed(() => statusMark(this.status()));
  protected readonly colour = computed(() => statusClass(this.status()));
  protected readonly label = computed(() => statusLabel(this.status()));
}

/** A path as Goeist Mono: the folder quiet, the name at full strength (never bold: it is mono). */
@Component({
  selector: 'app-file-path',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'min-w-0 truncate font-mono text-xs' },
  template: `<span class="text-muted-foreground">{{ dir() }}</span
    ><span>{{ name() }}</span>`,
})
export class FilePath {
  readonly path = input.required<string>();
  private readonly parts = computed(() => splitPath(this.path()));
  protected readonly dir = computed(() => (this.parts().dir === '' ? '' : `${this.parts().dir}/`));
  protected readonly name = computed(() => this.parts().name);
}

/** `+a −d` for one file; a side Git cannot count (binary) is left out. */
@Component({
  selector: 'app-line-counts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex shrink-0 gap-1.5 font-mono text-xs tabular-nums' },
  template: `
    @if (additions() !== null) {
      <span class="text-diff-add">+{{ additions() }}</span>
    }
    @if (deletions() !== null) {
      <span class="text-diff-del">−{{ deletions() }}</span>
    }
  `,
})
export class LineCounts {
  readonly additions = input<number | null>(null);
  readonly deletions = input<number | null>(null);
}
