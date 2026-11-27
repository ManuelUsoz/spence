import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Cause, Effect, Exit } from 'effect';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButtonImports } from '@ui/button';
import { HlmInputImports } from '@ui/input';
import { toast } from '@ui/toast';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import {
  GitHostError,
  PullRequestNumber,
  type AddCommentTarget,
  type CheckRollupStatus,
  type CheckRun,
  type CommentId,
  type HostCapabilities,
  type ProjectPullRequestsState,
  type PullRequestCommentKind,
  type PullRequestDetail,
  type PullRequestRevision,
  type PullRequestSummary,
  type ReviewThread,
  type PullRequestUpdatePatch,
  type ReviewId,
  type ReviewSubmitEvent,
  type ReviewThreadId,
} from '../../../shared/pull-requests/pull-requests.rpc';
import { DesktopApi, type DesktopApiShape } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { PullRequestsState } from '../../core/pull-requests-state';
import { PrCreateForm } from './pr-create-form';
import { PrDetailPane, type DiffLoadState, type PrConflictState } from './pr-detail-pane';
import { PrRenderClient } from './pr-render-client';
import { formatCachedAge, formatResetTime, prStateLabel } from './pr-status';

type PrFilter = 'all' | 'mine' | 'reviewRequested';

type DetailLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'loaded'; readonly value: PullRequestDetail };

/**
 * Dedicated Pull requests page (Variant D):
 * - 48px top toolbar (`All`, `Mine`, `Review requested`, search/filter, `#number` pin, `Refresh`, `Create PR`)
 * - Quiet degraded status strip (`Offline`, `Rate limit`, `Reconnect`)
 * - Unified full-bleed master-detail frame (`340px` left PR list + primary detail pane with `24px 32px` padding)
 */
