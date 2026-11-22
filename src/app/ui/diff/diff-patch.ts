import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { DiffHunk, DiffLine } from './diff-model';
import { toSplitRows } from './diff-split';
@Component({
  selector: 'app-diff-patch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="border-border/60 bg-card overflow-hidden rounded-xl border">
      @for (hunk of hunks(); track $index) {
        <div
          class="bg-tray text-muted-foreground border-border/60 border-b px-3 py-1 font-mono text-[11px]"
        >
          {{ hunk.header }}
        </div>
        <div class="overflow-x-auto py-1 font-mono text-xs leading-5">
          @if (mode() === 'split') {
            <div class="grid min-w-max grid-cols-2">
              @for (row of splitRows(hunk); track $index) {
                <div
                  class="flex whitespace-pre"
                  [class]="row.left ? lineClass(row.left) : ''"
                  data-testid="diff-split-left"
                >
                  <span
                    class="text-muted-foreground w-10 shrink-0 pr-2.5 text-right select-none"
                    aria-hidden="true"
                    >{{ row.left?.oldLine ?? row.left?.newLine }}</span
                  >
                  <span class="w-3.5 shrink-0 select-none" aria-hidden="true">{{
                    row.left ? linePrefix(row.left) : ''
                  }}</span>
                  <span>{{ row.left?.text }}</span>
                </div>
                <div
                  class="border-border/60 flex border-l whitespace-pre"
                  [class]="row.right ? lineClass(row.right) : ''"
                  data-testid="diff-split-right"
                >
                  <span
                    class="text-muted-foreground w-10 shrink-0 pr-2.5 text-right select-none"
                    aria-hidden="true"
                    >{{ row.right?.newLine ?? row.right?.oldLine }}</span
                  >
                  <span class="w-3.5 shrink-0 select-none" aria-hidden="true">{{
                    row.right ? linePrefix(row.right) : ''
                  }}</span>
                  <span>{{ row.right?.text }}</span>
                </div>
              }
            </div>
          } @else {
            <div class="min-w-max">
              @for (line of hunk.lines; track $index) {
                <div class="flex whitespace-pre" [class]="lineClass(line)" data-testid="diff-line">
                  <span
                    class="text-muted-foreground w-10 shrink-0 pr-2.5 text-right select-none"
                    aria-hidden="true"
                    >{{ line.oldLine }}</span
                  >
                  <span
                    class="text-muted-foreground w-10 shrink-0 pr-2.5 text-right select-none"
                    aria-hidden="true"
                    >{{ line.newLine }}</span
                  >
                  <span class="w-3.5 shrink-0 select-none" aria-hidden="true">{{
                    linePrefix(line)
                  }}</span>
                  <span>{{ line.text }}</span>
                </div>
              }
            </div>
          }
        </div>
      }
      @if (truncated()) {
        <p class="text-muted-foreground border-border/60 border-t px-3 py-1.5 text-xs" i18n>
          This diff is long; only the start is shown.
        </p>
      }
    </div>
  `,
})
export class DiffPatch {
  readonly hunks = input.required<ReadonlyArray<DiffHunk>>();
  readonly truncated = input(false);
  readonly mode = input<'unified' | 'split'>('unified');
  protected splitRows(hunk: DiffHunk) {
    return toSplitRows(hunk.lines);
  }

  protected lineClass(line: DiffLine): string {
    if (line.kind === 'add') return 'bg-diff-add/10';
    if (line.kind === 'delete') return 'bg-diff-del/10';
    return '';
  }

  protected linePrefix(line: DiffLine): string {
    if (line.kind === 'add') return '+';
    if (line.kind === 'delete') return '−';
    return '';
  }
}
