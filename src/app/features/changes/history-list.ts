import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { Icon } from './icon';
import type { CommitSummary } from '../../../shared/source-control/source-control.rpc';

/**
 * The commits of the Session's branch, newest first, with a filter over the ones already loaded. Clicking a
 * commit selects it; the page shows its detail on the right.
 */
@Component({
  selector: 'app-history-list',
  imports: [HlmButtonImports, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col', 'data-testid': 'history-list' },
  template: `
    <div class="shrink-0 p-2">
      <label
        class="bg-accent/50 text-muted-foreground flex h-8 items-center gap-2 rounded-xl px-2.5 text-[13px]"
      >
        <app-icon name="search" />
        <span class="sr-only" i18n>Search commits</span>
        <input
          class="text-foreground min-w-0 flex-1 bg-transparent outline-none"
          data-testid="history-search"
          placeholder="Search commits"
          i18n-placeholder
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </label>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      @for (commit of visible(); track commit.sha) {
        <button
          type="button"
          class="hover:bg-accent focus-visible:ring-ring flex min-h-[46px] w-full flex-col justify-center gap-0.5 rounded-xl px-3 py-1.5 text-left outline-none focus-visible:ring-2"
          [class.bg-accent]="selectedSha() === commit.sha"
          [attr.aria-current]="selectedSha() === commit.sha ? 'true' : null"
          data-testid="commit-row"
          (click)="select.emit(commit)"
        >
          <span class="truncate text-[13px]" [class.font-medium]="selectedSha() === commit.sha">{{
            commit.subject
          }}</span>
          <span class="text-muted-foreground flex items-center gap-1.5 text-[11.5px]">
            @if (commit.isMerge) {
              <app-icon
                name="merge"
                [size]="12"
                role="img"
                aria-label="Merge commit"
                i18n-aria-label
              />
            }
            <span class="font-mono">{{ commit.shortSha }}</span>
            <span aria-hidden="true">·</span>
            <span class="truncate">{{ commit.authorName }}</span>
          </span>
        </button>
      } @empty {
        @if (query() !== '') {
          <p class="text-muted-foreground px-3 py-2 text-xs" data-testid="history-no-match" i18n>
            No commit matches.
          </p>
        }
      }
      @if (hasMore()) {
        <button
          type="button"
          hlmBtn
          variant="ghost"
          size="sm"
          class="mt-1 w-full"
          data-testid="history-more"
          [disabled]="loadingMore()"
          (click)="more.emit()"
          i18n
        >
          Show more
        </button>
      }
    </div>
  `,
})
export class HistoryList {
  readonly commits = input.required<ReadonlyArray<CommitSummary>>();
  readonly selectedSha = input<string | null>(null);
  readonly hasMore = input<boolean>(false);
  readonly loadingMore = input<boolean>(false);

  readonly select = output<CommitSummary>();
  readonly more = output<void>();

  protected readonly query = signal('');
  protected readonly visible = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (needle === '') return this.commits();
    return this.commits().filter(
      (commit) =>
        commit.subject.toLowerCase().includes(needle) ||
        commit.sha.startsWith(needle) ||
        commit.authorName.toLowerCase().includes(needle),
    );
  });
}