@Component({
  selector: 'app-pull-requests-page',
  imports: [HlmBadgeImports, HlmButtonImports, HlmInputImports, PrDetailPane, PrCreateForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
    'data-testid': 'pull-requests-page',
  },
  template: `
    <!-- 48px Top Toolbar -->
    <header
      class="border-border/60 flex h-12 min-w-0 shrink-0 items-center justify-between gap-3 border-b px-4"
      data-testid="pull-requests-header"
    >
      <div class="flex min-w-0 items-center gap-2">
        <div
          class="bg-muted/60 border-border/60 flex items-center rounded-lg border p-0.5 text-xs"
          role="tablist"
          aria-label="Pull request filters"
          i18n-aria-label
        >
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="filter() === 'all'"
            data-testid="pr-filter-all"
            class="rounded-md px-2.5 py-1 transition-colors outline-none"
            [class]="
              filter() === 'all'
                ? 'bg-background text-foreground font-medium shadow-2xs'
                : 'text-muted-foreground hover:text-foreground'
            "
            (click)="filter.set('all')"
            i18n
          >
            All
          </button>
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="filter() === 'mine'"
            data-testid="pr-filter-mine"
            class="rounded-md px-2.5 py-1 transition-colors outline-none"
            [class]="
              filter() === 'mine'
                ? 'bg-background text-foreground font-medium shadow-2xs'
                : 'text-muted-foreground hover:text-foreground'
            "
            (click)="filter.set('mine')"
            i18n
          >
            Mine
          </button>
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="filter() === 'reviewRequested'"
            data-testid="pr-filter-review-requested"
            class="rounded-md px-2.5 py-1 transition-colors outline-none"
            [class]="
              filter() === 'reviewRequested'
                ? 'bg-background text-foreground font-medium shadow-2xs'
                : 'text-muted-foreground hover:text-foreground'
            "
            (click)="filter.set('reviewRequested')"
            i18n
          >
            Review requested
          </button>
        </div>

        <input
          hlmInput
          type="search"
          class="h-7 w-44 text-xs"
          placeholder="Filter Pull requests…"
          i18n-placeholder
          data-testid="pr-search-input"
          [value]="searchQuery()"
          (input)="searchQuery.set($any($event.target).value)"
        />
      </div>

      <div class="flex shrink-0 items-center gap-2">
        @if (projectId(); as pid) {
          <form class="flex items-center gap-1" (submit)="lookupNumber($event, pid)">
            <input
              hlmInput
              type="text"
              class="h-7 w-24 font-mono text-xs"
              placeholder="#123"
              aria-label="Look up Pull request by number"
              i18n-aria-label
              data-testid="pr-lookup-input"
              [value]="lookupInput()"
              (input)="lookupInput.set($any($event.target).value)"
            />
            <button
              hlmBtn
              type="submit"
              variant="outline"
              size="sm"
              class="h-7 px-2 text-xs"
              data-testid="pr-lookup-submit"
              [disabled]="lookingUp()"
              i18n
            >
              Pin
            </button>
          </form>

          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="sm"
            class="h-7 px-2.5 text-xs"
            data-testid="pull-requests-refresh"
            (click)="prState.refreshProject(pid)"
            i18n
          >
            Refresh
          </button>

          <button
            hlmBtn
            type="button"
            variant="default"
            size="sm"
            class="h-7 px-2.5 text-xs"
            data-testid="pr-create-button"
            (click)="openCreate()"
            i18n
          >
            Create PR
          </button>
        }
      </div>
    </header>

    <!-- Quiet Degraded Status Strip -->
    @if (degradedBanner(); as banner) {
      <div
        class="border-border/60 bg-muted/40 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-1.5 text-xs"
        data-testid="pr-degraded-strip"
      >
        <span class="text-muted-foreground">{{ banner.message }}</span>
        @if (banner.action === 'reconnect') {
          <button
            hlmBtn
            type="button"
            variant="outline"
            size="sm"
            class="h-6 px-2 text-xs"
            data-testid="pr-degraded-reconnect"
            (click)="triggerOpenSettings()"
            i18n
          >
            Reconnect
          </button>
        } @else {
          <button
            hlmBtn
            type="button"
            variant="outline"
            size="sm"
            class="h-6 px-2 text-xs"
            data-testid="pr-degraded-retry"
            (click)="retryProject()"
            i18n
          >
            Retry
          </button>
        }
      </div>
    }

    @if (lookupError(); as err) {
      <div
        class="border-border/60 bg-destructive/10 text-destructive flex shrink-0 items-center justify-between gap-2 border-b px-4 py-1.5 text-xs"
        data-testid="pr-lookup-error"
      >
        <span>{{ err }}</span>
        <button
          type="button"
          class="underline underline-offset-2"
          (click)="lookupError.set(null)"
          i18n
        >
          Dismiss
        </button>
      </div>
    }

    <!-- Body -->
    @if (projectId() === null) {
      <div class="flex flex-1 items-center justify-center p-8" data-testid="pull-requests-view">
        <p class="font-display text-muted-foreground text-xl font-normal" i18n>
          Select a Project to view Pull requests.
        </p>
      </div>
    } @else if (projectState(); as state) {
      @if (state._tag === 'Unavailable') {
        <div class="flex flex-1 items-center justify-center p-8" data-testid="pull-requests-view">
          <p class="text-muted-foreground text-sm" data-testid="pr-unavailable-detail">
            {{ state.detail }}
          </p>
        </div>
      } @else if (state.accountStatus === 'disconnected' && state.summaries.length === 0) {
        <div
          class="flex flex-1 flex-col items-center justify-center gap-3 p-8"
          data-testid="pull-requests-view"
        >
          <p
            class="font-display text-muted-foreground text-xl font-normal"
            data-testid="pr-empty-disconnected"
            i18n
          >
            Connect GitHub to view Pull requests.
          </p>
          <button
            hlmBtn
            type="button"
            variant="outline"
            size="sm"
            data-testid="pr-connect-github"
            (click)="triggerOpenSettings()"
            i18n
          >
            Connect GitHub
          </button>
        </div>
      } @else if (state.summaries.length === 0 && extraSummaries().length === 0) {
        <div class="flex flex-1 items-center justify-center p-8" data-testid="pull-requests-view">
          <p
            class="font-display text-muted-foreground text-xl font-normal"
            data-testid="pr-empty-repo"
            i18n
          >
            No Pull requests in {{ projectName() }} yet.
          </p>
        </div>
      } @else {
        <!-- Unified Master-Detail Frame (ChangesFrame geometry) -->
        <div class="@container flex min-h-0 min-w-0 flex-1" data-testid="pull-requests-view">
          <!-- 340px Left PR List Pane -->
          <aside
            class="border-border/60 flex min-h-0 w-full flex-col overflow-y-auto border-r data-[view=viewer]:@max-3xl:hidden @3xl:w-[340px] @3xl:shrink-0"
            [attr.data-view]="narrowPane()"
            data-testid="pr-list-pane"
          >
            @if (filteredSummaries().length === 0) {
              <p class="text-muted-foreground p-6 text-center text-sm" i18n>
                No matching Pull requests.
              </p>
            } @else {
              <ul class="divide-border/60 divide-y">
                @for (pr of filteredSummaries(); track pr.ref.number) {
                  @let selected = selectedNumber() === pr.ref.number && !createMode();
                  <li>
                    <div
                      class="flex items-start gap-2 px-4 py-3 transition-colors"
                      [class]="selected ? 'bg-accent/70' : 'hover:bg-accent/40'"
                    >
                      <button
                        type="button"
                        class="min-w-0 flex-1 text-left outline-none"
                        [attr.data-testid]="'pr-list-item-' + pr.ref.number"
                        [attr.aria-current]="selected ? 'true' : null"
                        (click)="selectPr(pr.ref.number)"
                      >
                        <div class="flex items-center gap-1.5">
                          <span
                            class="size-2 shrink-0 rounded-full"
                            [class]="rollupDotClass(pr.checkRollup)"
                            [attr.aria-label]="pr.checkRollup"
                          ></span>
                          <span class="text-muted-foreground font-mono text-xs tabular-nums">
                            #{{ pr.ref.number }}
                          </span>
                          <span class="truncate text-sm font-medium">{{ pr.title }}</span>
                        </div>
                        <div
                          class="text-muted-foreground mt-1 flex items-center gap-1.5 font-mono text-xs"
                        >
                          <span class="truncate">{{ pr.headRef }}</span>
                          <span aria-hidden="true">→</span>
                          <span class="truncate">{{ pr.baseRef }}</span>
                        </div>
                        <div
                          class="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-2 text-xs"
                        >
                          <span hlmBadge variant="outline" class="text-[10px]">{{
                            prStateLabel(pr.state)
                          }}</span>
                          <span>{{ pr.author.login }}</span>
                          <span class="tabular-nums">{{ pr.commentCount }} comments</span>
                          @if (pr.unresolvedThreadCount !== null && pr.unresolvedThreadCount > 0) {
                            <span class="tabular-nums"
                              >{{ pr.unresolvedThreadCount }} unresolved</span
                            >
                          }
                          @if (pr.isPinned) {
                            <span hlmBadge variant="secondary" class="text-[10px]" i18n
                              >Pinned</span
                            >
                          }
                        </div>
                      </button>

                      @if (pr.isPinned) {
                        <button
                          type="button"
                          class="text-muted-foreground hover:text-foreground shrink-0 px-1 text-xs"
                          aria-label="Unpin Pull request"
                          i18n-aria-label
                          [attr.data-testid]="'pr-unpin-' + pr.ref.number"
                          (click)="unpinPr(pr.ref.number)"
                        >
                          ×
                        </button>
                      }
                    </div>
                  </li>
                }
              </ul>
            }
          </aside>

          <!-- Primary Detail Pane (24px 32px padding) -->
          <section
            class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto data-[view=list]:@max-3xl:hidden"
            [attr.data-view]="narrowPane()"
            data-testid="pr-viewer-pane"
          >
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground focus-visible:ring-ring border-border/60 flex h-9 shrink-0 items-center gap-1 border-b px-3 text-left text-xs outline-none focus-visible:ring-2 @3xl:hidden"
              data-testid="pr-viewer-back"
              (click)="narrowPane.set('list')"
              i18n
            >
              ← Back to Pull requests
            </button>

            <div class="min-h-0 flex-1 px-8 py-6">
              @if (createMode()) {
                @if (projectId(); as pid) {
                  <app-pr-create-form
                    [projectId]="pid"
                    [worktreePath]="createWorktreePath()"
                    (cancelled)="closeCreateMode()"
                    (created)="onPrCreated($event)"
                  />
                }
              } @else if (selectedNumber() === null) {
                <div class="flex h-full items-center justify-center">
                  <p class="font-display text-muted-foreground text-xl font-normal" i18n>
                    Select a Pull request to inspect.
                  </p>
                </div>
              } @else {
                @switch (detailLoad().status) {
                  @case ('loading') {
                    <p class="text-muted-foreground text-sm" i18n>Loading Pull request…</p>
                  }
                  @case ('failed') {
                    @if (detailLoad(); as failed) {
                      @if (failed.status === 'failed') {
                        <div class="space-y-3" data-testid="pr-detail-error">
                          <p class="text-muted-foreground text-sm">{{ failed.detail }}</p>
                          <button
                            hlmBtn
                            type="button"
                            variant="outline"
                            size="sm"
                            (click)="reloadSelected()"
                            i18n
                          >
                            Retry
                          </button>
                        </div>
                      }
                    }
                  }
                  @case ('loaded') {
                    @if (detailLoad(); as loaded) {
                      @if (loaded.status === 'loaded') {
                        <app-pr-detail-pane
                          [detail]="loaded.value"
                          [diffState]="diffLoad()"
                          [renderClient]="renderClient"
                          [selectedThreadId]="prState.selectedThreadId()"
                          [selectedCheckId]="prState.selectedCheckId()"
                          [capabilities]="projectCapabilities()"
                          [mutating]="mutating()"
                          [conflictState]="conflictState()"
                          (retryDiff)="reloadDiffOnly()"
                          (openLink)="openExternal($event)"
                          (referencePr)="referencePrInSession(loaded.value)"
                          (startSession)="startSessionFromPr(loaded.value)"
                          (referenceThread)="referenceThreadInSession(loaded.value, $event)"
                          (referenceCheck)="referenceCheckInSession(loaded.value, $event)"
                          (saveEdit)="handleSaveEdit($event)"
                          (clearConflict)="conflictState.set(null)"
                          (addComment)="handleAddComment($event)"
                          (editComment)="handleEditComment($event)"
                          (deleteComment)="handleDeleteComment($event)"
                          (submitReview)="handleSubmitReview($event)"
                          (deletePendingReview)="handleDeletePendingReview($event)"
                          (resolveThread)="handleResolveThread($event)"
                        />
                      }
                    }
                  }
                }
              }
            </div>
          </section>
        </div>
      }
    } @else {
      <div class="flex flex-1 items-center justify-center p-8" data-testid="pull-requests-view">
        <p class="text-muted-foreground text-sm" i18n>Loading Pull requests…</p>
      </div>
    }
  `,
})
export class PullRequestsPage {
  readonly projectId = input<ProjectId | null>(null);
  readonly projectName = input<string>('');
  readonly openSettings = output<void>();

