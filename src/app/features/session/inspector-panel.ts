import { NgTemplateOutlet } from '@angular/common';
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
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type {
  CommitDetail,
  CommitHistorySnapshot,
  CommitSummary,
  CurrentChangesSnapshot,
  CurrentChangesSummary,
  DiffPreview,
  DiffScope,
} from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';

@Component({
  selector: 'app-inspector-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  template: `
    @if (open()) {
      <section
        data-testid="inspector-panel"
        class="flex min-h-0 flex-1 flex-col overflow-auto p-3 text-sm"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="font-medium" i18n>Changes</span>
          <div class="flex gap-2">
            <button
              type="button"
              data-testid="changes-refresh"
              class="text-muted-foreground hover:text-foreground"
              (click)="refresh()"
              i18n
            >
              Refresh
            </button>
            <button
              type="button"
              data-testid="inspector-menu-trigger"
              class="text-muted-foreground hover:text-foreground"
              [attr.aria-expanded]="menuOpen()"
              (click)="menuOpen.set(!menuOpen())"
              i18n
            >
              More
            </button>
          </div>
        </div>
        @if (menuOpen()) {
          <button
            type="button"
            data-testid="inspector-menu-history"
            class="hover:bg-accent rounded px-2 py-1 text-left"
            (click)="showHistory()"
            i18n
          >
            Git history
          </button>
        }
        @if (view() === 'changes') {
          @if (error()) {
            <p data-testid="changes-error" class="text-muted-foreground" i18n>
              Could not inspect changes.
            </p>
            <button type="button" data-testid="changes-retry" (click)="refresh()" i18n>
              Retry
            </button>
          }
          @if (snapshot(); as snap) {
            @switch (snap.state._tag) {
              @case ('Available') {
                @let state = snap.state;
                @switch (state.head._tag) {
                  @case ('Branch') {
                    <p class="text-muted-foreground py-2 font-mono text-xs">
                      {{ state.head.branch }}
                    </p>
                  }
                  @case ('Detached') {
                    <p
                      data-testid="changes-head-detached"
                      class="text-muted-foreground py-2 text-xs"
                    >
                      <span i18n>Detached</span>
                      <span class="font-mono">{{ state.head.commit.slice(0, 7) }}</span>
                    </p>
                  }
                  @case ('Unborn') {
                    <p class="text-muted-foreground py-2 text-xs">
                      <span i18n>Unborn branch</span>
                      <span class="font-mono">{{ state.head.branch }}</span>
                    </p>
                  }
                }
                @if (state.integration !== 'None' || state.hasConflicts) {
                  <p data-testid="changes-integration-banner" class="text-muted-foreground py-1">
                    {{ state.integration }} <span i18n>in progress or conflicts present</span>
                  </p>
                }
                @if (state.unstablePaths.length) {
                  <p data-testid="changes-unstable-banner" class="text-muted-foreground py-1">
                    <span i18n>Files changed while inspecting:</span>
                    {{ state.unstablePaths.join(', ') }}
                  </p>
                }
                @if (state.excludedEntries.length) {
                  <p data-testid="changes-excluded-banner" class="text-muted-foreground py-1">
                    <span i18n>Some entries could not be inspected:</span>
                    @for (entry of state.excludedEntries; track entry.path) {
                      <span class="font-mono text-xs">{{ entry.path }} </span>
                    }
                  </p>
                }
                @if (state.incompleteDiffCounts) {
                  <p
                    data-testid="changes-incomplete-banner"
                    class="text-muted-foreground py-1"
                    i18n
                  >
                    Line counts are incomplete.
                  </p>
                }
                @if (!state.files.length) {
                  <p data-testid="changes-empty" class="text-muted-foreground py-3" i18n>
                    No current changes.
                  </p>
                }
                @for (file of state.files; track file.path) {
                  <div data-testid="change-row" [attr.data-path]="file.path" class="border-b py-1">
                    <button
                      type="button"
                      data-testid="change-row-toggle"
                      class="hover:bg-accent flex w-full items-center gap-2 rounded px-1 py-1 text-left"
                      [attr.aria-expanded]="expandedPath() === file.path"
                      (click)="toggleFile(file.path)"
                    >
                      <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ file.path }}</span
                      ><span class="text-muted-foreground text-xs">{{ file.status }}</span>
                      @if (file.additions !== null && file.deletions !== null) {
                        <span class="text-muted-foreground text-xs tabular-nums"
                          >+{{ file.additions }} −{{ file.deletions }}</span
                        >
                      }
                    </button>
                    @if (expandedPath() === file.path) {
                      <div class="flex gap-2 py-1 text-xs">
                        <button
                          type="button"
                          data-testid="diff-scope-combined"
                          (click)="loadDiff(file.path, 'combined')"
                          i18n
                        >
                          Combined
                        </button>
                        <button
                          type="button"
                          data-testid="diff-scope-staged"
                          (click)="loadDiff(file.path, 'staged')"
                          i18n
                        >
                          Staged
                        </button>
                        <button
                          type="button"
                          data-testid="diff-scope-unstaged"
                          (click)="loadDiff(file.path, 'unstaged')"
                          i18n
                        >
                          Unstaged
                        </button>
                      </div>
                      <ng-container *ngTemplateOutlet="diffTemplate" />
                    }
                  </div>
                }
              }
              @case ('WorktreeMissing') {
                <p data-testid="changes-worktree-missing">
                  {{ snap.state.detail }} {{ snap.state.lastKnownBranch }}
                </p>
              }
              @case ('MissingGit') {
                <p data-testid="changes-missing-git">{{ snap.state.detail }}</p>
              }
              @case ('NonGit') {
                <p data-testid="changes-non-git">{{ snap.state.detail }}</p>
              }
              @case ('MissingPath') {
                <p>{{ snap.state.detail }}</p>
              }
              @case ('UnsupportedRepo') {
                <p>{{ snap.state.detail }}</p>
              }
            }
          }
        } @else {
          <button
            type="button"
            data-testid="inspector-back-to-changes"
            class="text-left"
            (click)="view.set('changes')"
            i18n
          >
            Back to changes
          </button>
          <p class="py-2 font-medium" i18n>Git history</p>
          @if (historyError()) {
            <p i18n>Could not load Git history.</p>
          }
          @if (history(); as h) {
            @switch (h._tag) {
              @case ('Unavailable') {
                <p>{{ h.detail }}</p>
              }
              @case ('Unborn') {
                <p i18n>This branch has no commits yet.</p>
              }
              @case ('History') {
                @if (detail(); as d) {
                  <div data-testid="commit-detail-panel">
                    <p>{{ d.commit.subject }}</p>
                    <p class="whitespace-pre-wrap">{{ d.commit.body }}</p>
                    @for (file of d.files; track file.path) {
                      <button
                        type="button"
                        data-testid="commit-file-row"
                        class="block w-full py-1 text-left font-mono text-xs"
                        (click)="loadCommitDiff(d.commit.sha, file.path)"
                      >
                        {{ file.path }}
                      </button>
                    }
                    @if (d.truncatedFiles) {
                      <p i18n>Some files are omitted.</p>
                    }
                    <ng-container *ngTemplateOutlet="diffTemplate" />
                  </div>
                } @else {
                  @for (commit of commits(); track commit.sha) {
                    <button
                      type="button"
                      data-testid="commit-row"
                      [attr.data-sha]="commit.sha"
                      class="hover:bg-accent block w-full rounded py-1 text-left"
                      (click)="loadCommit(commit.sha)"
                    >
                      {{ commit.subject }}
                      <span class="text-muted-foreground font-mono text-xs">{{
                        commit.shortSha
                      }}</span>
                    </button>
                  }
                  @if (h.hasMore) {
                    <button
                      type="button"
                      data-testid="history-load-more"
                      (click)="loadHistory(h.nextOffset ?? commits().length)"
                      i18n
                    >
                      Load more
                    </button>
                  }
                }
              }
            }
          }
        }
        <ng-template #diffTemplate>
          @if (diffError()) {
            <p i18n>Could not load this preview.</p>
          }
          @if (diff(); as preview) {
            @if (preview.unstable) {
              <p data-testid="diff-unstable-banner" i18n>
                File changed while the preview was generated.
              </p>
            }
            @if (preview._tag === 'Unavailable') {
              <p data-testid="diff-unavailable">{{ preview.reason }}: {{ preview.detail }}</p>
            } @else {
              @if (preview.truncated) {
                <p i18n>Preview is truncated.</p>
              }
              <div class="overflow-auto font-mono text-xs">
                @for (hunk of preview.hunks; track $index) {
                  <div class="text-muted-foreground">{{ hunk.header }}</div>
                  @for (line of hunk.lines; track $index) {
                    <div class="whitespace-pre">
                      {{ line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '
                      }}{{ line.text }}
                    </div>
                  }
                }
              </div>
            }
          }
        </ng-template>
      </section>
    }
  `,
})
export class InspectorPanel {
  readonly sessionId = input.required<SessionId>();
  readonly open = input(false);
  readonly summaryChanged = output<CurrentChangesSummary | null>();
  private readonly runtime = inject(EffectRuntime);
  protected readonly snapshot = signal<CurrentChangesSnapshot | null>(null);
  protected readonly error = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly view = signal<'changes' | 'history'>('changes');
  protected readonly expandedPath = signal<string | null>(null);
  protected readonly diff = signal<DiffPreview | null>(null);
  protected readonly diffError = signal(false);
  protected readonly history = signal<CommitHistorySnapshot | null>(null);
  protected readonly historyError = signal(false);
  protected readonly commits = signal<ReadonlyArray<CommitSummary>>([]);
  protected readonly detail = signal<CommitDetail | null>(null);
  private generation = 0;
  private diffGeneration = 0;
  private historyGeneration = 0;
  private statusPending = false;

  constructor() {
    effect((onCleanup) => {
      if (this.open()) {
        this.sessionId();
        this.snapshot.set(null);
        this.expandedPath.set(null);
        this.diff.set(null);
        this.history.set(null);
        this.detail.set(null);
        this.view.set('changes');
        void this.refresh();
        const timer = setInterval(() => {
          if (!this.statusPending) void this.refresh();
        }, 5000);
        onCleanup(() => {
          clearInterval(timer);
          this.generation++;
          this.diffGeneration++;
          this.historyGeneration++;
          this.statusPending = false;
        });
      }
    });
  }
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.statusPending = true;
    const sessionId = this.sessionId();
    const result = await this.runtime.run(
      Effect.flatMap(DesktopApi, (api) => api['SourceControl.status']({ sessionId })),
    );
    if (generation !== this.generation) return;
    this.statusPending = false;
    this.error.set(Exit.isFailure(result));
    if (Exit.isSuccess(result)) {
      this.snapshot.set(result.value);
      this.summaryChanged.emit(
        result.value.state._tag === 'Available' ? result.value.state.summary : null,
      );
    } else {
      this.snapshot.set(null);
      this.summaryChanged.emit(null);
    }
  }
  protected toggleFile(path: string): void {
    if (this.expandedPath() === path) {
      this.expandedPath.set(null);
      return;
    }
    this.expandedPath.set(path);
    void this.loadDiff(path, 'combined');
  }
  protected async loadDiff(path: string, scope: DiffScope): Promise<void> {
    const generation = ++this.diffGeneration;
    this.diff.set(null);
    this.diffError.set(false);
    const sessionId = this.sessionId();
    const result = await this.runtime.run(
      Effect.flatMap(DesktopApi, (api) => api['SourceControl.diff']({ sessionId, path, scope })),
    );
    if (generation !== this.diffGeneration || this.expandedPath() !== path) return;
    if (Exit.isSuccess(result)) this.diff.set(result.value);
    else this.diffError.set(true);
  }
  protected showHistory(): void {
    this.menuOpen.set(false);
    this.view.set('history');
    this.detail.set(null);
    void this.loadHistory(0);
  }
  protected async loadHistory(offset: number): Promise<void> {
    const generation = ++this.historyGeneration;
    const sessionId = this.sessionId();
    const result = await this.runtime.run(
      Effect.flatMap(DesktopApi, (api) => api['SourceControl.commits']({ sessionId, offset })),
    );
    if (generation !== this.historyGeneration) return;
    this.historyError.set(Exit.isFailure(result));
    if (Exit.isSuccess(result)) {
      this.history.set(result.value);
      if (result.value._tag === 'History')
        this.commits.set(
          offset === 0 ? result.value.commits : [...this.commits(), ...result.value.commits],
        );
    }
  }
  protected async loadCommit(sha: string): Promise<void> {
    const generation = ++this.historyGeneration;
    const sessionId = this.sessionId();
    const result = await this.runtime.run(
      Effect.flatMap(DesktopApi, (api) => api['SourceControl.commitDetail']({ sessionId, sha })),
    );
    if (generation !== this.historyGeneration) return;
    if (Exit.isSuccess(result)) {
      this.detail.set(result.value);
      this.diff.set(null);
    } else this.historyError.set(true);
  }
  protected async loadCommitDiff(sha: string, path: string): Promise<void> {
    const generation = ++this.diffGeneration;
    this.diff.set(null);
    this.diffError.set(false);
    const sessionId = this.sessionId();
    const result = await this.runtime.run(
      Effect.flatMap(DesktopApi, (api) =>
        api['SourceControl.commitFileDiff']({ sessionId, sha, path }),
      ),
    );
    if (generation !== this.diffGeneration) return;
    if (Exit.isSuccess(result)) this.diff.set(result.value);
    else this.diffError.set(true);
  }
}
