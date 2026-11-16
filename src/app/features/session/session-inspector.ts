import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import type { HistoryComparison } from '../../../shared/history/comparison';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import type { FilesRootTarget } from '../../../shared/files/files.rpc';
import { HlmButtonImports } from '@ui/button';
import { FilesBrowser } from './files-browser';
import { InspectorPanel } from './inspector-panel';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { CurrentChangesSummary } from '../../../shared/source-control/source-control.rpc';

/** Composable inspector panel tab identifier; `#102` extends this with `'changes'`. */
export type SessionInspectorTab = 'files' | 'changes' | 'comparisons';

/**
 * Calm right-side workspace inspector shell in a Session.
 *
 * Hosts `FilesBrowser` in `#101` behind a composable tab header so `#102` (`Changes`)
 * slots in alongside `Files` without reshaping the inspector or `SessionView`.
 */
@Component({
  selector: 'app-session-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, HlmButtonImports, FilesBrowser, InspectorPanel],
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
          [attr.aria-selected]="tab() === 'comparisons'"
          class="rounded-md px-2.5 py-1 text-xs"
          [class.bg-accent]="tab() === 'comparisons'"
          (click)="selectTab('comparisons')"
          i18n
        >
          Comparisons
        </button>
        <button
          type="button"
          role="tab"
          data-testid="inspector-tab-changes"
          class="rounded-md px-2.5 py-1 text-xs"
          [attr.aria-selected]="tab() === 'changes'"
          [class.bg-accent]="tab() === 'changes'"
          (click)="selectTab('changes')"
          i18n
        >
          Changes
        </button>
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="tab() === 'files'"
          data-testid="inspector-tab-files"
          class="text-foreground rounded-md px-2.5 py-1 text-xs font-medium"
          [class.bg-accent]="tab() === 'files'"
          (click)="selectTab('files')"
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

    @if (tab() === 'files') {
      <app-files-browser
        [target]="target()"
        [rootContextLabel]="rootContextLabel()"
        [rootFolderName]="rootFolderName()"
        [worktreeMissing]="worktreeMissing()"
        [liveRefreshTick]="liveRefreshTick()"
      />
    } @else if (tab() === 'changes') {
      <app-inspector-panel
        [sessionId]="sessionId()"
        [open]="true"
        (summaryChanged)="summaryChanged.emit($event)"
      />
    } @else {
      <section class="overflow-auto p-3 text-sm" data-testid="comparisons">
        @if (comparisonState() === 'unavailable') {
          <p i18n>Comparisons require a worktree.</p>
        } @else if (comparisonState() === 'loading') {
          <p i18n>Loading comparisons…</p>
        } @else if (comparisonState() === 'error') {
          <p i18n>Could not load comparisons.</p>
        } @else if (!comparisons().length) {
          <p i18n>No comparisons recorded.</p>
        }
        @for (comparison of comparisons(); track comparison.id) {
          <div class="border-b py-2" data-testid="comparison-row">
            <p class="font-mono text-xs">{{ comparison.id }}</p>
            <p>
              Before: {{ comparison.before.status }}
              @if (comparison.before.status !== 'Complete') {
                — {{ comparison.before.detail }}
              }
            </p>
            <p>
              After: {{ comparison.after.status }}
              @if (comparison.after.status !== 'Complete') {
                — {{ comparison.after.detail }}
              }
            </p>
          </div>
        }
      </section>
    }
  `,
})
export class SessionInspector {
  private readonly runtime = inject(EffectRuntime);
  protected readonly comparisons = signal<readonly HistoryComparison[]>([]);
  protected readonly comparisonState = signal<'unavailable' | 'loading' | 'error' | 'ready'>(
    'unavailable',
  );
  readonly sessionId = input.required<SessionId>();
  readonly initialTab = input<SessionInspectorTab>('files');
  protected readonly tab = signal<SessionInspectorTab>('files');
  readonly summaryChanged = output<CurrentChangesSummary | null>();
  readonly tabChanged = output<SessionInspectorTab>();
  readonly target = input.required<FilesRootTarget | null>();
  readonly rootContextLabel = input<string>('');
  readonly rootFolderName = input<string>('');
  readonly worktreeMissing = input<boolean>(false);
  readonly liveRefreshTick = input<number>(0);

  readonly closeRequested = output<void>();

  constructor() {
    effect(() => this.tab.set(this.initialTab()));
    effect((onCleanup) => {
      const sessionId = this.sessionId();
      const worktreeId = this.target()?.worktreeId;
      const enabled = this.tab() === 'comparisons' && !this.worktreeMissing();
      this.comparisons.set([]);
      if (!enabled || worktreeId === undefined) {
        this.comparisonState.set('unavailable');
        return;
      }
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      this.comparisonState.set('loading');
      void this.runtime
        .run(
          Effect.gen(function* () {
            const api = yield* DesktopApi;
            return yield* api['History.list']({ sessionId, worktreeId });
          }),
          { signal: controller.signal },
        )
        .then((result) => {
          if (controller.signal.aborted) return;
          if (Exit.isSuccess(result)) {
            this.comparisons.set(result.value);
            this.comparisonState.set('ready');
          } else {
            this.comparisonState.set('error');
          }
        });
    });
  }
  protected selectTab(tab: SessionInspectorTab): void {
    this.tab.set(tab);
    this.tabChanged.emit(tab);
  }
}