  protected readonly prState = inject(PullRequestsState);
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly renderClient = new PrRenderClient();
  protected readonly filter = signal<PrFilter>('all');
  protected readonly searchQuery = signal('');
  protected readonly lookupInput = signal('');
  protected readonly lookingUp = signal(false);
  protected readonly lookupError = signal<string | null>(null);
  protected readonly createMode = signal(false);
  protected readonly createWorktreePath = signal<string | null>(null);
  protected readonly narrowPane = signal<'list' | 'viewer'>('list');
  protected readonly extraSummaries = signal<ReadonlyArray<PullRequestSummary>>([]);
  protected readonly detailLoad = signal<DetailLoadState>({ status: 'idle' });
  protected readonly diffLoad = signal<DiffLoadState>({ status: 'loading' });
  protected readonly mutating = signal(false);
  protected readonly conflictState = signal<PrConflictState | null>(null);
  private readonly detailPane = viewChild(PrDetailPane);

  protected readonly prStateLabel = prStateLabel;

  protected readonly projectState = computed<ProjectPullRequestsState | null>(() =>
    this.prState.stateForProject(this.projectId()),
  );

  protected readonly projectCapabilities = computed<HostCapabilities | null>(() => {
    const state = this.projectState();
    return state?._tag === 'Available' ? state.capabilities : null;
  });

