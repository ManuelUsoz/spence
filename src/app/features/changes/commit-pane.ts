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
import { Effect } from 'effect';
import { HlmButtonImports } from '@ui/button';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type {
  CommitDetailResult,
  CommitSummary,
} from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { unavailableText } from '../../core/git-text';
import { DiffModeToggle } from './diff-mode-toggle';
import { DiffStore } from './diff-store';
import { DiffViewer, type DiffMode } from './diff-viewer';
import { FilePath, LineCounts, StatusMark } from './file-label';
import { Icon } from './icon';
import { LOADING, fromExit, valueOf, type Load } from './load';
import { RevertAction } from './revert-action';

/** A commit with many files opens only its first files; the rest open on click. */
const OPEN_AT_FIRST = 20;

const loadDetail = Effect.fnUntraced(function* (sessionId: SessionId, sha: string) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.commitDetail']({ sessionId, sha });
});

const loadCommitDiff = Effect.fnUntraced(function* (
  sessionId: SessionId,
  sha: string,
  path: string,
  previousPath: string | undefined,
) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.commitDiff']({
    sessionId,
    sha,
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
  });
});

const diffKey = (sha: string, path: string): string => `${sha}:${path}`;

/**
 * The right side of History: the commit's message with Revert, how much it changed, and every file it touched as
 * a collapsible diff. The file list is one read; each diff is read when its file is open.
 */
