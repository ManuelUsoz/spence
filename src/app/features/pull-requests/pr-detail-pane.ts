import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButtonImports } from '@ui/button';
import { MarkdownView, type MarkdownBlock } from '@ui/markdown';
import { isAllowedExternalUrl } from '../../../shared/links/link-policy';
import type {
  CheckRun,
  CheckRunId,
  PullRequestDetail,
  PullRequestDiff,
  ReviewThread,
  ReviewThreadId,
} from '../../../shared/pull-requests/pull-requests.rpc';
import { PrDiffView } from './pr-diff-view';
import type { PrRenderClient } from './pr-render-client';
import {
  checkRollupLabel,
  isNonBlockingCheck,
  mergeStateLabel,
  prStateLabel,
  reviewDecisionLabel,
  reviewStateLabel,
} from './pr-status';

export type DiffLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'loaded'; readonly diff: PullRequestDiff };

/**
 * Three-tier Pull request detail inspector:
 * 1. Header & metadata (number, title, state, branches, author, labels, reviewers, assignees, milestone, mergeability, external link)
 * 2. Check rollup & expandable Check runs
 * 3. Conversation (description, top-level Reviews, Review threads, general comments) and Changed files diff
 */
@Component({
  selector: 'app-pr-detail-pane',
  imports: [HlmBadgeImports, HlmButtonImports, MarkdownView, PrDiffView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-6', 'data-testid': 'pr-detail-pane' },
  template: `
    <!-- Header & Metadata -->
    <header class="border-border/60 space-y-3 border-b pb-5" data-testid="pr-detail-header">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1 space-y-1.5">
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="text-muted-foreground font-mono text-xs tabular-nums"
              data-testid="pr-detail-number"
            >
              #{{ detail().ref.number }}
            </span>
            <span
              hlmBadge
              [variant]="stateBadgeVariant()"
              class="text-xs"
              data-testid="pr-detail-state"
            >
              {{ prStateLabel(detail().state) }}
            </span>
            @if (detail().isPinned) {
              <span hlmBadge variant="outline" class="text-xs" i18n>Pinned</span>
            }
          </div>
          <h2 class="text-lg font-medium tracking-tight" data-testid="pr-detail-title">
            {{ detail().title }}
          </h2>
          <div
            class="text-muted-foreground flex flex-wrap items-center gap-2 text-xs"
            data-testid="pr-detail-branches"
          >
            <span class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{{
              detail().headRef
            }}</span>
            <span aria-hidden="true">→</span>
            <span class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{{
              detail().baseRef
            }}</span>
            <span class="text-muted-foreground/70">·</span>
            <span>{{ detail().author.displayName ?? detail().author.login }}</span>
            <span class="text-muted-foreground/70">·</span>
            <span class="font-mono text-xs">{{ detail().headSha.slice(0, 7) }}</span>
          </div>
        </div>

        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <button
            hlmBtn
            type="button"
            variant="default"
            size="sm"
            data-testid="pr-start-session"
            (click)="startSession.emit()"
            i18n
          >
            Start Session
          </button>
          <button
            hlmBtn
            type="button"
            variant="outline"
            size="sm"
            data-testid="pr-reference-in-session"
            (click)="referencePr.emit()"
            i18n
          >
            Reference in Session
          </button>
          <button
            hlmBtn
            type="button"
            variant="outline"
            size="sm"
            data-testid="pr-open-external"
            (click)="openLink.emit(detail().url)"
            i18n
          >
            Open in GitHub
          </button>
        </div>
      </div>

      <!-- Metadata grid -->
      <dl
        class="text-muted-foreground grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3"
        data-testid="pr-detail-metadata"
      >
        <div class="flex items-center gap-1.5">
          <dt class="font-medium" i18n>Mergeability:</dt>
          <dd class="text-foreground" data-testid="pr-detail-merge-state">
            {{ mergeStateLabel(detail().mergeState) }}
            @if (detail().autoMergeEnabled) {
              <span class="text-muted-foreground ml-1" i18n>(Auto-merge on)</span>
            }
          </dd>
        </div>

        <div class="flex items-center gap-1.5">
          <dt class="font-medium" i18n>Review:</dt>
          <dd class="text-foreground">{{ reviewDecisionLabel(detail().reviewDecision) }}</dd>
        </div>

        @if (detail().milestone; as milestone) {
          <div class="flex items-center gap-1.5">
            <dt class="font-medium" i18n>Milestone:</dt>
            <dd class="text-foreground" data-testid="pr-detail-milestone">{{ milestone.title }}</dd>
          </div>
        }

        @if (detail().reviewers.length > 0) {
          <div class="flex flex-wrap items-center gap-1.5">
            <dt class="font-medium" i18n>Reviewers:</dt>
            <dd class="text-foreground" data-testid="pr-detail-reviewers">
              {{ formatActors(detail().reviewers) }}
            </dd>
          </div>
        }

        @if (detail().assignees.length > 0) {
          <div class="flex flex-wrap items-center gap-1.5">
            <dt class="font-medium" i18n>Assignees:</dt>
            <dd class="text-foreground" data-testid="pr-detail-assignees">
              {{ formatActors(detail().assignees) }}
            </dd>
          </div>
        }

        @if (detail().labels.length > 0) {
          <div class="flex flex-wrap items-center gap-1.5 sm:col-span-2 lg:col-span-3">
            <dt class="font-medium" i18n>Labels:</dt>
            <dd class="flex flex-wrap gap-1" data-testid="pr-detail-labels">
              @for (label of detail().labels; track label.name) {
                <span hlmBadge variant="secondary" class="text-[11px]">{{ label.name }}</span>
              }
            </dd>
          </div>
        }
      </dl>

      @if (detail().mergeStateReason) {
        <p class="text-muted-foreground text-xs">{{ detail().mergeStateReason }}</p>
      }
    </header>

    <!-- Check Rollup & Expandable Check Runs -->
    <section class="border-border/60 bg-card rounded-lg border" data-testid="pr-checks-section">
      <button
        type="button"
        class="hover:bg-accent/50 focus-visible:ring-ring flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left outline-none focus-visible:ring-2"
        [attr.aria-expanded]="checksExpanded()"
        data-testid="pr-checks-toggle"
        (click)="checksExpanded.set(!checksExpanded())"
      >
        <div class="flex items-center gap-2 text-sm font-medium">
          <span class="text-muted-foreground w-3 text-xs" aria-hidden="true">{{
            checksExpanded() ? '▾' : '▸'
          }}</span>
          <span data-testid="pr-checks-rollup">{{ checkRollupLabel(detail().checkRollup) }}</span>
          <span class="text-muted-foreground font-normal tabular-nums">
            ({{ detail().checks.length }})
          </span>
        </div>
        @if (failingCheckCount() > 0) {
          <span hlmBadge variant="destructive" class="text-xs tabular-nums">
            {{ failingCheckCount() }} failing
          </span>
        } @else if (pendingCheckCount() > 0) {
          <span hlmBadge variant="secondary" class="text-xs tabular-nums">
            {{ pendingCheckCount() }} pending
          </span>
        }
      </button>

      @if (checksExpanded()) {
        <div class="border-border/60 divide-border/60 divide-y border-t">
          @if (detail().checks.length === 0) {
            <p class="text-muted-foreground px-4 py-3 text-xs" i18n>
              No check runs reported for this commit.
            </p>
          } @else {
            @for (check of detail().checks; track check.id) {
              <div class="px-4 py-2.5" [attr.data-testid]="'pr-check-' + check.id">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="truncate text-sm font-medium">{{ check.name }}</span>
                    <span hlmBadge [variant]="checkBadgeVariant(check)" class="text-[10px]">
                      {{ checkConclusionLabel(check) }}
                    </span>
                    @if (check.isRequired) {
                      <span hlmBadge variant="outline" class="text-[10px]" i18n>Required</span>
                    }
                    @if (isNonBlockingCheck(check)) {
                      <span class="text-muted-foreground text-[11px]" i18n>Non-blocking</span>
                    }
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    @if (isFailingCheck(check)) {
                      <button
                        type="button"
                        class="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
                        [attr.data-testid]="'pr-check-reference-' + check.id"
                        (click)="referenceCheck.emit(check)"
                        i18n
                      >
                        Reference in Session
                      </button>
                    }
                    @if (check.summary) {
                      <button
                        type="button"
                        class="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
                        [attr.data-testid]="'pr-check-summary-toggle-' + check.id"
                        (click)="toggleCheckSummary(check.id)"
                      >
                        {{ isCheckSummaryExpanded(check.id) ? hideDetailsLabel : detailsLabel }}
                      </button>
                    }
                    @if (check.url && isAllowedLink(check.url)) {
                      <button
                        type="button"
                        class="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
                        (click)="openLink.emit(check.url)"
                        i18n
                      >
                        Details
                      </button>
                    }
                  </div>
                </div>
                @if (check.summary && isCheckSummaryExpanded(check.id)) {
                  <div class="bg-muted/30 border-border/60 mt-2 rounded-md border p-3 text-sm">
                    <app-markdown-view
                      [text]="check.summary"
                      [precomputedBlocks]="markdownMap().get('check-' + check.id) ?? null"
                      [isAllowedLink]="isAllowedLink"
                      (openLink)="openLink.emit($event)"
                    />
                  </div>
                }
              </div>
            }
          }
        </div>
      }
    </section>

    <!-- Description -->
    <section class="space-y-2" data-testid="pr-description-section">
      <h3 class="text-sm font-medium" i18n>Description</h3>
      @if (detail().body.trim().length === 0) {
        <p class="text-muted-foreground text-sm italic" i18n>No description provided.</p>
      } @else {
        <div class="border-border/60 bg-card rounded-lg border p-4 text-sm leading-relaxed">
          <app-markdown-view
            [text]="detail().body"
            [precomputedBlocks]="markdownMap().get('body') ?? null"
            [isAllowedLink]="isAllowedLink"
            (openLink)="openLink.emit($event)"
          />
        </div>
      }
    </section>

    <!-- Conversation: Top-level Reviews, Review Threads & General Comments -->
    <section class="space-y-4" data-testid="pr-conversation-section">
      <h3 class="text-sm font-medium" i18n>
        Conversation
        <span class="text-muted-foreground ml-1 font-normal tabular-nums">
          ({{ detail().reviews.length + detail().comments.length + detail().reviewThreads.length }})
        </span>
      </h3>

      @if (
        detail().reviews.length === 0 &&
        detail().comments.length === 0 &&
        detail().reviewThreads.length === 0
      ) {
        <p class="text-muted-foreground text-sm" i18n>No reviews or comments yet.</p>
      } @else {
        @if (detail().reviews.length > 0) {
          <div class="space-y-2" data-testid="pr-reviews-list">
            @for (review of detail().reviews; track review.id) {
              <article
                class="border-border/60 bg-card space-y-2 rounded-lg border p-3.5 text-sm"
                [attr.data-testid]="'pr-review-' + review.id"
              >
                <div class="flex items-center justify-between gap-2 text-xs">
                  <div class="flex items-center gap-2">
                    <span class="font-medium">{{
                      review.author.displayName ?? review.author.login
                    }}</span>
                    <span hlmBadge variant="secondary" class="text-[10px]">
                      {{ reviewStateLabel(review.state) }}
                    </span>
                  </div>
                </div>
                @if (review.body.trim().length > 0) {
                  <app-markdown-view
                    [text]="review.body"
                    [precomputedBlocks]="markdownMap().get('review-' + review.id) ?? null"
                    [isAllowedLink]="isAllowedLink"
                    (openLink)="openLink.emit($event)"
                  />
                }
              </article>
            }
          </div>
        }

        @if (detail().reviewThreads.length > 0) {
          <div class="space-y-2" data-testid="pr-review-threads-list">
            <h4 class="text-muted-foreground text-xs font-medium" i18n>
              Review threads ({{ detail().reviewThreads.length }})
            </h4>
            @for (thread of detail().reviewThreads; track thread.id) {
              <article
                class="border-border/60 bg-card space-y-2 rounded-lg border p-3.5 text-sm"
                [attr.data-testid]="'pr-review-thread-' + thread.id"
              >
                <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-mono text-xs">
                      {{ thread.path }}
                      @if (thread.line !== null) {
                        :{{ thread.line }}
                      }
                    </span>
                    @if (thread.isOutdated) {
                      <span hlmBadge variant="outline" class="text-[10px]" i18n>Outdated</span>
                    }
                    <span hlmBadge variant="secondary" class="text-[10px]">
                      {{ thread.isResolved ? resolvedLabel : unresolvedLabel }}
                    </span>
                  </div>
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
                    [attr.data-testid]="'pr-thread-reference-' + thread.id"
                    (click)="referenceThread.emit(thread)"
                    i18n
                  >
                    Reference in Session
                  </button>
                </div>
                <div class="space-y-2">
                  @for (comment of thread.comments; track comment.id) {
                    <div>
                      <p class="text-muted-foreground mb-0.5 text-xs">
                        <span class="text-foreground font-medium">{{
                          comment.author.displayName ?? comment.author.login
                        }}</span>
                      </p>
                      <app-markdown-view
                        [text]="comment.body"
                        [precomputedBlocks]="markdownMap().get('thread-' + comment.id) ?? null"
                        [isAllowedLink]="isAllowedLink"
                        (openLink)="openLink.emit($event)"
                      />
                    </div>
                  }
                </div>
              </article>
            }
          </div>
        }

        @if (detail().comments.length > 0) {
          <div class="space-y-2" data-testid="pr-comments-list">
            @for (comment of detail().comments; track comment.id) {
              <article
                class="border-border/60 bg-card space-y-2 rounded-lg border p-3.5 text-sm"
                [attr.data-testid]="'pr-comment-' + comment.id"
              >
                <div class="text-muted-foreground text-xs">
                  <span class="text-foreground font-medium">{{
                    comment.author.displayName ?? comment.author.login
                  }}</span>
                </div>
                <app-markdown-view
                  [text]="comment.body"
                  [precomputedBlocks]="markdownMap().get('comment-' + comment.id) ?? null"
                  [isAllowedLink]="isAllowedLink"
                  (openLink)="openLink.emit($event)"
                />
              </article>
            }
          </div>
        }
      }
    </section>

    <!-- Changed Files & Diff -->
    <section class="space-y-2" data-testid="pr-diff-section">
      @switch (diffState().status) {
        @case ('loading') {
          <p class="text-muted-foreground text-sm" i18n>Loading changed files…</p>
        }
        @case ('failed') {
          <div
            class="border-border/60 bg-card flex items-center justify-between rounded-lg border p-4"
          >
            <p class="text-muted-foreground text-sm" i18n>Could not load diff.</p>
            <button hlmBtn variant="outline" size="sm" (click)="retryDiff.emit()" i18n>
              Retry
            </button>
          </div>
        }
        @case ('loaded') {
          @if (diffState(); as loadedDiff) {
            @if (loadedDiff.status === 'loaded') {
              <app-pr-diff-view
                [diff]="loadedDiff.diff"
                [threads]="detail().reviewThreads"
                [renderClient]="renderClient()"
                [markdownBlocks]="markdownMap()"
                [isAllowedLink]="isAllowedLink"
                (openLink)="openLink.emit($event)"
              />
            }
          }
        }
      }
    </section>
  `,
})
export class PrDetailPane {
  readonly detail = input.required<PullRequestDetail>();
  readonly diffState = input.required<DiffLoadState>();
  readonly renderClient = input.required<PrRenderClient>();
  readonly selectedThreadId = input<ReviewThreadId | null>(null);
  readonly selectedCheckId = input<CheckRunId | null>(null);
  readonly retryDiff = output<void>();
  readonly openLink = output<string>();
  readonly referencePr = output<void>();
  readonly startSession = output<void>();
  readonly referenceThread = output<ReviewThread>();
  readonly referenceCheck = output<CheckRun>();

  protected readonly checksExpanded = signal(false);
  private readonly expandedCheckIds = signal<ReadonlySet<string>>(new Set());
  protected readonly markdownMap = signal<ReadonlyMap<string, ReadonlyArray<MarkdownBlock>>>(
    new Map(),
  );
  private markdownGen = 0;

  protected readonly detailsLabel = $localize`Show output`;
  protected readonly hideDetailsLabel = $localize`Hide output`;
  protected readonly resolvedLabel = $localize`Resolved`;
  protected readonly unresolvedLabel = $localize`Unresolved`;

  protected readonly prStateLabel = prStateLabel;
  protected readonly checkRollupLabel = checkRollupLabel;
  protected readonly mergeStateLabel = mergeStateLabel;
  protected readonly reviewDecisionLabel = reviewDecisionLabel;
  protected readonly reviewStateLabel = reviewStateLabel;
  protected readonly isNonBlockingCheck = isNonBlockingCheck;
  protected readonly isAllowedLink = isAllowedExternalUrl;

  protected isFailingCheck(check: CheckRun): boolean {
    return (
      check.conclusion === 'failure' ||
      check.conclusion === 'timedOut' ||
      check.conclusion === 'startupFailure' ||
      check.conclusion === 'actionRequired'
    );
  }

  protected readonly failingCheckCount = computed(
    () => this.detail().checks.filter((c) => this.isFailingCheck(c)).length,
  );

  protected readonly pendingCheckCount = computed(
    () =>
      this.detail().checks.filter((c) => c.status === 'queued' || c.status === 'inProgress').length,
  );

  constructor() {
    effect(() => {
      const checkId = this.selectedCheckId();
      if (checkId !== null) {
        this.checksExpanded.set(true);
        this.expandedCheckIds.update((prev) => new Set([...prev, checkId]));
      }
    });

    effect(() => {
      const d = this.detail();
      const client = this.renderClient();
      const gen = ++this.markdownGen;

      const items: Array<{ readonly id: string; readonly text: string }> = [];
      if (d.body.trim().length > 0) {
        items.push({ id: 'body', text: d.body });
      }
      for (const review of d.reviews) {
        if (review.body.trim().length > 0) {
          items.push({ id: `review-${review.id}`, text: review.body });
        }
      }
      for (const comment of d.comments) {
        items.push({ id: `comment-${comment.id}`, text: comment.body });
      }
      for (const thread of d.reviewThreads) {
        for (const comment of thread.comments) {
          items.push({ id: `thread-${comment.id}`, text: comment.body });
        }
      }
      for (const check of d.checks) {
        if (check.summary !== null && check.summary.trim().length > 0) {
          items.push({ id: `check-${check.id}`, text: check.summary });
        }
      }

      void client.renderMarkdownBatch(items).then((map) => {
        if (gen === this.markdownGen) {
          this.markdownMap.set(map);
        }
      });
    });
  }

  protected stateBadgeVariant(): 'default' | 'secondary' | 'destructive' | 'outline' {
    switch (this.detail().state) {
      case 'open':
        return 'default';
      case 'draft':
        return 'secondary';
      case 'merged':
        return 'secondary';
      case 'closed':
        return 'destructive';
    }
  }

  protected checkBadgeVariant(
    check: CheckRun,
  ): 'default' | 'secondary' | 'destructive' | 'outline' {
    if (check.status !== 'completed') return 'secondary';
    if (check.conclusion === 'success') return 'default';
    if (isNonBlockingCheck(check)) return 'outline';
    return 'destructive';
  }

  protected checkConclusionLabel(check: CheckRun): string {
    if (check.status !== 'completed') {
      return check.status === 'queued' ? $localize`Queued` : $localize`Running`;
    }
    return check.conclusion ?? $localize`Completed`;
  }

  protected isCheckSummaryExpanded(id: string): boolean {
    return this.expandedCheckIds().has(id);
  }

  protected toggleCheckSummary(id: string): void {
    const next = new Set(this.expandedCheckIds());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.expandedCheckIds.set(next);
  }

  protected formatActors(
    actors: ReadonlyArray<{ readonly login: string; readonly displayName: string | null }>,
  ): string {
    return actors.map((a) => a.displayName ?? a.login).join(', ');
  }
}
