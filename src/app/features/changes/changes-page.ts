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
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type {
  ChangedFile,
  ChangesResult,
  CommitsResult,
  DiffResult,
  FileChangeStatus,
  HeadState,
} from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';

const HISTORY_PAGE = 50;

const loadChanges = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.changes']({ sessionId });
});

const loadDiff = Effect.fnUntraced(function* (sessionId: SessionId, path: string) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.diff']({ sessionId, path, scope: 'combined' });
});

const loadCommits = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.commits']({ sessionId, limit: HISTORY_PAGE, offset: 0 });
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
  imports: [HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-auto flex w-full max-w-3xl flex-col gap-2', 'data-testid': 'changes-page' },
  template: `
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
              <button
                type="button"
                class="hover:bg-accent flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                [attr.aria-expanded]="expanded().has(file.path)"
                (click)="toggle(file.path)"
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
                          {{ diff.detail }}
                        </p>
                      }
                      @case ('InvalidPath') {
                        <p class="text-muted-foreground p-3 text-xs">{{ diff.detail }}</p>
                      }
                      @case ('Unavailable') {
                        <p class="text-muted-foreground p-3 text-xs">{{ diff.detail }}</p>
                      }
                    }
                  }
                </div>
              }
            </div>
          }
          @if (result.excludedCount > 0) {
            <p class="text-muted-foreground px-2 pt-2 text-xs" data-testid="changes-excluded" i18n>
              {{ result.excludedCount }} paths are not listed (nested repositories or special
              files).
            </p>
          }
        }
      }
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
              <div class="flex h-9 items-center gap-2.5 px-2" data-testid="commit-row">
                <span class="text-muted-foreground w-14 shrink-0 font-mono text-xs">{{
                  commit.shortSha
                }}</span>
                <span class="min-w-0 flex-1 truncate">{{ commit.subject }}</span>
                <span class="text-muted-foreground shrink-0 text-xs">{{ commit.authorName }}</span>
              </div>
            }
            @if (result.hasMore) {
              <p class="text-muted-foreground px-2 pt-2 text-xs" i18n>
                Showing the latest {{ result.commits.length }} commits.
              </p>
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

  protected readonly tab = signal<'changes' | 'history'>('changes');
  protected readonly changes = signal<Load<ChangesResult>>({ status: 'loading' });
  protected readonly commits = signal<Load<CommitsResult>>({ status: 'loading' });
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  private readonly diffs = signal<ReadonlyMap<string, Load<DiffResult>>>(new Map());

  protected readonly loadedChanges = computed(() => {
    const state = this.changes();
    return state.status === 'loaded' ? state.value : null;
  });
  protected readonly loadedCommits = computed(() => {
    const state = this.commits();
    return state.status === 'loaded' ? state.value : null;
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
      untracked(() => this.refresh());
    });
    let wasRunning = false;
    effect(() => {
      const running = this.running();
      if (wasRunning && !running) untracked(() => this.refresh());
      wasRunning = running;
    });
  }

  /** Reads the folder again: changes, history and every diff that is open. */
  protected refresh(): void {
    const sessionId = this.sessionId();
    void this.runtime.run(loadChanges(sessionId)).then((exit) => {
      if (sessionId !== this.sessionId()) return;
      this.changes.set(
        Exit.isSuccess(exit) ? { status: 'loaded', value: exit.value } : { status: 'failed' },
      );
    });
    void this.runtime.run(loadCommits(sessionId)).then((exit) => {
      if (sessionId !== this.sessionId()) return;
      this.commits.set(
        Exit.isSuccess(exit) ? { status: 'loaded', value: exit.value } : { status: 'failed' },
      );
    });
    this.diffs.set(new Map());
    for (const path of this.expanded()) this.fetchDiff(path);
  }

  protected toggle(path: string): void {
    const next = new Set(this.expanded());
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      this.fetchDiff(path);
    }
    this.expanded.set(next);
  }

  private fetchDiff(path: string): void {
    const sessionId = this.sessionId();
    this.diffs.update((map) => new Map(map).set(path, { status: 'loading' }));
    void this.runtime.run(loadDiff(sessionId, path)).then((exit) => {
      if (sessionId !== this.sessionId()) return;
      this.diffs.update((map) =>
        new Map(map).set(
          path,
          Exit.isSuccess(exit) ? { status: 'loaded', value: exit.value } : { status: 'failed' },
        ),
      );
    });
  }

  protected diffState(path: string): Load<DiffResult> {
    return this.diffs().get(path) ?? { status: 'loading' };
  }

  protected loadedDiff(path: string): DiffResult | null {
    const state = this.diffState(path);
    return state.status === 'loaded' ? state.value : null;
  }

  protected tabClass(tab: 'changes' | 'history'): string {
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

  protected unavailableText(
    reason: 'MissingGit' | 'MissingPath' | 'NonGit' | 'UnsupportedRepo',
  ): string {
    switch (reason) {
      case 'MissingGit':
        return $localize`Git is not installed, so changes cannot be shown.`;
      case 'MissingPath':
        return $localize`This Session's folder was not found.`;
      case 'NonGit':
        return $localize`This folder is not a Git repository, so there are no changes to show.`;
      case 'UnsupportedRepo':
        return $localize`This repository uses a Git feature Spence cannot read yet.`;
    }
  }
}

const headName = (head: HeadState): string =>
  head._tag === 'Detached' ? head.commit.slice(0, 7) : head.branch;
