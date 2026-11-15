import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import type { FilesRootTarget } from '../../../shared/files/files.rpc';
import { HlmButtonImports } from '@ui/button';
import { FilesBrowser } from './files-browser';

/** Composable inspector panel tab identifier; `#102` extends this with `'changes'`. */
export type SessionInspectorTab = 'files';

/**
 * Calm right-side workspace inspector shell in a Session.
 *
 * Hosts `FilesBrowser` in `#101` behind a composable tab header so `#102` (`Changes`)
 * slots in alongside `Files` without reshaping the inspector or `SessionView`.
 */
@Component({
  selector: 'app-session-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, HlmButtonImports, FilesBrowser],
  providers: [provideIcons({ lucideX })],
  host: {
    class: 'flex h-full min-h-0 flex-col',
  },
  template: `
    <header class="flex items-center justify-between gap-2 border-b px-3 py-2">
      <div
        class="flex items-center gap-1"
        role="tablist"
        aria-label="Inspector views"
        i18n-aria-label
      >
        <button
          type="button"
          role="tab"
          aria-selected="true"
          data-testid="inspector-tab-files"
          class="bg-accent text-foreground rounded-md px-2.5 py-1 text-xs font-medium"
          i18n
        >
          Files
        </button>
      </div>

      <button
        type="button"
        hlmBtn
        variant="ghost"
        size="icon-xs"
        data-testid="inspector-close"
        aria-label="Close inspector"
        i18n-aria-label
        (click)="closeRequested.emit()"
      >
        <ng-icon name="lucideX" class="size-3.5" aria-hidden="true" />
      </button>
    </header>

    <app-files-browser
      [target]="target()"
      [rootContextLabel]="rootContextLabel()"
      [rootFolderName]="rootFolderName()"
      [worktreeMissing]="worktreeMissing()"
      [liveRefreshTick]="liveRefreshTick()"
    />
  `,
})
export class SessionInspector {
  readonly target = input.required<FilesRootTarget | null>();
  readonly rootContextLabel = input<string>('');
  readonly rootFolderName = input<string>('');
  readonly worktreeMissing = input<boolean>(false);
  readonly liveRefreshTick = input<number>(0);

  readonly closeRequested = output<void>();
}
