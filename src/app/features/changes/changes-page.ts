import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import { HlmButtonImports } from '@ui/button';
import { HlmSelectImports } from '@ui/select';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type {
  ChangedFile,
  ChangesResult,
  CommitFile,
  CommitsResult,
  DiffResult,
  FileChangeStatus,
  HeadState,
} from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { CommitPanel } from './commit-panel';
import { DiscardPanel } from './discard-panel';
import { FilesTab } from './files-tab';
import { unavailableText } from './git-text';
import { RemoteActions } from './remote-actions';
import { RevertAction } from './revert-action';
import { WorktreeBar } from './worktree-bar';

const HISTORY_PAGE = 50;

const loadChanges = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.changes']({ sessionId });
});

const loadDiff = Effect.fnUntraced(function* (
  sessionId: SessionId,
  path: string,
  previousPath: string | undefined,
) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.diff']({
    sessionId,
    path,
    scope: 'combined',
    ...(previousPath === undefined ? {} : { previousPath }),
  });
});

const loadCommits = Effect.fnUntraced(function* (sessionId: SessionId, offset: number) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.commits']({ sessionId, limit: HISTORY_PAGE, offset });
});

type Load<A> =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly value: A };

const STATUS_MARK: Record<FileChangeStatus, string> = {
  Added: 'A',
  Modified: 'M',
  Deleted: 'D',
  Renamed: 'R',
  Copied: 'C',
  TypeChanged: 'T',
  Untracked: 'U',
  Conflicted: '!',
};

/**
 * A Session's Changes: what is different in its folder right now (staged, unstaged and untracked, from every
 * writer) with an inline diff per file, and the Git history of its branch.
 */
