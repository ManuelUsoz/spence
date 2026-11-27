import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButtonImports } from '@ui/button';
import { HlmInputImports } from '@ui/input';
import { MarkdownView, type MarkdownBlock } from '@ui/markdown';
import { HlmSelectImports } from '@ui/select';
import { isAllowedExternalUrl } from '../../../shared/links/link-policy';
import type {
  CheckRun,
  HostCapabilities,
  LocalBaseUpdateResult,
  MergeMethod,
  PostMergeActionsState,
  PullRequestDetail,
  PullRequestDiff,
} from '../../../shared/pull-requests/pull-requests.rpc';
import { Keymap } from '../../core/keymap';
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
  imports: [
    HlmAlertDialogImports,
    HlmBadgeImports,
    HlmButtonImports,
    HlmInputImports,
    HlmSelectImports,
    MarkdownView,
    PrDiffView,
  ],
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
        <p class="text-muted-foreground text-xs" data-testid="pr-merge-state-reason">
          {{ detail().mergeStateReason }}
        </p>
      }

      <!-- Merge & Auto-merge / Merged Actions -->
      @if (detail().state === 'open' || detail().state === 'draft') {
        <div
          class="border-border/60 bg-muted/20 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5"
          data-testid="pr-merge-bar"
        >
          <div class="min-w-0 space-y-0.5">
            <p class="text-sm font-medium">{{ mergeHeadline() }}</p>
            <p class="text-muted-foreground text-xs">{{ mergeSubline() }}</p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            @if (detail().actions.allowedMergeMethods.length > 0) {
              <hlm-select [value]="selectedMethod()" (valueChange)="onMethodChange($event)">
                <hlm-select-trigger
                  class="h-8 text-xs"
                  data-testid="pr-merge-method-select"
                  aria-label="Merge method"
                  i18n-aria-label
                >
                  {{ mergeMethodLabel(selectedMethod()) }}
                </hlm-select-trigger>
                <hlm-select-content *hlmSelectPortal>
                  @for (m of detail().actions.allowedMergeMethods; track m) {
                    <hlm-select-item [value]="m" [attr.data-value]="m">
                      {{ mergeMethodLabel(m) }}
                    </hlm-select-item>
                  }
                </hlm-select-content>
              </hlm-select>
            }

            <button
              hlmBtn
              type="button"
              size="sm"
              data-testid="pr-merge-btn"
              [disabled]="!canMergeNow()"
              (click)="openMergeConfirm()"
            >
              {{ merging() ? mergingLabel : mergeMethodLabel(selectedMethod()) }}
            </button>

            @if (capabilities()?.supportsAutoMerge && detail().state === 'open') {
              @if (detail().autoMergeEnabled) {
                <button
                  hlmBtn
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="pr-cancel-auto-merge-btn"
                  [disabled]="readOnly() || autoMergeBusy()"
                  (click)="emitAutoMerge(false)"
                  i18n
                >
                  Cancel auto-merge
                </button>
              } @else if (detail().mergeState !== 'clean') {
                <button
                  hlmBtn
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="pr-auto-merge-btn"
                  [disabled]="readOnly() || autoMergeBusy() || !detail().actions.canMerge"
                  (click)="emitAutoMerge(true)"
                  i18n
                >
                  Merge when ready
                </button>
              }
            }
          </div>
        </div>
      } @else if (detail().state === 'merged') {
        <div
          class="border-border/60 bg-muted/20 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5"
          data-testid="pr-merged-strip"
        >
          <div class="min-w-0 space-y-0.5">
            <p class="text-sm font-medium" i18n>Pull request merged</p>
            @if (mergedUpdateMessage(); as msg) {
              <p class="text-muted-foreground text-xs" data-testid="pr-merged-update-status">
                {{ msg }}
              </p>
            }
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="pr-update-base-btn"
              [disabled]="isUpdateBaseDisabled()"
              [title]="updateBaseDisabledReason() ?? ''"
              (click)="updateLocalBase.emit()"
            >
              {{ updatingBase() ? updatingLabel : updateBaseLabel() }}
            </button>

            @if (postMergeStatus()?.switchToBase?.visible) {
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                data-testid="pr-switch-base-btn"
                [disabled]="isSwitchBaseDisabled()"
                [title]="postMergeStatus()?.switchToBase?.reason ?? ''"
                (click)="emitSwitchToBase()"
              >
                {{ switchingBase() ? switchingLabel : switchBaseLabel() }}
              </button>
            }
          </div>
        </div>
      }
    </header>

    <!-- Merge Confirmation Modal -->
    <hlm-alert-dialog
      [state]="confirmMergeOpen() ? 'open' : 'closed'"
      (stateChanged)="onConfirmDialogStateChange($event)"
    >
      <hlm-alert-dialog-content
        *hlmAlertDialogPortal="let ctx"
        data-testid="pr-merge-confirm-dialog"
      >
        <hlm-alert-dialog-header>
          <h2 hlmAlertDialogTitle class="font-display text-xl font-normal" i18n>
            {{ mergeMethodLabel(selectedMethod()) }} #{{ detail().ref.number }}?
          </h2>
          <p hlmAlertDialogDescription>
            <span i18n>Target base branch:</span>
            <code class="bg-muted mx-1 rounded px-1 py-0.5 font-mono text-xs">{{
              detail().baseRef
            }}</code>
            ·
            <span i18n>Head commit:</span>
            <code class="bg-muted ml-1 rounded px-1 py-0.5 font-mono text-xs">{{
              detail().headSha.slice(0, 7)
            }}</code>
          </p>
        </hlm-alert-dialog-header>

        @if (selectedMethod() !== 'rebase') {
          <div class="space-y-2 py-1">
            <input
              hlmInput
              type="text"
              class="w-full text-xs"
              placeholder="Commit title (optional)"
              i18n-placeholder
              data-testid="pr-merge-commit-title"
              [value]="commitTitle()"
              (input)="commitTitle.set($any($event.target).value)"
            />
            <textarea
              hlmInput
              rows="2"
              class="w-full text-xs"
              placeholder="Commit message (optional)"
              i18n-placeholder
              data-testid="pr-merge-commit-message"
              [value]="commitMessage()"
              (input)="commitMessage.set($any($event.target).value)"
            ></textarea>
          </div>
        }

        <hlm-alert-dialog-footer>
          <button
            hlmAlertDialogCancel
            data-testid="pr-merge-cancel"
            (click)="closeMergeConfirm()"
            i18n
          >
            Cancel
          </button>
          <button hlmAlertDialogAction data-testid="pr-merge-confirm" (click)="confirmMerge()">
            {{ mergeMethodLabel(selectedMethod()) }}
          </button>
        </hlm-alert-dialog-footer>
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>

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
                <div class="flex flex-wrap items-center gap-2 text-xs">
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
  private readonly keymap = inject(Keymap);

  readonly detail = input.required<PullRequestDetail>();
  readonly diffState = input.required<DiffLoadState>();
  readonly renderClient = input.required<PrRenderClient>();
  readonly capabilities = input<HostCapabilities | null>(null);
  readonly readOnly = input(false);
  readonly merging = input(false);
  readonly autoMergeBusy = input(false);
  readonly lastBaseUpdate = input<LocalBaseUpdateResult | null>(null);
  readonly postMergeStatus = input<PostMergeActionsState | null>(null);
  readonly updatingBase = input(false);
  readonly switchingBase = input(false);

  readonly retryDiff = output<void>();
  readonly openLink = output<string>();
  readonly mergeRequested = output<{
    readonly method: MergeMethod;
    readonly expectedHeadSha: string;
    readonly commitTitle?: string;
    readonly commitMessage?: string;
  }>();
  readonly autoMergeToggled = output<{
    readonly enabled: boolean;
    readonly method?: MergeMethod;
    readonly expectedHeadSha?: string;
  }>();
  readonly updateLocalBase = output<void>();
  readonly switchToBase = output<string>();

  protected readonly confirmMergeOpen = signal(false);
  protected readonly commitTitle = signal('');
  protected readonly commitMessage = signal('');
  private readonly chosenMethod = signal<MergeMethod | null>(null);

  protected readonly mergingLabel = $localize`Merging…`;
  protected readonly updatingLabel = $localize`Updating…`;
  protected readonly switchingLabel = $localize`Switching…`;

  protected readonly selectedMethod = computed<MergeMethod>(() => {
    const allowed = this.detail().actions.allowedMergeMethods;
    const chosen = this.chosenMethod();
    if (chosen !== null && allowed.includes(chosen)) return chosen;
    if (allowed.includes('squash')) return 'squash';
    return allowed[0] ?? 'merge';
  });

  protected readonly canMergeNow = computed(() => {
    const d = this.detail();
    return (
      !this.readOnly() &&
      !this.merging() &&
      d.state === 'open' &&
      d.actions.canMerge &&
      d.mergeState === 'clean'
    );
  });

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

  protected readonly failingCheckCount = computed(
    () =>
      this.detail().checks.filter(
        (c) =>
          c.conclusion === 'failure' ||
          c.conclusion === 'timedOut' ||
          c.conclusion === 'startupFailure' ||
          c.conclusion === 'actionRequired',
      ).length,
  );

  protected readonly pendingCheckCount = computed(
    () =>
      this.detail().checks.filter((c) => c.status === 'queued' || c.status === 'inProgress').length,
  );

  constructor() {
    effect((onCleanup) => {
      if (!this.confirmMergeOpen()) return;
      const release = this.keymap.pushModal({ onEscape: () => this.closeMergeConfirm() });
      onCleanup(release);
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

  protected mergeMethodLabel(method: MergeMethod): string {
    switch (method) {
      case 'merge':
        return $localize`Merge`;
      case 'squash':
        return $localize`Squash and merge`;
      case 'rebase':
        return $localize`Rebase and merge`;
    }
  }

  protected mergeHeadline(): string {
    const d = this.detail();
    if (d.autoMergeEnabled) return $localize`Auto-merge enabled`;
    if (d.mergeState === 'clean' && d.actions.canMerge) return $localize`Ready to merge`;
    return mergeStateLabel(d.mergeState);
  }

  protected mergeSubline(): string {
    const d = this.detail();
    if (d.mergeStateReason) return d.mergeStateReason;
    if (!d.actions.canMerge)
      return $localize`You do not have permission to merge this Pull request.`;
    return $localize`All checks and merge requirements are satisfied.`;
  }

  protected onMethodChange(value: string | string[] | null | undefined): void {
    const v = Array.isArray(value) ? value[0] : value;
    if (v === 'merge' || v === 'squash' || v === 'rebase') {
      this.chosenMethod.set(v);
    }
  }

  protected openMergeConfirm(): void {
    if (!this.canMergeNow()) return;
    this.commitTitle.set('');
    this.commitMessage.set('');
    this.confirmMergeOpen.set(true);
  }

  protected closeMergeConfirm(): void {
    this.confirmMergeOpen.set(false);
  }

  protected onConfirmDialogStateChange(next: string): void {
    if (next === 'closed') this.confirmMergeOpen.set(false);
  }

  protected confirmMerge(): void {
    const d = this.detail();
    const title = this.commitTitle().trim();
    const message = this.commitMessage().trim();
    this.confirmMergeOpen.set(false);
    this.mergeRequested.emit({
      method: this.selectedMethod(),
      expectedHeadSha: d.headSha,
      ...(title.length > 0 ? { commitTitle: title } : {}),
      ...(message.length > 0 ? { commitMessage: message } : {}),
    });
  }

  protected emitAutoMerge(enabled: boolean): void {
    const d = this.detail();
    this.autoMergeToggled.emit({
      enabled,
      ...(enabled ? { method: this.selectedMethod(), expectedHeadSha: d.headSha } : {}),
    });
  }

  protected updateBaseLabel(): string {
    return $localize`Update ${this.detail().baseRef}`;
  }

  protected switchBaseLabel(): string {
    return $localize`Switch to ${this.detail().baseRef}`;
  }

  protected updateBaseDisabledReason(): string | null {
    const last = this.lastBaseUpdate();
    if (last?._tag === 'Skipped') return last.detail;
    const status = this.postMergeStatus();
    if (status?.updateBase.status === 'disabled') {
      return status.updateBase.reason ?? $localize`Cannot update local base branch.`;
    }
    return null;
  }

  protected isUpdateBaseDisabled(): boolean {
    return this.updatingBase() || this.updateBaseDisabledReason() !== null;
  }

  protected isSwitchBaseDisabled(): boolean {
    return this.switchingBase() || !(this.postMergeStatus()?.switchToBase.enabled ?? false);
  }

  protected mergedUpdateMessage(): string | null {
    const last = this.lastBaseUpdate();
    if (last?._tag === 'Updated') {
      return last.strategy === 'pull'
        ? $localize`Updated ${last.baseRef} locally (git pull --ff-only).`
        : $localize`Updated ${last.baseRef} ref locally (git fetch).`;
    }
    return this.updateBaseDisabledReason() ?? this.postMergeStatus()?.switchToBase.reason ?? null;
  }

  protected emitSwitchToBase(): void {
    const wt = this.postMergeStatus()?.switchToBase.worktreePath;
    if (wt) this.switchToBase.emit(wt);
  }
}