  protected readonly selectedNumber = computed<PullRequestNumber | null>(() =>
    this.prState.selectedPrNumber(),
  );

  protected readonly degradedBanner = computed(
    (): { readonly message: string; readonly action: 'retry' | 'reconnect' } | null => {
      const state = this.projectState();
      if (state?._tag !== 'Available') return null;
      if (
        state.accountStatus === 'needs-reconnect' ||
        state.syncStatus.status === 'needs-reconnect'
      ) {
        return {
          message: $localize`Reconnect GitHub in Settings · cached`,
          action: 'reconnect',
        };
      }
      if (state.syncStatus.status === 'offline') {
        const age = formatCachedAge(state.lastSyncedAt);
        return {
          message: $localize`Offline · cached ${age}`,
          action: 'retry',
        };
      }
      if (state.syncStatus.status === 'rate-limited') {
        const time = formatResetTime(state.syncStatus.resetAt);
        return {
          message: $localize`GitHub rate limit reached · resets at ${time} · cached`,
          action: 'retry',
        };
      }
      return null;
    },
  );

  protected readonly filteredSummaries = computed<ReadonlyArray<PullRequestSummary>>(() => {
    const state = this.projectState();
    if (state?._tag !== 'Available') return [];

    const byNumber = new Map<number, PullRequestSummary>();
    for (const s of state.summaries) {
      byNumber.set(s.ref.number, s);
    }
    for (const s of this.extraSummaries()) {
      if (!byNumber.has(s.ref.number)) {
        byNumber.set(s.ref.number, s);
      }
    }

    const activeFilter = this.filter();
    const q = this.searchQuery().trim().toLowerCase();

    return Array.from(byNumber.values()).filter((pr) => {
      if (activeFilter === 'mine' && !pr.viewerRoles.includes('author')) return false;
      if (activeFilter === 'reviewRequested' && !pr.viewerRoles.includes('reviewer')) return false;
      if (q.length === 0) return true;
      return (
        pr.title.toLowerCase().includes(q) ||
        `#${pr.ref.number}`.includes(q) ||
        pr.headRef.toLowerCase().includes(q) ||
        pr.baseRef.toLowerCase().includes(q) ||
        pr.author.login.toLowerCase().includes(q)
      );
    });
  });

