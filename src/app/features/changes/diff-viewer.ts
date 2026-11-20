import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type {
  DiffHunk,
  DiffLine,
  DiffResult,
} from '../../../shared/source-control/source-control.rpc';
import { unavailableText } from '../../core/git-text';
import { toSplitRows } from './diff-split';
import { valueOf, type Load } from './load';

export type DiffMode = 'unified' | 'split';

type NoPreviewReason = Extract<DiffResult, { _tag: 'NoPreview' }>['reason'];

/**
 * One file's diff, as a card of hunks, unified or side by side. It reads nothing: the page hands it the state of
 * a read, so Changes and History show diffs the same way.
 */
@Component({
  selector: 'app-diff-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', 'data-testid': 'change-diff' },
  template: `
    @switch (state().status) {
      @case ('loading') {
        <p class="text-muted-foreground p-3 text-xs" i18n>Loading…</p>
      }
      @case ('failed') {
        <p class="text-destructive p-3 text-xs" i18n>Could not load this diff.</p>
      }
    }
    @if (loaded(); as diff) {
      @switch (diff._tag) {
        @case ('Patch') {
          <div class="border-border/60 bg-card overflow-hidden rounded-xl border">
            @for (hunk of diff.hunks; track $index) {
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
                      <div
                        class="flex whitespace-pre"
                        [class]="lineClass(line)"
                        data-testid="diff-line"
                      >
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
            @if (diff.truncated) {
              <p class="text-muted-foreground border-border/60 border-t px-3 py-1.5 text-xs" i18n>
                This diff is long; only the start is shown.
              </p>
            }
          </div>
        }
        @case ('NoPreview') {
          <p class="text-muted-foreground p-3 text-xs" data-testid="diff-nopreview">
            {{ noPreviewText(diff.reason) }}
          </p>
        }
        @case ('InvalidPath') {
          <p class="text-muted-foreground p-3 text-xs" i18n>This path cannot be shown.</p>
        }
        @case ('Unavailable') {
          <p class="text-muted-foreground p-3 text-xs">{{ unavailableText(diff.reason) }}</p>
        }
      }
    }
  `,
})
export class DiffViewer {
  readonly state = input.required<Load<DiffResult>>();
  readonly mode = input<DiffMode>('unified');

  protected readonly loaded = computed(() => valueOf(this.state()));

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

  protected noPreviewText(reason: NoPreviewReason): string {
    switch (reason) {
      case 'Binary':
        return $localize`This file is binary, so there is no text diff.`;
      case 'TooLarge':
        return $localize`This file is too large to preview.`;
      case 'Symlink':
        return $localize`This is a symbolic link.`;
      case 'Submodule':
        return $localize`This is a submodule.`;
      case 'SpecialFile':
        return $localize`This is a special file.`;
      case 'Unreadable':
        return $localize`This file cannot be read.`;
      case 'MissingFile':
        return $localize`This file no longer exists.`;
      case 'NoDifference':
        return $localize`No text differences.`;
    }
  }

  protected readonly unavailableText = unavailableText;
}