@Component({
  selector: 'app-changes-page',
  imports: [
    HlmButtonImports,
    CommitPanel,
    DiscardPanel,
    FilesTab,
    HlmSelectImports,
    RemoteActions,
    RevertAction,
    WorktreeBar,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-auto flex w-full max-w-3xl flex-col gap-2', 'data-testid': 'changes-page' },
  template: `
    <app-worktree-bar
      class="pb-2"
      [sessionId]="sessionId()"
      [reload]="reloads()"
      (moved)="refresh()"
    />
    <div class="flex items-center gap-3 pb-2">
      <div
        role="tablist"
        aria-label="Source control"
        i18n-aria-label
        class="bg-accent flex gap-0.5 rounded-xl p-0.5"
      >
        <button
          type="button"
          role="tab"
          data-testid="changes-tab"
          class="h-7 rounded-lg px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          [class]="tabClass('changes')"
          [attr.aria-selected]="tab() === 'changes'"
          (click)="tab.set('changes')"
        >
          <span i18n>Changes</span>
          @if (fileCount() > 0) {
            <span class="text-muted-foreground ml-1 text-xs tabular-nums">{{ fileCount() }}</span>
          }
        </button>
        <button
          type="button"
          role="tab"
          data-testid="history-tab"
          class="h-7 rounded-lg px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          [class]="tabClass('history')"
          [attr.aria-selected]="tab() === 'history'"
          (click)="tab.set('history')"
          i18n
        >
          History
        </button>
        <button
          type="button"
          role="tab"
          data-testid="files-tab-button"
          class="h-7 rounded-lg px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          [class]="tabClass('files')"
          [attr.aria-selected]="tab() === 'files'"
          (click)="tab.set('files')"
          i18n
        >
          Files
        </button>
      </div>
      <span class="flex-1"></span>
      @if (headLabel(); as label) {
        <span class="text-muted-foreground text-xs" data-testid="changes-head">
          <span class="font-mono">{{ label }}</span>
          @if (aheadLabel(); as ahead) {
            · {{ ahead }}
          }
        </span>
      }
      <button
        type="button"
        hlmBtn
        variant="ghost"
        size="sm"
        data-testid="changes-refresh"
        (click)="refresh()"
        i18n
      >
        Refresh
      </button>
    </div>

    @if (tab() === 'changes') {
      @if (available(); as repo) {
        <div class="mb-2 flex flex-wrap items-start gap-3">
          <app-remote-actions
            [sessionId]="sessionId()"
            [ahead]="repo.upstream?.ahead ?? 0"
            [behind]="repo.upstream?.behind ?? 0"
            [hasUpstream]="repo.upstream !== undefined"
            [canPush]="canPush()"
            [remote]="remote()"
            (changed)="refresh()"
          />
          @if (repo.upstream === undefined && repo.remotes.length > 1) {
            <hlm-select
              data-testid="remote-select"
              [value]="remote() ?? null"
              (valueChange)="remoteChoice.set($any($event) ?? undefined)"
            >
              <hlm-select-trigger
                class="w-40"
                size="sm"
                aria-label="Remote"
                i18n-aria-label
                data-testid="remote-select-trigger"
              >
                <hlm-select-value placeholder="Choose a remote" i18n-placeholder />
              </hlm-select-trigger>
              <hlm-select-content *hlmSelectPortal>
                @for (name of repo.remotes; track name) {
                  <hlm-select-item [value]="name">{{ name }}</hlm-select-item>
                }
              </hlm-select-content>
            </hlm-select>
          }
        </div>
      }
      @switch (changes().status) {
        @case ('loading') {
          <p class="text-muted-foreground text-sm" i18n>Loading…</p>
        }
        @case ('failed') {
          <p class="text-destructive text-sm" data-testid="changes-error" i18n>
            Could not load changes.
          </p>
        }
      }
      @if (loadedChanges(); as result) {
        @if (result._tag === 'Unavailable') {
          <p class="text-muted-foreground text-sm" data-testid="changes-unavailable">
            {{ unavailableText(result.reason) }}
          </p>
        } @else if (result.files.length === 0) {
          <p class="text-muted-foreground text-sm" data-testid="changes-empty" i18n>
            No changes. Everything is committed.
          </p>
        } @else {
          @for (file of result.files; track file.path) {
            <div data-testid="change-row">
              <div class="flex items-center gap-1">
                <input
                  type="checkbox"
                  class="ml-2 shrink-0"
                  data-testid="change-check"
                  [attr.aria-label]="file.path"
                  [checked]="isSelected(file)"
                  [disabled]="file.status === 'Conflicted'"
                  (change)="toggleSelected(file)"
                />
                <button
                  type="button"
                  class="hover:bg-accent flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  [attr.aria-expanded]="expanded().has(file.path)"
                  (click)="toggle(file)"
                >
                  <span
                    class="w-3 text-[11px] font-semibold"
                    [class]="markClass(file)"
                    [attr.aria-label]="statusLabel(file.status)"
                    >{{ mark(file.status) }}</span
                  >
                  <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ file.path }}</span>
                  @if (file.additions !== null) {
                    <span class="text-diff-add font-mono text-xs tabular-nums"
                      >+{{ file.additions }}</span
                    >
                  }
                  @if (file.deletions !== null) {
                    <span class="text-diff-del font-mono text-xs tabular-nums"
                      >−{{ file.deletions }}</span
                    >
                  }
                </button>
                @if (running()) {
                  <span
                    class="mr-2 size-1.5 shrink-0 rounded-full bg-[var(--attention)]"
                    data-testid="editing-mark"
                    title="The Agent is still editing"
                    i18n-title
                  ></span>
                }
              </div>
              @if (expanded().has(file.path)) {
                <div
                  class="border-border/60 mt-1 mb-2 ml-6 overflow-hidden rounded-xl border"
                  data-testid="change-diff"
                >
                  @switch (diffState(file.path).status) {
                    @case ('loading') {
                      <p class="text-muted-foreground p-3 text-xs" i18n>Loading…</p>
                    }
                    @case ('failed') {
                      <p class="text-destructive p-3 text-xs" i18n>Could not load this diff.</p>
                    }
                  }
                  @if (loadedDiff(file.path); as diff) {
                    @switch (diff._tag) {
                      @case ('Patch') {
                        <div class="overflow-x-auto py-1 font-mono text-xs leading-5">
                          @for (hunk of diff.hunks; track $index) {
                            <div
                              class="bg-tray text-muted-foreground border-border/60 border-b px-3 py-1 text-[11px]"
                            >
                              {{ hunk.header }}
                            </div>
                            @for (line of hunk.lines; track $index) {
                              <div
                                class="flex whitespace-pre"
                                [class]="lineClass(line.kind)"
                                data-testid="diff-line"
                              >
                                <span
                                  class="text-muted-foreground w-10 shrink-0 pr-2.5 text-right select-none"
                                  aria-hidden="true"
                                  >{{ line.newLine ?? line.oldLine }}</span
                                >
                                <span class="w-3.5 shrink-0 select-none" aria-hidden="true">{{
                                  linePrefix(line.kind)
                                }}</span>
                                <span>{{ line.text }}</span>
                              </div>
                            }
                          }
                          @if (diff.truncated) {
                            <p class="text-muted-foreground px-3 py-1 text-xs" i18n>
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
                        <p class="text-muted-foreground p-3 text-xs" i18n>
                          This path cannot be shown.
                        </p>
                      }
                      @case ('Unavailable') {
                        <p class="text-muted-foreground p-3 text-xs">
                          {{ unavailableText(diff.reason) }}
                        </p>
                      }
                    }
                  }
                </div>
              }
            </div>
          }
          <app-discard-panel
            [sessionId]="sessionId()"
            [selected]="commitFiles()"
            [all]="discardableFiles()"
            (changed)="refresh()"
          />
          <app-commit-panel
            [sessionId]="sessionId()"
            [files]="commitFiles()"
            [totalCount]="result.files.length"
            [running]="running()"
            [canPush]="canPush()"
            [remote]="remote()"
            (changed)="refresh()"
          />
          @if (result.excludedCount > 0) {
            <p class="text-muted-foreground px-2 pt-2 text-xs" data-testid="changes-excluded" i18n>
              Paths not listed: {{ result.excludedCount }} (nested repositories or special files).
            </p>
          }
        }
      }
    } @else if (tab() === 'files') {
      <app-files-tab [sessionId]="sessionId()" [reload]="reloads()" />
    } @else {
      @switch (commits().status) {
        @case ('loading') {
          <p class="text-muted-foreground text-sm" i18n>Loading…</p>
        }
        @case ('failed') {
          <p class="text-destructive text-sm" i18n>Could not load history.</p>
        }
      }
      @if (loadedCommits(); as result) {
        @switch (result._tag) {
          @case ('Unavailable') {
            <p class="text-muted-foreground text-sm">{{ unavailableText(result.reason) }}</p>
          }
          @case ('Unborn') {
            <p class="text-muted-foreground text-sm" i18n>No commits yet on this branch.</p>
          }
          @case ('History') {
            @for (commit of result.commits; track commit.sha) {
              <div class="flex min-h-9 items-center gap-2.5 px-2" data-testid="commit-row">
                <span class="text-muted-foreground w-14 shrink-0 font-mono text-xs">{{
                  commit.shortSha
                }}</span>
                <span class="min-w-0 flex-1 truncate">{{ commit.subject }}</span>
                <span class="text-muted-foreground shrink-0 text-xs">{{ commit.authorName }}</span>
                @if (!commit.isMerge) {
                  <app-revert-action
                    [sessionId]="sessionId()"
                    [commit]="commit"
                    (changed)="refresh()"
                  />
                }
              </div>
            }
            @if (result.hasMore) {
              <button
                type="button"
                hlmBtn
                variant="ghost"
                size="sm"
                data-testid="history-more"
                [disabled]="loadingMore()"
                (click)="loadMore()"
                i18n
              >
                Show more
              </button>
            }
          }
        }
      }
    }
  `,
})
export class ChangesPage {
  readonly sessionId = input.required<SessionId>();
  /** Reloads when a running Turn ends, since that is when its edits are done. */
  readonly running = input<boolean>(false);

  private readonly runtime = inject(EffectRuntime);
  /** Counts reads of the folder; an answer from an older read is dropped. */
  private seq = 0;
  protected readonly loadingMore = signal(false);

  protected readonly tab = signal<'changes' | 'history' | 'files'>('changes');
  /** Counts refreshes, so the Files tab reads again when Refresh is pressed. */
  protected readonly reloads = signal(0);
  protected readonly changes = signal<Load<ChangesResult>>({ status: 'loading' });
  protected readonly commits = signal<Load<CommitsResult>>({ status: 'loading' });
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** Files the user unticked; every other changed file is committed, so new ones start ticked. */
  private readonly deselected = signal<ReadonlySet<string>>(new Set());
  protected readonly remoteChoice = signal<string | undefined>(undefined);
  private readonly diffs = signal<ReadonlyMap<string, Load<DiffResult>>>(new Map());

  protected readonly loadedChanges = computed(() => {
    const state = this.changes();
    return state.status === 'loaded' ? state.value : null;
  });
  protected readonly loadedCommits = computed(() => {
    const state = this.commits();
    return state.status === 'loaded' ? state.value : null;
  });
  protected readonly available = computed(() => {
    const result = this.loadedChanges();
    return result?._tag === 'Available' ? result : null;
  });
  /** The remote Push goes to while the branch has no upstream: the one chosen, or the only one. Never a guess. */
  protected readonly remote = computed((): string | undefined => {
    const remotes = this.available()?.remotes ?? [];
    const chosen = this.remoteChoice();
    if (chosen !== undefined && remotes.includes(chosen)) return chosen;
    return remotes.length === 1 ? remotes[0] : undefined;
  });
  protected readonly canPush = computed(() => {
    const repo = this.available();
    return repo !== null && (repo.upstream !== undefined || this.remote() !== undefined);
  });
  /** The files to commit: ticked, and not in conflict. */
  protected readonly commitFiles = computed((): ReadonlyArray<CommitFile> => {
    const repo = this.available();
    if (repo === null) return [];
    const unticked = this.deselected();
    return repo.files
      .filter((file) => file.status !== 'Conflicted' && !unticked.has(file.path))
      .map((file) => ({
        path: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      }));
  });
  /** Every changed file that can be discarded (a conflicted one has to be resolved first). */
  protected readonly discardableFiles = computed((): ReadonlyArray<CommitFile> => {
    const repo = this.available();
    if (repo === null) return [];
    return repo.files
      .filter((file) => file.status !== 'Conflicted')
      .map((file) => ({
        path: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      }));
  });
  protected readonly fileCount = computed(() => {
    const result = this.loadedChanges();
    return result?._tag === 'Available' ? result.files.length : 0;
  });
  protected readonly headLabel = computed(() => {
    const result = this.loadedChanges();
    return result?._tag === 'Available' ? headName(result.head) : null;
  });
  protected readonly aheadLabel = computed(() => {
    const result = this.loadedChanges();
    if (result?._tag !== 'Available' || result.upstream === undefined) return null;
    const { ahead, behind } = result.upstream;
    return [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].filter(Boolean).join(' ');
  });

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.reset();
        this.refresh();
      });
    });
    let wasRunning = false;
    effect(() => {
      const running = this.running();
      if (wasRunning && !running) untracked(() => this.refresh());
      wasRunning = running;
    });
  }

  /** Forgets what the last Session showed, so it never appears under another Session's name. */
  private reset(): void {
    this.changes.set({ status: 'loading' });
    this.commits.set({ status: 'loading' });
    this.expanded.set(new Set());
    this.diffs.set(new Map());
    this.deselected.set(new Set());
    this.remoteChoice.set(undefined);
  }

  protected isSelected(file: ChangedFile): boolean {
    return file.status !== 'Conflicted' && !this.deselected().has(file.path);
  }

  protected toggleSelected(file: ChangedFile): void {
    const next = new Set(this.deselected());
    if (next.has(file.path)) next.delete(file.path);
    else next.add(file.path);
    this.deselected.set(next);
  }

  /** Reads the folder again: changes, history and every diff that is open. The newest read wins. */
  protected refresh(): void {
    const seq = ++this.seq;
    this.reloads.update((count) => count + 1);
    const sessionId = this.sessionId();
    void this.runtime.run(loadChanges(sessionId)).then((exit) => {
      if (seq !== this.seq) return;
      if (!Exit.isSuccess(exit)) {
        this.changes.set({ status: 'failed' });
        return;
      }
      this.changes.set({ status: 'loaded', value: exit.value });
      this.syncOpenDiffs(exit.value);
    });
    void this.runtime.run(loadCommits(sessionId, 0)).then((exit) => {
      if (seq !== this.seq) return;
      this.commits.set(
        Exit.isSuccess(exit) ? { status: 'loaded', value: exit.value } : { status: 'failed' },
      );
    });
  }

  /** Closes the diffs of files that are no longer changed and reads the others again. */
  private syncOpenDiffs(result: ChangesResult): void {
    const files = new Map(
      result._tag === 'Available' ? result.files.map((file) => [file.path, file]) : [],
    );
    const open = new Set([...this.expanded()].filter((path) => files.has(path)));
    this.expanded.set(open);
    // A file that left the list is forgotten, so it comes back ticked if it changes again.
    this.deselected.update((set) => new Set([...set].filter((path) => files.has(path))));
    for (const path of open) this.fetchDiff(path, files.get(path)?.previousPath);
  }

  protected toggle(file: ChangedFile): void {
    const next = new Set(this.expanded());
    if (next.has(file.path)) {
      next.delete(file.path);
    } else {
      next.add(file.path);
      this.fetchDiff(file.path, file.previousPath);
    }
    this.expanded.set(next);
  }

  private fetchDiff(path: string, previousPath: string | undefined): void {
    const seq = this.seq;
    this.diffs.update((map) =>
      map.has(path) ? map : new Map(map).set(path, { status: 'loading' }),
    );
    void this.runtime.run(loadDiff(this.sessionId(), path, previousPath)).then((exit) => {
      if (seq !== this.seq) return;
      this.diffs.update((map) =>
        new Map(map).set(
          path,
          Exit.isSuccess(exit) ? { status: 'loaded', value: exit.value } : { status: 'failed' },
        ),
      );
    });
  }

  protected loadMore(): void {
    const current = this.loadedCommits();
    if (current?._tag !== 'History' || this.loadingMore()) return;
    const seq = this.seq;
    this.loadingMore.set(true);
    void this.runtime.run(loadCommits(this.sessionId(), current.commits.length)).then((exit) => {
      this.loadingMore.set(false);
      if (seq !== this.seq || !Exit.isSuccess(exit) || exit.value._tag !== 'History') return;
      this.commits.set({
        status: 'loaded',
        value: { ...exit.value, commits: [...current.commits, ...exit.value.commits] },
      });
    });
  }

  protected diffState(path: string): Load<DiffResult> {
    return this.diffs().get(path) ?? { status: 'loading' };
  }

  protected loadedDiff(path: string): DiffResult | null {
    const state = this.diffState(path);
    return state.status === 'loaded' ? state.value : null;
  }

  protected tabClass(tab: 'changes' | 'history' | 'files'): string {
    return this.tab() === tab
      ? 'bg-background font-medium shadow-xs'
      : 'text-muted-foreground hover:text-foreground';
  }

  protected mark(status: FileChangeStatus): string {
    return STATUS_MARK[status];
  }

  protected markClass(file: ChangedFile): string {
    if (file.status === 'Added' || file.status === 'Untracked') return 'text-diff-add';
    if (file.status === 'Deleted' || file.status === 'Conflicted') return 'text-diff-del';
    return 'text-muted-foreground';
  }

  protected statusLabel(status: FileChangeStatus): string {
    switch (status) {
      case 'Added':
        return $localize`Added`;
      case 'Modified':
        return $localize`Modified`;
      case 'Deleted':
        return $localize`Deleted`;
      case 'Renamed':
        return $localize`Renamed`;
      case 'Copied':
        return $localize`Copied`;
      case 'TypeChanged':
        return $localize`Type changed`;
      case 'Untracked':
        return $localize`New, not tracked yet`;
      case 'Conflicted':
        return $localize`Conflicted`;
    }
  }

  protected lineClass(kind: 'context' | 'add' | 'delete'): string {
    if (kind === 'add') return 'bg-diff-add/10';
    if (kind === 'delete') return 'bg-diff-del/10';
    return '';
  }

  protected linePrefix(kind: 'context' | 'add' | 'delete'): string {
    if (kind === 'add') return '+';
    if (kind === 'delete') return '−';
    return '';
  }

  protected noPreviewText(
    reason:
      | 'Binary'
      | 'TooLarge'
      | 'Symlink'
      | 'Submodule'
      | 'SpecialFile'
      | 'Unreadable'
      | 'MissingFile'
      | 'NoDifference',
  ): string {
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

const headName = (head: HeadState): string =>
  head._tag === 'Detached' ? head.commit.slice(0, 7) : head.branch;