  private loadSeq = 0;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.renderClient.dispose();
    });

    effect(() => {
      const req = this.prState.createRequested();
      if (req !== null) {
        this.createWorktreePath.set(req.worktreePath);
        this.createMode.set(true);
        this.narrowPane.set('viewer');
      }
    });

    effect(() => {
      const pid = this.projectId();
      const num = this.selectedNumber();
      if (pid === null || num === null) {
        this.detailLoad.set({ status: 'idle' });
        return;
      }
      this.fetchPr(pid, num);
    });
  }

  protected openCreate(): void {
    this.createWorktreePath.set(null);
    this.createMode.set(true);
    this.narrowPane.set('viewer');
  }

  protected closeCreateMode(): void {
    this.createMode.set(false);
    this.createWorktreePath.set(null);
    this.prState.clearCreateRequest();
  }

  protected onPrCreated(summary: PullRequestSummary): void {
    this.createMode.set(false);
    this.createWorktreePath.set(null);
    this.prState.clearCreateRequest();
    const pid = this.projectId();
    if (pid !== null) {
      this.prState.refreshProject(pid);
    }
    this.selectPr(summary.ref.number);
  }

  protected selectPr(num: PullRequestNumber): void {
    this.createMode.set(false);
    this.narrowPane.set('viewer');
    this.prState.selectedPrNumber.set(num);
    this.prState.setActiveView({
      projectId: this.projectId(),
      prPageOpen: true,
      activePrNumber: num,
    });
  }

  protected reloadSelected(): void {
    const pid = this.projectId();
    const num = this.selectedNumber();
    if (pid !== null && num !== null) {
      this.fetchPr(pid, num, true);
    }
  }

  protected reloadDiffOnly(): void {
    const pid = this.projectId();
    const num = this.selectedNumber();
    if (pid === null || num === null) return;
    this.diffLoad.set({ status: 'loading' });
    void this.runtime.run(
      DesktopApi.use((api) => api['PullRequests.getDiff']({ projectId: pid, number: num })).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              this.diffLoad.set({ status: 'loaded', diff: exit.value });
            } else {
              this.diffLoad.set({ status: 'failed', detail: $localize`Could not load diff.` });
            }
          }),
        ),
      ),
    );
  }

  private fetchPr(pid: ProjectId, num: PullRequestNumber, bypassEtag = false): void {
    const seq = ++this.loadSeq;
    this.detailLoad.set({ status: 'loading' });
    this.diffLoad.set({ status: 'loading' });

    void this.runtime.run(
      DesktopApi.use((api) =>
        api['PullRequests.getDetail']({
          projectId: pid,
          number: num,
          ...(bypassEtag ? { bypassEtag: true } : {}),
        }),
      ).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            if (seq !== this.loadSeq) return;
            if (Exit.isSuccess(exit)) {
              this.detailLoad.set({ status: 'loaded', value: exit.value });
            } else {
              this.detailLoad.set({
                status: 'failed',
                detail: $localize`Could not load Pull request details.`,
              });
            }
          }),
        ),
      ),
    );

    void this.runtime.run(
      DesktopApi.use((api) => api['PullRequests.getDiff']({ projectId: pid, number: num })).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            if (seq !== this.loadSeq) return;
            if (Exit.isSuccess(exit)) {
              this.diffLoad.set({ status: 'loaded', diff: exit.value });
            } else {
              this.diffLoad.set({ status: 'failed', detail: $localize`Could not load diff.` });
            }
          }),
        ),
      ),
    );
  }

  protected lookupNumber(event: Event, pid: ProjectId): void {
    event.preventDefault();
    const raw = this.lookupInput().trim().replace(/^#/, '');
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      this.lookupError.set($localize`Enter a valid Pull request number (e.g. #123).`);
      return;
    }
    this.lookupError.set(null);
    this.lookingUp.set(true);
    const num = PullRequestNumber.make(parsed);

    void this.runtime.run(
      DesktopApi.use((api) =>
        api['PullRequests.lookupByNumber']({ projectId: pid, number: num }),
      ).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            this.lookingUp.set(false);
            if (Exit.isSuccess(exit)) {
              const summary = exit.value;
              this.extraSummaries.update((prev) => [
                summary,
                ...prev.filter((s) => s.ref.number !== summary.ref.number),
              ]);
              this.lookupInput.set('');
              this.selectPr(summary.ref.number);
            } else {
              this.lookupError.set($localize`Pull request #${parsed} was not found.`);
            }
          }),
        ),
      ),
    );
  }

  protected unpinPr(num: PullRequestNumber): void {
    const pid = this.projectId();
    if (pid === null) return;
    this.extraSummaries.update((prev) => prev.filter((s) => s.ref.number !== num));
    if (this.selectedNumber() === num) {
      this.prState.selectedPrNumber.set(null);
      this.prState.setActiveView({ projectId: pid, prPageOpen: true, activePrNumber: null });
    }
    void this.runtime.run(
      DesktopApi.use((api) =>
        api['PullRequests.unpinNumber']({ projectId: pid, number: num }),
      ).pipe(Effect.ignore),
    );
  }

  protected retryProject(): void {
    const pid = this.projectId();
    if (pid !== null) this.prState.refreshProject(pid);
  }

  protected triggerOpenSettings(): void {
    this.openSettings.emit();
    this.prState.requestOpenSettings();
  }

  protected openExternal(url: string): void {
    void this.runtime.run(
      DesktopApi.use((api) => api['Links.openExternal']({ url })).pipe(Effect.ignore),
    );
  }

  protected referencePrInSession(detail: PullRequestDetail): void {
    const pid = this.projectId();
    if (pid === null) return;
    this.prState.referenceInSession({
      kind: 'pullRequest',
      projectId: pid,
      ref: detail.ref,
      title: detail.title,
      state: detail.state,
      headSha: detail.headSha,
      url: detail.url,
    });
  }

  protected referenceThreadInSession(detail: PullRequestDetail, thread: ReviewThread): void {
    const pid = this.projectId();
    if (pid === null) return;
    this.prState.referenceInSession({
      kind: 'reviewThread',
      projectId: pid,
      ref: detail.ref,
      title: detail.title,
      state: detail.state,
      headSha: detail.headSha,
      url: detail.url,
      threadId: thread.id,
      path: thread.path,
      line: thread.line,
    });
  }

  protected referenceCheckInSession(detail: PullRequestDetail, check: CheckRun): void {
    const pid = this.projectId();
    if (pid === null) return;
    this.prState.referenceInSession({
      kind: 'checkRun',
      projectId: pid,
      ref: detail.ref,
      title: detail.title,
      state: detail.state,
      headSha: detail.headSha,
      url: detail.url,
      checkId: check.id,
      checkName: check.name,
      checkUrl: check.url,
    });
  }

  protected startSessionFromPr(detail: PullRequestDetail): void {
    const pid = this.projectId();
    if (pid === null) return;
    const state = this.projectState();
    const targetRemoteName = state?._tag === 'Available' ? state.targetRemoteName : 'origin';
    this.prState.startSessionFromPr(pid, detail, targetRemoteName);
  }

  private runDetailMutation(
    fn: (
      api: DesktopApiShape,
      projectId: ProjectId,
      number: PullRequestNumber,
    ) => ReturnType<DesktopApiShape['PullRequests.update']>,
    options?: { readonly onSuccess?: () => void },
  ): void {
    const pid = this.projectId();
    const num = this.selectedNumber();
    if (pid === null || num === null) return;
    this.mutating.set(true);
    void this.runtime.run(
      DesktopApi.use((api) => fn(api, pid, num)).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            this.mutating.set(false);
            if (Exit.isSuccess(exit)) {
              this.detailLoad.set({ status: 'loaded', value: exit.value });
              options?.onSuccess?.();
              return;
            }
            const err = Cause.squash(exit.cause);
            if (err instanceof GitHostError && err.reason === 'Conflict' && err.latestDetail) {
              this.conflictState.set({
                conflictingFields: err.conflictingFields ?? [],
                latestDetail: err.latestDetail,
              });
              this.detailLoad.set({ status: 'loaded', value: err.latestDetail });
              return;
            }
            const message =
              err instanceof GitHostError ? err.detail : $localize`Pull request action failed.`;
            toast.error(message);
          }),
        ),
      ),
    );
  }

  protected handleSaveEdit(event: {
    readonly revision: PullRequestRevision;
    readonly patch: PullRequestUpdatePatch;
    readonly baseline: PullRequestUpdatePatch;
  }): void {
    this.conflictState.set(null);
    this.runDetailMutation(
      (api, projectId, number) =>
        api['PullRequests.update']({
          projectId,
          number,
          revision: event.revision,
          patch: event.patch,
          baseline: event.baseline,
        }),
      { onSuccess: () => this.detailPane()?.closeEditForm() },
    );
  }

  protected handleAddComment(event: {
    readonly body: string;
    readonly target: AddCommentTarget;
  }): void {
    this.runDetailMutation((api, projectId, number) =>
      api['PullRequests.addComment']({
        projectId,
        number,
        body: event.body,
        target: event.target,
      }),
    );
  }

  protected handleEditComment(event: {
    readonly commentId: CommentId;
    readonly kind: PullRequestCommentKind;
    readonly body: string;
  }): void {
    this.runDetailMutation((api, projectId, number) =>
      api['PullRequests.editComment']({
        projectId,
        number,
        commentId: event.commentId,
        kind: event.kind,
        body: event.body,
      }),
    );
  }

  protected handleDeleteComment(event: {
    readonly commentId: CommentId;
    readonly kind: PullRequestCommentKind;
  }): void {
    this.runDetailMutation((api, projectId, number) =>
      api['PullRequests.deleteComment']({
        projectId,
        number,
        commentId: event.commentId,
        kind: event.kind,
      }),
    );
  }

  protected handleSubmitReview(event: {
    readonly reviewId?: ReviewId;
    readonly event: ReviewSubmitEvent;
    readonly body: string;
  }): void {
    this.runDetailMutation((api, projectId, number) =>
      api['PullRequests.submitReview']({
        projectId,
        number,
        ...(event.reviewId !== undefined ? { reviewId: event.reviewId } : {}),
        event: event.event,
        body: event.body,
      }),
    );
  }

  protected handleDeletePendingReview(event: { readonly reviewId: ReviewId }): void {
    this.runDetailMutation((api, projectId, number) =>
      api['PullRequests.deletePendingReview']({
        projectId,
        number,
        reviewId: event.reviewId,
      }),
    );
  }

  protected handleResolveThread(event: {
    readonly threadId: ReviewThreadId;
    readonly resolved: boolean;
  }): void {
    this.runDetailMutation((api, projectId, number) =>
      event.resolved
        ? api['PullRequests.resolveThread']({
            projectId,
            number,
            threadId: event.threadId,
          })
        : api['PullRequests.unresolveThread']({
            projectId,
            number,
            threadId: event.threadId,
          }),
    );
  }

  protected rollupDotClass(rollup: CheckRollupStatus): string {
    switch (rollup) {
      case 'passing':
        return 'bg-diff-add';
      case 'failing':
        return 'bg-destructive';
      case 'pending':
        return 'bg-amber-500';
      case 'none':
        return 'bg-muted-foreground/40';
    }
  }
}
