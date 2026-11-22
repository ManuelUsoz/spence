import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type {
  CommitSummary,
  CommitsResult,
} from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { unavailableText } from '../../core/git-text';
import { ChangesFrame, type FramePane } from './changes-frame';
import { CommitPane } from './commit-pane';
import { HistoryList } from './history-list';
import { fromExit, LOADING, valueOf, type Load } from './load';

const HISTORY_PAGE = 50;

const loadCommits = Effect.fnUntraced(function* (sessionId: SessionId, offset: number) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.commits']({ sessionId, limit: HISTORY_PAGE, offset });
});

/**
 * The commits of a Session's branch, newest first, with the selected commit's message and files on the right.
 * Like the Files tab it reads for itself and starts over when the page asks for a fresh read.
 */
@Component({
  selector: 'app-history-tab',
  imports: [ChangesFrame, CommitPane, HistoryList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col', 'data-testid': 'history-tab-body' },
  template: `
    <app-changes-frame [view]="narrowView()" (back)="narrowView.set('list')">
      <!-- One element per slot: Angular projects a control-flow block only by its single root. -->
      <div list class="contents">
        @switch (commits().status) {
          @case ('loading') {
            <p class="text-muted-foreground p-4 text-sm" i18n>Loading…</p>
          }
          @case ('failed') {
            <p class="text-destructive p-4 text-sm" data-testid="history-error" i18n>
              Could not load history.
            </p>
          }
        }
        @if (loaded(); as result) {
          @switch (result._tag) {
            @case ('Unavailable') {
              <p class="text-muted-foreground p-4 text-sm">{{ unavailableText(result.reason) }}</p>
            }
            @case ('Unborn') {
              <p class="text-muted-foreground p-4 text-sm" i18n>No commits yet on this branch.</p>
            }
            @case ('History') {
              <app-history-list
                [commits]="result.commits"
                [selectedSha]="selectedSha()"
                [hasMore]="result.hasMore"
                [loadingMore]="loadingMore()"
                (select)="selectCommit($event)"
                (more)="loadMore()"
              />
              @if (moreFailed()) {
                <p class="text-destructive px-4 pb-3 text-xs" data-testid="history-more-error" i18n>
                  Could not load more commits.
                </p>
              }
            }
          }
        }
      </div>
      <div viewer class="contents">
        @if (selectedCommit(); as commit) {
          <app-commit-pane [sessionId]="sessionId()" [commit]="commit" (changed)="changed.emit()" />
        } @else if (loaded()?._tag === 'History') {
          <p class="text-muted-foreground p-6 text-sm" i18n>
            Choose a commit to see what it changed.
          </p>
        }
      </div>
    </app-changes-frame>
  `,
})
export class HistoryTab {
  readonly sessionId = input.required<SessionId>();
  /** Changes whenever the page asks for a fresh read (Refresh, a Turn ending, a commit, a revert). */
  readonly reload = input<number>(0);
  /** A revert added a commit: the page reads the folder and the history again. */
  readonly changed = output<void>();

  private readonly runtime = inject(EffectRuntime);
  /** Counts reads; an answer from an older read is dropped. */
  private seq = 0;

  protected readonly narrowView = signal<FramePane>('list');
  protected readonly commits = signal<Load<CommitsResult>>(LOADING);
  protected readonly selectedSha = signal<string | null>(null);
  protected readonly loadingMore = signal(false);
  protected readonly moreFailed = signal(false);

  protected readonly loaded = computed(() => valueOf(this.commits()));
  protected readonly selectedCommit = computed((): CommitSummary | null => {
    const result = this.loaded();
    if (result?._tag !== 'History') return null;
    return result.commits.find((commit) => commit.sha === this.selectedSha()) ?? null;
  });

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.commits.set(LOADING);
        this.selectedSha.set(null);
        this.narrowView.set('list');
        this.refresh();
      });
    });
    let firstReload = true;
    effect(() => {
      this.reload();
      if (firstReload) {
        firstReload = false;
        return;
      }
      untracked(() => this.refresh());
    });
  }

  /** Reads the first page again, keeping the selected commit if it is still there. */
  private refresh(): void {
    const seq = ++this.seq;
    this.moreFailed.set(false);
    void this.runtime.run(loadCommits(this.sessionId(), 0)).then((exit) => {
      if (seq !== this.seq) return;
      this.commits.set(fromExit(exit));
      if (Exit.isSuccess(exit) && exit.value._tag === 'History') {
        const { commits } = exit.value;
        const current = this.selectedSha();
        if (current === null || !commits.some((commit) => commit.sha === current)) {
          this.selectedSha.set(commits[0]?.sha ?? null);
        }
      }
    });
  }

  protected selectCommit(commit: CommitSummary): void {
    this.selectedSha.set(commit.sha);
    this.narrowView.set('viewer');
  }

  protected loadMore(): void {
    const current = this.loaded();
    if (current?._tag !== 'History' || this.loadingMore()) return;
    const seq = this.seq;
    this.loadingMore.set(true);
    this.moreFailed.set(false);
    void this.runtime.run(loadCommits(this.sessionId(), current.commits.length)).then((exit) => {
      this.loadingMore.set(false);
      if (seq !== this.seq) return;
      if (!Exit.isSuccess(exit) || exit.value._tag !== 'History') {
        this.moreFailed.set(true);
        return;
      }
      this.commits.set({
        status: 'loaded',
        value: { ...exit.value, commits: [...current.commits, ...exit.value.commits] },
      });
    });
  }

  protected readonly unavailableText = unavailableText;
}
