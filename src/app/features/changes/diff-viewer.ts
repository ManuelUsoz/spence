import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import type { DiffResult } from '../../../shared/source-control/source-control.rpc';
import { DiffPatch } from '@ui/diff';
import { unavailableText } from '../../core/git-text';
import { valueOf, type Load } from './load';

export type DiffMode = 'unified' | 'split';

type NoPreviewReason = Extract<DiffResult, { _tag: 'NoPreview' }>['reason'];

/**
 * One file's diff, as a card of hunks, unified or side by side. It reads nothing: the page hands it the state of
 * a read, so Changes and History show diffs the same way.
 */
@Component({
  selector: 'app-diff-viewer',
  imports: [DiffPatch, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', 'data-testid': 'change-diff' },
  template: `
    @switch (state().status) {
      @case ('loading') {
        <p class="text-muted-foreground p-3 text-xs" i18n>Loading…</p>
      }
      @case ('failed') {
        <div class="flex flex-col items-start gap-2 p-3">
          <p class="text-muted-foreground text-xs" i18n>Could not load this diff.</p>
          <button hlmBtn variant="outline" size="sm" (click)="retry.emit()" i18n>Retry</button>
        </div>
      }
    }
    @if (loaded(); as diff) {
      @switch (diff._tag) {
        @case ('Patch') {
          <app-diff-patch [hunks]="diff.hunks" [truncated]="diff.truncated" [mode]="mode()" />
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
  readonly retry = output<void>();
  readonly mode = input<DiffMode>('unified');

  protected readonly loaded = computed(() => valueOf(this.state()));

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