@Component({
  selector: 'app-commit-pane',
  imports: [
    DiffModeToggle,
    DiffViewer,
    FilePath,
    HlmButtonImports,
    Icon,
    LineCounts,
    RevertAction,
    StatusMark,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col overflow-y-auto', 'data-testid': 'commit-pane' },
  template: `
    <header class="border-border/60 flex shrink-0 flex-col gap-1.5 border-b px-5 py-4">
      <div class="flex items-start gap-3">
        <h2
          class="min-w-0 flex-1 text-[15px] leading-snug font-medium"
          data-testid="commit-subject"
        >
          {{ commit().subject }}
        </h2>
        @if (!commit().isMerge) {
          <app-revert-action
            [sessionId]="sessionId()"
            [commit]="commit()"
            (changed)="changed.emit()"
          />
        }
      </div>
      <div class="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
        <button
          type="button"
          class="hover:text-foreground focus-visible:ring-ring flex items-center gap-1 rounded font-mono outline-none focus-visible:ring-2"
          data-testid="commit-copy-sha"
          title="Copy hash"
          i18n-title
          [attr.aria-label]="copyLabel()"
          (click)="copySha()"
        >
          {{ commit().shortSha }}
          <app-icon name="copy" [size]="12" />
        </button>
        <span aria-hidden="true">·</span>
        <span>{{ commit().authorName }}</span>
        <span aria-hidden="true">·</span>
        <time [attr.datetime]="isoDate()">{{ dateText() }}</time>
      </div>
      @if (body(); as text) {
        <p class="text-muted-foreground text-[13px] whitespace-pre-wrap" data-testid="commit-body">
          {{ text }}
        </p>
      }
    </header>

    @switch (detail().status) {
      @case ('loading') {
        <p class="text-muted-foreground p-5 text-sm" i18n>Loading…</p>
      }
      @case ('failed') {
        <div class="flex flex-col items-start gap-2 p-5" data-testid="commit-error">
          <p class="text-muted-foreground text-sm" i18n>Could not load this commit.</p>
          <button hlmBtn variant="outline" size="sm" (click)="retry()" i18n>Retry</button>
        </div>
      }
    }
    @if (loaded(); as result) {
      @switch (result._tag) {
        @case ('UnknownCommit') {
          <p class="text-muted-foreground p-5 text-sm" data-testid="commit-unknown" i18n>
            This commit is no longer on this branch.
          </p>
        }
        @case ('Unavailable') {
          <p class="text-muted-foreground p-5 text-sm">{{ unavailableText(result.reason) }}</p>
        }
        @case ('Detail') {
          <div class="flex flex-col gap-3 p-5">
            <div class="flex items-center gap-3 text-xs">
              <span class="text-muted-foreground" data-testid="commit-files-count">{{
                filesChanged()
              }}</span>
              <app-line-counts [additions]="totals().additions" [deletions]="totals().deletions" />
              <span class="flex-1"></span>
              <app-diff-mode-toggle
                [mode]="mode()"
                testIdPrefix="commit-mode"
                (modeChange)="mode.set($event)"
              />
            </div>
            @if (result.commit.files.length === 0) {
              <p class="text-muted-foreground text-sm" data-testid="commit-no-files" i18n>
                No file list for this commit.
              </p>
            }
            @for (file of result.commit.files; track file.path) {
              <section
                class="border-border/60 overflow-hidden rounded-xl border"
                data-testid="commit-file"
                [attr.aria-label]="file.path"
              >
                <div class="flex items-center gap-2 pr-3">
                  <button
                    type="button"
                    class="hover:bg-accent focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2"
                    data-testid="commit-file-toggle"
                    [attr.aria-expanded]="isOpen(file.path)"
                    (click)="toggleFile(file.path)"
                  >
                    <app-icon
                      class="text-muted-foreground transition-transform"
                      [class.rotate-90]="isOpen(file.path)"
                      name="chevron-right"
                    />
                    <app-status-mark [status]="file.status" />
                    <app-file-path [path]="file.path" />
                  </button>
                  <app-line-counts [additions]="file.additions" [deletions]="file.deletions" />
                </div>
                @if (isOpen(file.path)) {
                  <div class="border-border/60 border-t">
                    <app-diff-viewer
                      [state]="diffState(file.path)"
                      [mode]="mode()"
                      (retry)="retryDiff(file.path, file.previousPath)"
                    />
                  </div>
                }
              </section>
            }
          </div>
        }
      }
    }
  `,
})
export class CommitPane {
  readonly sessionId = input.required<SessionId>();
  readonly commit = input.required<CommitSummary>();
  /** Something was added to the branch (a revert): the page reads the folder and the history again. */
  readonly changed = output<void>();

  private readonly runtime = inject(EffectRuntime);
  private readonly diffs = inject(DiffStore);
  /** Counts reads; an answer for another commit or Session is dropped. */
  private seq = 0;

  /**
   * The id of the commit shown. The History list is read again on every refresh and hands over a new object for the
   * same commit; keying on the id keeps what the user opened while the commit stays the same.
   */
  private readonly sha = computed(() => this.commit().sha);
  protected readonly detail = signal<Load<CommitDetailResult>>(LOADING);
  protected readonly mode = signal<DiffMode>('unified');
  private readonly open = signal<ReadonlySet<string>>(new Set());

  protected readonly loaded = computed(() => valueOf(this.detail()));
  private readonly files = computed(() => {
    const result = this.loaded();
    return result?._tag === 'Detail' ? result.commit.files : [];
  });
  /** The detail read has the full message; the list row only has the subject. */
  protected readonly body = computed(() => {
    const result = this.loaded();
    return result?._tag === 'Detail' ? result.commit.body.trim() : '';
  });
  protected readonly totals = computed(() => ({
    additions: this.files().reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: this.files().reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  }));
  protected readonly filesChanged = computed(() => {
    const count = this.files().length;
    return count === 1 ? $localize`1 file changed` : $localize`${count} files changed`;
  });
  protected readonly copyLabel = computed(() => {
    const sha = this.commit().shortSha;
    return $localize`Copy hash ${sha}`;
  });
  protected readonly isoDate = computed(() =>
    new Date(this.commit().authoredAtSeconds * 1000).toISOString(),
  );
  protected readonly dateText = computed(() =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(this.commit().authoredAtSeconds * 1000),
    ),
  );

  constructor() {
    effect(() => {
      const sessionId = this.sessionId();
      const sha = this.sha();
      untracked(() => this.load(sessionId, sha));
    });
    // Every open file gets its diff read once; the store ignores files it already has.
    effect(() => {
      const sessionId = this.sessionId();
      const sha = this.sha();
      const open = this.open();
      for (const file of this.files()) {
        if (!open.has(file.path)) continue;
        untracked(() =>
          this.diffs.load(
            diffKey(sha, file.path),
            loadCommitDiff(sessionId, sha, file.path, file.previousPath),
          ),
        );
      }
    });
  }

  protected retry(): void {
    this.load(this.sessionId(), this.sha());
  }

  private load(sessionId: SessionId, sha: string): void {
    const seq = ++this.seq;
    this.detail.set(LOADING);
    this.open.set(new Set());
    void this.runtime.run(loadDetail(sessionId, sha)).then((exit) => {
      if (seq !== this.seq) return;
      const state = fromExit(exit);
      this.detail.set(state);
      const result = valueOf(state);
      if (result?._tag === 'Detail') {
        this.open.set(new Set(result.commit.files.slice(0, OPEN_AT_FIRST).map((f) => f.path)));
      }
    });
  }

  protected retryDiff(path: string, previousPath: string | undefined): void {
    const sha = this.sha();
    this.diffs.load(diffKey(sha, path), loadCommitDiff(this.sessionId(), sha, path, previousPath), {
      force: true,
    });
  }

  protected isOpen(path: string): boolean {
    return this.open().has(path);
  }

  protected toggleFile(path: string): void {
    const next = new Set(this.open());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.open.set(next);
  }

  protected diffState(path: string) {
    return this.diffs.state(diffKey(this.sha(), path));
  }

  protected copySha(): void {
    void navigator.clipboard.writeText(this.sha());
  }

  protected readonly unavailableText = unavailableText;
}
