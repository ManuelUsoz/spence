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
import { HlmDialogImports } from '@ui/dialog';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import { MarkdownView, type MarkdownBlock } from '@ui/markdown';
import { HlmSelectImports } from '@ui/select';
import { HlmTextareaImports } from '@ui/textarea';
import { isAllowedExternalUrl } from '../../../shared/links/link-policy';
import type {
  AddCommentTarget,
  CheckRun,
  CheckRunId,
  CommentId,
  HostCapabilities,
  LocalBaseUpdateResult,
  MergeMethod,
  PostMergeActionsState,
  PullRequestCommentKind,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestRevision,
  PullRequestUpdatePatch,
  ReviewId,
  ReviewSubmitEvent,
  ReviewThread,
  ReviewThreadId,
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

export type PrDetailTab = 'overview' | 'files';

export type DiffLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'loaded'; readonly diff: PullRequestDiff };

export interface PrConflictState {
  readonly conflictingFields: ReadonlyArray<string>;
  readonly latestDetail: PullRequestDetail;
}

type ConfirmPrompt =
  | {
      readonly kind: 'deleteComment';
      readonly commentId: CommentId;
      readonly commentKind: PullRequestCommentKind;
      readonly title: string;
      readonly description: string;
      readonly confirmLabel: string;
    }
  | {
      readonly kind: 'discardReview';
      readonly reviewId: ReviewId;
      readonly title: string;
      readonly description: string;
      readonly confirmLabel: string;
    };

/**
 * Three-tier Pull request detail inspector:
 * 1. Header & metadata (number, title, state, branches, author, labels, reviewers, assignees, milestone, mergeability, external link, inline edit with conflict resolution)
 * 2. Check rollup & expandable Check runs
 * 3. Conversation (description, top-level Reviews, Review threads, general comments, Finish review bar) and Changed files diff
 */
@Component({
  selector: 'app-pr-detail-pane',
  imports: [
    HlmAlertDialogImports,
    HlmBadgeImports,
    HlmButtonImports,
    HlmDialogImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    HlmSelectImports,
    HlmTextareaImports,
    MarkdownView,
    PrDiffView,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-4 px-4 py-5 sm:px-8', 'data-testid': 'pr-detail-pane' },
  template: `
    <!-- Header & Metadata -->
    <header class="pb-1" data-testid="pr-detail-header">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1 space-y-1.5">
          <h2 class="text-lg font-medium tracking-tight" data-testid="pr-detail-title">
            {{ detail().title }}
          </h2>
          <div class="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <span
              class="text-muted-foreground font-mono text-xs tabular-nums"
              data-testid="pr-detail-number"
            >
              #{{ detail().ref.number }}
            </span>
            <span data-testid="pr-detail-state">
              {{ prStateLabel(detail().state) }}
            </span>
            @if (detail().isPinned) {
              <span aria-hidden="true">·</span>
              <span i18n>Pinned</span>
            }
          </div>
          <div
            class="text-muted-foreground flex flex-wrap items-center gap-2 text-xs"
            data-testid="pr-detail-branches"
          >
            <span class="font-mono text-xs">{{ detail().headRef }}</span>
            <span aria-hidden="true">→</span>
            <span class="font-mono text-xs">{{ detail().baseRef }}</span>
            <span class="text-muted-foreground/70">·</span>
            <span>{{ detail().author.displayName ?? detail().author.login }}</span>
            <span class="text-muted-foreground/70">·</span>
            <span class="font-mono text-xs">{{ detail().headSha.slice(0, 7) }}</span>
          </div>
        </div>

        <div class="flex shrink-0 flex-wrap items-center gap-2">
          @if (detail().actions.canReview) {
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="pr-finish-review"
              (click)="reviewDialogOpen.set(true)"
              i18n
            >
              Finish review
            </button>
          }
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
            variant="ghost"
            size="icon"
            aria-label="More Pull request actions"
            i18n-aria-label
            data-testid="pr-more-actions"
            [hlmDropdownMenuTrigger]="actionsMenu"
          >
            <span aria-hidden="true" class="text-lg leading-none">⋮</span>
          </button>
          <ng-template #actionsMenu>
            <hlm-dropdown-menu>
              <button
                hlmDropdownMenuItem
                type="button"
                data-testid="pr-reference-in-session"
                (triggered)="referencePr.emit()"
                i18n
              >
                Reference in Session
              </button>
              @if (detail().actions.canUpdate && !editMode()) {
                <button
                  hlmDropdownMenuItem
                  type="button"
                  data-testid="pr-edit-button"
                  (triggered)="startEdit()"
                  i18n
                >
                  Edit
                </button>
              }
              <button
                hlmDropdownMenuItem
                type="button"
                data-testid="pr-open-external"
                (triggered)="openLink.emit(detail().url)"
              >
                <svg
                  class="size-3.5 shrink-0"
                  viewBox="0 0 512 512"
                  fill="currentColor"
                  aria-hidden="true"
                  data-testid="pr-open-external-icon"
                >
                  <path
                    fill-rule="evenodd"
                    clip-rule="evenodd"
                    d="M256 6.3C114.6 6.3 0 120.9 0 262.3c0 113.3 73.3 209 175 242.9 12.8 2.2 17.6-5.4 17.6-12.2 0-6.1-.3-26.2-.3-47.7-64.3 11.8-81-15.7-86.1-30.1-2.9-7.4-15.4-30.1-26.2-36.2-9-4.8-21.8-16.6-.3-17 20.2-.3 34.6 18.6 39.4 26.2 23 38.7 59.8 27.8 74.6 21.1 2.2-16.6 9-27.8 16.3-34.2-57-6.4-116.5-28.5-116.5-126.4 0-27.8 9.9-50.9 26.2-68.8-2.6-6.4-11.5-32.6 2.6-67.8 0 0 21.4-6.7 70.4 26.2 20.5-5.8 42.2-8.6 64-8.6s43.5 2.9 64 8.6c49-33.3 70.4-26.2 70.4-26.2 14.1 35.2 5.1 61.4 2.6 67.8 16.3 17.9 26.2 40.6 26.2 68.8 0 98.2-59.8 120-116.8 126.4 9.3 8 17.3 23.4 17.3 47.4 0 34.2-.3 61.8-.3 70.4 0 6.7 4.8 14.7 17.6 12.2C438.7 471.3 512 375.3 512 262.3c0-141.4-114.6-256-256-256"
                  />
                </svg>
                <span i18n>Open in GitHub</span>
              </button>
            </hlm-dropdown-menu>
          </ng-template>
        </div>
      </div>
    </header>

    <!-- Tab Bar -->
    <div
      class="border-border/60 flex items-center gap-4 border-b"
      role="tablist"
      aria-label="Pull request sections"
      i18n-aria-label
    >
      <button
        type="button"
        role="tab"
        [attr.aria-selected]="activeTab() === 'overview'"
        data-testid="pr-tab-overview"
        class="-mb-px border-b-2 pb-2.5 text-sm transition-colors outline-none"
        [class]="
          activeTab() === 'overview'
            ? 'border-foreground text-foreground font-medium'
            : 'text-muted-foreground hover:text-foreground border-transparent'
        "
        (click)="activeTabChange.emit('overview')"
        i18n
      >
        Overview
      </button>
      <button
        type="button"
        role="tab"
        [attr.aria-selected]="activeTab() === 'files'"
        data-testid="pr-tab-files"
        class="-mb-px border-b-2 pb-2.5 text-sm transition-colors outline-none"
        [class]="
          activeTab() === 'files'
            ? 'border-foreground text-foreground font-medium'
            : 'text-muted-foreground hover:text-foreground border-transparent'
        "
        (click)="activeTabChange.emit('files')"
      >
        <span i18n>Files</span>
        @if (diffFileCount(); as count) {
          <span class="text-muted-foreground ml-1.5 text-xs tabular-nums">{{ count }}</span>
        }
      </button>
    </div>

    @if (activeTab() === 'overview') {
      <div role="tabpanel" data-testid="pr-tabpanel-overview" class="space-y-6">
        @if (editMode()) {
          <div
            class="border-border/60 bg-muted/20 space-y-3 rounded-lg border p-4"
            data-testid="pr-edit-form"
          >
            <div class="space-y-1">
              <label class="text-xs font-medium" for="pr-edit-title-input" i18n>Title</label>
              <input
                hlmInput
                id="pr-edit-title-input"
                type="text"
                class="w-full text-sm"
                data-testid="pr-edit-title"
                [value]="draftTitle()"
                (input)="draftTitle.set($any($event.target).value)"
              />
              @if (conflictFor('title'); as remoteVal) {
                <div
                  class="border-destructive/40 bg-destructive/5 flex flex-wrap items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-xs"
                  data-testid="pr-conflict-banner-title"
                >
                  <span>
                    <strong i18n>Changed on GitHub</strong>:
                    <span class="font-mono">{{ remoteVal }}</span>
                  </span>
                  <div class="flex items-center gap-1.5">
                    <button
                      hlmBtn
                      type="button"
                      variant="outline"
                      size="sm"
                      class="h-6 px-2 text-xs"
                      data-testid="pr-conflict-keep-title"
                      (click)="resolveConflict('title', 'keep')"
                      i18n
                    >
                      Keep mine
                    </button>
                    <button
                      hlmBtn
                      type="button"
                      variant="secondary"
                      size="sm"
                      class="h-6 px-2 text-xs"
                      data-testid="pr-conflict-use-title"
                      (click)="resolveConflict('title', 'theirs')"
                      i18n
                    >
                      Use theirs
                    </button>
                  </div>
                </div>
              }
            </div>

            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="space-y-1">
                <label class="text-xs font-medium" for="pr-edit-base-input" i18n>Base branch</label>
                <input
                  hlmInput
                  id="pr-edit-base-input"
                  type="text"
                  class="w-full font-mono text-xs"
                  data-testid="pr-edit-base-ref"
                  [value]="draftBaseRef()"
                  (input)="draftBaseRef.set($any($event.target).value)"
                />
                @if (conflictFor('baseRef'); as remoteVal) {
                  <div
                    class="border-destructive/40 bg-destructive/5 flex flex-wrap items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-xs"
                    data-testid="pr-conflict-banner-baseRef"
                  >
                    <span><strong i18n>Changed on GitHub</strong>: {{ remoteVal }}</span>
                    <div class="flex items-center gap-1.5">
                      <button
                        hlmBtn
                        type="button"
                        variant="outline"
                        size="sm"
                        class="h-6 px-2 text-xs"
                        data-testid="pr-conflict-keep-baseRef"
                        (click)="resolveConflict('baseRef', 'keep')"
                        i18n
                      >
                        Keep mine
                      </button>
                      <button
                        hlmBtn
                        type="button"
                        variant="secondary"
                        size="sm"
                        class="h-6 px-2 text-xs"
                        data-testid="pr-conflict-use-baseRef"
                        (click)="resolveConflict('baseRef', 'theirs')"
                        i18n
                      >
                        Use theirs
                      </button>
                    </div>
                  </div>
                }
              </div>

              @if (capabilities()?.supportsDraft ?? true) {
                <div class="flex items-end pb-1">
                  <label class="flex cursor-pointer items-center gap-2 text-xs font-medium">
                    <input
                      type="checkbox"
                      data-testid="pr-edit-draft"
                      [checked]="draftIsDraft()"
                      (change)="draftIsDraft.set($any($event.target).checked)"
                    />
                    <span i18n>Draft Pull request</span>
                  </label>
                </div>
              }
            </div>

            <div class="space-y-1">
              <label class="text-xs font-medium" for="pr-edit-body-input" i18n>Description</label>
              <textarea
                hlmTextarea
                id="pr-edit-body-input"
                rows="4"
                class="w-full text-sm"
                data-testid="pr-edit-body"
                [value]="draftBody()"
                (input)="draftBody.set($any($event.target).value)"
              ></textarea>
              @if (conflictFor('body'); as remoteVal) {
                <div
                  class="border-destructive/40 bg-destructive/5 flex flex-wrap items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-xs"
                  data-testid="pr-conflict-banner-body"
                >
                  <span><strong i18n>Changed on GitHub</strong>: {{ remoteVal }}</span>
                  <div class="flex items-center gap-1.5">
                    <button
                      hlmBtn
                      type="button"
                      variant="outline"
                      size="sm"
                      class="h-6 px-2 text-xs"
                      data-testid="pr-conflict-keep-body"
                      (click)="resolveConflict('body', 'keep')"
                      i18n
                    >
                      Keep mine
                    </button>
                    <button
                      hlmBtn
                      type="button"
                      variant="secondary"
                      size="sm"
                      class="h-6 px-2 text-xs"
                      data-testid="pr-conflict-use-body"
                      (click)="resolveConflict('body', 'theirs')"
                      i18n
                    >
                      Use theirs
                    </button>
                  </div>
                </div>
              }
            </div>

            @if (detail().collaborators.length > 0) {
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="space-y-1" data-testid="pr-edit-reviewers">
                  <span class="text-xs font-medium" i18n>Reviewers</span>
                  <div class="flex flex-wrap gap-1.5">
                    @for (user of detail().collaborators; track user.login) {
                      <button
                        type="button"
                        class="rounded border px-2 py-0.5 text-xs transition-colors"
                        [class]="
                          draftReviewers().includes(user.login)
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'border-border/60 text-muted-foreground hover:text-foreground'
                        "
                        (click)="toggleStringSelection(draftReviewers, user.login)"
                      >
                        {{ user.displayName ?? user.login }}
                      </button>
                    }
                  </div>
                </div>

                <div class="space-y-1" data-testid="pr-edit-assignees">
                  <span class="text-xs font-medium" i18n>Assignees</span>
                  <div class="flex flex-wrap gap-1.5">
                    @for (user of detail().collaborators; track user.login) {
                      <button
                        type="button"
                        class="rounded border px-2 py-0.5 text-xs transition-colors"
                        [class]="
                          draftAssignees().includes(user.login)
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'border-border/60 text-muted-foreground hover:text-foreground'
                        "
                        (click)="toggleStringSelection(draftAssignees, user.login)"
                      >
                        {{ user.displayName ?? user.login }}
                      </button>
                    }
                  </div>
                </div>
              </div>
            }

            @if (detail().repoLabels.length > 0) {
              <div class="space-y-1" data-testid="pr-edit-labels">
                <span class="text-xs font-medium" i18n>Labels</span>
                <div class="flex flex-wrap gap-1.5">
                  @for (label of detail().repoLabels; track label.name) {
                    <button
                      type="button"
                      class="rounded border px-2 py-0.5 text-xs transition-colors"
                      [class]="
                        draftLabels().includes(label.name)
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'border-border/60 text-muted-foreground hover:text-foreground'
                      "
                      (click)="toggleStringSelection(draftLabels, label.name)"
                    >
                      {{ label.name }}
                    </button>
                  }
                </div>
              </div>
            }

            @if (
              (capabilities()?.supportsMilestones ?? true) && detail().repoMilestones.length > 0
            ) {
              <div class="space-y-1">
                <label class="text-xs font-medium" for="pr-edit-milestone-select" i18n
                  >Milestone</label
                >
                <select
                  id="pr-edit-milestone-select"
                  class="border-border/60 bg-background h-8 w-full max-w-xs rounded-md border px-2 text-xs"
                  data-testid="pr-edit-milestone"
                  [value]="draftMilestoneId() ?? ''"
                  (change)="onMilestoneChange($any($event.target).value)"
                >
                  <option value="" i18n>No milestone</option>
                  @for (ms of detail().repoMilestones; track ms.id) {
                    <option [value]="ms.id">{{ ms.title }}</option>
                  }
                </select>
              </div>
            }

            <div class="flex justify-end gap-2 pt-1">
              <button
                hlmBtn
                type="button"
                variant="ghost"
                size="sm"
                data-testid="pr-edit-cancel"
                (click)="cancelEdit()"
                i18n
              >
                Cancel
              </button>
              <button
                hlmBtn
                type="button"
                variant="default"
                size="sm"
                [disabled]="mutating() || unresolvedConflictCount() > 0"
                data-testid="pr-edit-save"
                (click)="submitEdit()"
                i18n
              >
                Save
              </button>
            </div>
          </div>
        }

        <!-- Description -->
        <section class="max-w-prose space-y-2" data-testid="pr-description-section">
          <h3 class="text-sm font-medium" i18n>Description</h3>
          @if (detail().body.trim().length === 0) {
            <p class="text-muted-foreground text-sm italic" i18n>No description provided.</p>
          } @else {
            <div class="text-sm leading-relaxed">
              <app-markdown-view
                [text]="detail().body"
                [precomputedBlocks]="markdownMap().get('body') ?? null"
                [isAllowedLink]="isAllowedLink"
                (openLink)="openLink.emit($event)"
              />
            </div>
          }
        </section>

        <!-- Metadata -->
        @let isActive = detail().state === 'open' || detail().state === 'draft';
        @if (
          isActive ||
          detail().reviewDecision !== 'none' ||
          detail().milestone ||
          detail().reviewers.length ||
          detail().assignees.length ||
          detail().labels.length
        ) {
          <dl
            class="text-muted-foreground flex flex-wrap gap-x-4 gap-y-2 text-xs"
            data-testid="pr-detail-metadata"
          >
            @if (isActive) {
              <div class="flex items-center gap-1.5">
                <dt class="font-medium" i18n>Mergeability:</dt>
                <dd class="text-foreground" data-testid="pr-detail-merge-state">
                  {{ mergeStateLabel(detail().mergeState) }}
                  @if (detail().autoMergeEnabled) {
                    <span class="text-muted-foreground ml-1" i18n>(Auto-merge on)</span>
                  }
                </dd>
              </div>
            }
            @if (detail().reviewDecision !== 'none') {
              <div class="flex items-center gap-1.5">
                <dt class="font-medium" i18n>Review:</dt>
                <dd class="text-foreground">{{ reviewDecisionLabel(detail().reviewDecision) }}</dd>
              </div>
            }
            @if (detail().milestone; as milestone) {
              <div class="flex items-center gap-1.5">
                <dt class="font-medium" i18n>Milestone:</dt>
                <dd class="text-foreground" data-testid="pr-detail-milestone">
                  {{ milestone.title }}
                </dd>
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
        }

        @if (isActive && detail().mergeStateReason) {
          <p class="text-muted-foreground text-xs" data-testid="pr-merge-state-reason">
            {{ detail().mergeStateReason }}
          </p>
        }

        <!-- Merge & Auto-merge / Merged Actions -->
        @if (isActive) {
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
            class="border-border/60 flex flex-wrap items-center gap-3 border-y py-2"
            data-testid="pr-merged-strip"
          >
            <div class="min-w-0 space-y-0.5">
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

        <!-- Merge Confirmation Modal -->
        <hlm-alert-dialog
          [state]="confirmMergeOpen() ? 'open' : 'closed'"
          (stateChanged)="onMergeConfirmDialogStateChange($event)"
        >
          <hlm-alert-dialog-content
            *hlmAlertDialogPortal="let ctx"
            data-testid="pr-merge-confirm-dialog"
          >
            <hlm-alert-dialog-header>
              <h2 hlmAlertDialogTitle class="text-lg font-medium" i18n>
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
        <section data-testid="pr-checks-section">
          <button
            type="button"
            class="hover:bg-accent/50 focus-visible:ring-ring flex w-full items-center gap-3 rounded-md py-2 text-left outline-none focus-visible:ring-2"
            [attr.aria-expanded]="checksExpanded()"
            data-testid="pr-checks-toggle"
            (click)="checksExpanded.set(!checksExpanded())"
          >
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span class="text-muted-foreground w-3 text-xs" aria-hidden="true">{{
                checksExpanded() ? '▾' : '▸'
              }}</span>
              <span data-testid="pr-checks-rollup">{{
                checkRollupLabel(detail().checkRollup)
              }}</span>
              <span class="text-muted-foreground font-normal tabular-nums">
                ({{ detail().checks.length }})
              </span>
            </div>
          </button>

          @if (checksExpanded() || exceptionalChecks().length > 0) {
            <div class="border-border/60 divide-border/60 divide-y border-t">
              @if (detail().checks.length === 0) {
                <p class="text-muted-foreground px-4 py-3 text-xs" i18n>
                  No check runs reported for this commit.
                </p>
              } @else {
                @for (
                  check of checksExpanded() ? detail().checks : exceptionalChecks();
                  track check.id
                ) {
                  <div class="px-4 py-2.5" [attr.data-testid]="'pr-check-' + check.id">
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex min-w-0 items-center gap-2">
                        <span
                          class="w-4 shrink-0 text-center text-xs"
                          [class.text-destructive]="isFailingCheck(check)"
                          [class.text-chart-2]="
                            check.status === 'completed' && check.conclusion === 'success'
                          "
                          [class.text-chart-4]="check.status !== 'completed'"
                          [attr.aria-label]="checkConclusionLabel(check)"
                          [title]="checkConclusionLabel(check)"
                          >{{
                            isFailingCheck(check)
                              ? '✕'
                              : check.status !== 'completed'
                                ? '◷'
                                : check.conclusion === 'success'
                                  ? '✓'
                                  : '–'
                          }}</span
                        >
                        <span class="truncate text-xs">{{ check.name }}</span>
                        @if (check.isRequired && isFailingCheck(check)) {
                          <span class="text-muted-foreground text-xs" i18n>Required</span>
                        }
                        @if (isNonBlockingCheck(check)) {
                          <span class="text-muted-foreground text-xs" i18n>Non-blocking</span>
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
                            aria-label="Open check details"
                            i18n-aria-label
                            title="Open check details"
                            i18n-title
                          >
                            <span aria-hidden="true">↗</span>
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

        <!-- Conversation: Top-level Reviews, Review Threads & General Comments -->
        <section class="space-y-4" data-testid="pr-conversation-section">
          @if (
            detail().reviews.length || detail().comments.length || detail().reviewThreads.length
          ) {
            <h3 class="text-sm font-medium" i18n>Conversation</h3>

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
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          class="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
                          [attr.data-testid]="'pr-thread-reference-' + thread.id"
                          (click)="referenceThread.emit(thread)"
                          i18n
                        >
                          Reference in Session
                        </button>
                        @if (
                          (capabilities()?.supportsThreadResolution ?? true) &&
                          detail().actions.canResolveThreads
                        ) {
                          <button
                            hlmBtn
                            type="button"
                            variant="ghost"
                            size="sm"
                            class="h-6 px-2 text-xs"
                            [disabled]="mutating()"
                            [attr.data-testid]="'pr-thread-resolve-toggle-' + thread.id"
                            (click)="
                              resolveThread.emit({
                                threadId: thread.id,
                                resolved: !thread.isResolved,
                              })
                            "
                          >
                            {{ thread.isResolved ? unresolveLabel : resolveLabel }}
                          </button>
                        }
                      </div>
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
                    <div
                      class="text-muted-foreground flex items-center justify-between gap-2 text-xs"
                    >
                      <span class="text-foreground font-medium">{{
                        comment.author.displayName ?? comment.author.login
                      }}</span>
                      @if (isOwnComment(comment.author.login)) {
                        <div class="flex items-center gap-1">
                          <button
                            hlmBtn
                            type="button"
                            variant="ghost"
                            size="sm"
                            class="h-6 px-2 text-xs"
                            [attr.data-testid]="'pr-comment-edit-' + comment.id"
                            (click)="startEditComment(comment.id, comment.body)"
                            i18n
                          >
                            Edit
                          </button>
                          <button
                            hlmBtn
                            type="button"
                            variant="ghost"
                            size="sm"
                            class="text-destructive h-6 px-2 text-xs"
                            [attr.data-testid]="'pr-comment-delete-' + comment.id"
                            (click)="confirmDeleteComment(comment.id, 'issue', comment.body)"
                            i18n
                          >
                            Delete
                          </button>
                        </div>
                      }
                    </div>
                    @if (editingIssueCommentId() === comment.id) {
                      <div class="space-y-2">
                        <textarea
                          hlmTextarea
                          rows="3"
                          class="w-full text-sm"
                          [attr.data-testid]="'pr-comment-edit-input-' + comment.id"
                          [value]="editingIssueCommentBody()"
                          (input)="editingIssueCommentBody.set($any($event.target).value)"
                        ></textarea>
                        <div class="flex justify-end gap-2">
                          <button
                            hlmBtn
                            type="button"
                            variant="ghost"
                            size="sm"
                            (click)="editingIssueCommentId.set(null)"
                            i18n
                          >
                            Cancel
                          </button>
                          <button
                            hlmBtn
                            type="button"
                            variant="default"
                            size="sm"
                            [disabled]="mutating() || editingIssueCommentBody().trim().length === 0"
                            [attr.data-testid]="'pr-comment-edit-save-' + comment.id"
                            (click)="saveIssueCommentEdit(comment.id)"
                            i18n
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    } @else {
                      <app-markdown-view
                        [text]="comment.body"
                        [precomputedBlocks]="markdownMap().get('comment-' + comment.id) ?? null"
                        [isAllowedLink]="isAllowedLink"
                        (openLink)="openLink.emit($event)"
                      />
                    }
                  </article>
                }
              </div>
            }
          }

          @if (detail().actions.canReview) {
            <div class="flex w-full flex-col gap-2" data-testid="pr-general-comment-composer">
              <textarea
                hlmTextarea
                rows="3"
                class="w-full text-xs"
                placeholder="Leave a comment…"
                i18n-placeholder
                aria-label="Comment"
                i18n-aria-label
                data-testid="pr-general-comment-input"
                [value]="generalCommentBody()"
                (input)="generalCommentBody.set($any($event.target).value)"
              ></textarea>
              <div class="flex justify-end">
                <button
                  hlmBtn
                  type="button"
                  variant="default"
                  size="sm"
                  [disabled]="mutating() || generalCommentBody().trim().length === 0"
                  data-testid="pr-general-comment-submit"
                  (click)="submitGeneralComment()"
                  i18n
                >
                  Comment
                </button>
              </div>
            </div>
          }
        </section>
      </div>
    } @else {
      <div role="tabpanel" data-testid="pr-tabpanel-files" class="space-y-4">
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
                    [canComment]="detail().actions.canReview"
                    [supportsPendingReviews]="capabilities()?.supportsPendingReviews ?? true"
                    [hasPendingReview]="pendingReview() !== null"
                    [pendingReviewId]="pendingReview()?.id ?? null"
                    [supportsThreadResolution]="capabilities()?.supportsThreadResolution ?? true"
                    [canResolveThreads]="detail().actions.canResolveThreads"
                    [viewerLogin]="detail().viewerLogin ?? null"
                    [mutating]="mutating()"
                    (openLink)="openLink.emit($event)"
                    (addInlineComment)="onInlineComment($event)"
                    (replyToThread)="onReplyToThread($event)"
                    (editComment)="
                      editComment.emit({
                        commentId: $event.commentId,
                        kind: 'review',
                        body: $event.body,
                      })
                    "
                    (deleteComment)="confirmDeleteComment($event.commentId, 'review', $event.label)"
                    (resolveThread)="resolveThread.emit($event)"
                    (activeFileChange)="activeFileChange.emit($event)"
                  />
                }
              }
            }
          }
        </section>
      </div>
    }

    <hlm-dialog
      [state]="reviewDialogOpen() ? 'open' : 'closed'"
      (stateChanged)="$event === 'closed' && reviewDialogOpen.set(false)"
    >
      <hlm-dialog-content *hlmDialogPortal data-testid="pr-finish-review-dialog">
        <hlm-dialog-header>
          <h3 hlmDialogTitle i18n>Finish review</h3>
          <p hlmDialogDescription i18n>Choose how to submit your review.</p>
        </hlm-dialog-header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 text-xs font-medium">
            @if (pendingReview(); as pending) {
              <span hlmBadge variant="secondary" class="text-[10px] tabular-nums" i18n>
                Pending ({{ pendingInlineCommentCount() }} inline)
              </span>
            }
          </div>
          @if (pendingReview(); as pending) {
            <button
              hlmBtn
              type="button"
              variant="ghost"
              size="sm"
              class="text-destructive h-6 px-2 text-xs"
              [disabled]="mutating()"
              data-testid="pr-review-discard"
              (click)="reviewDialogOpen.set(false); confirmDiscardReview(pending.id)"
              i18n
            >
              Discard review
            </button>
          }
        </div>
        <textarea
          hlmTextarea
          rows="2"
          class="w-full text-xs"
          placeholder="Leave a review summary (optional for Comment / Approve)…"
          i18n-placeholder
          data-testid="pr-review-summary-input"
          [value]="reviewSummaryBody()"
          (input)="reviewSummaryBody.set($any($event.target).value)"
        ></textarea>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="sm"
            (click)="reviewDialogOpen.set(false)"
            i18n
          >
            Cancel
          </button>
          <button
            hlmBtn
            type="button"
            variant="outline"
            size="sm"
            [disabled]="mutating()"
            data-testid="pr-review-submit-comment"
            (click)="submitReviewAction('comment')"
            i18n
          >
            Comment
          </button>
          <button
            hlmBtn
            type="button"
            variant="outline"
            size="sm"
            [disabled]="mutating() || !detail().actions.canApproveOrRequestChanges"
            data-testid="pr-review-submit-approve"
            (click)="submitReviewAction('approve')"
            i18n
          >
            Approve
          </button>
          <button
            hlmBtn
            type="button"
            variant="default"
            size="sm"
            [disabled]="
              mutating() || !detail().actions.canApproveOrRequestChanges || !canRequestChanges()
            "
            data-testid="pr-review-submit-request-changes"
            (click)="submitReviewAction('requestChanges')"
            i18n
          >
            Request changes
          </button>
        </div>
      </hlm-dialog-content>
    </hlm-dialog>

    <hlm-alert-dialog
      [state]="confirmPrompt() === null ? 'closed' : 'open'"
      (stateChanged)="onConfirmDialogStateChange($event)"
    >
      <hlm-alert-dialog-content *hlmAlertDialogPortal="let ctx" data-testid="pr-confirm-dialog">
        @if (confirmPrompt(); as prompt) {
          <hlm-alert-dialog-header>
            <h2 hlmAlertDialogTitle class="text-lg font-medium">
              {{ prompt.title }}
            </h2>
            <p hlmAlertDialogDescription>{{ prompt.description }}</p>
          </hlm-alert-dialog-header>
          <hlm-alert-dialog-footer>
            <button
              hlmAlertDialogCancel
              data-testid="pr-confirm-cancel"
              (click)="confirmPrompt.set(null)"
              i18n
            >
              Cancel
            </button>
            <button
              hlmAlertDialogAction
              variant="destructive"
              data-testid="pr-confirm-action"
              (click)="runConfirmPrompt()"
            >
              {{ prompt.confirmLabel }}
            </button>
          </hlm-alert-dialog-footer>
        }
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
  `,
})
export class PrDetailPane {
  private readonly keymap = inject(Keymap);

  readonly detail = input.required<PullRequestDetail>();
  readonly diffState = input.required<DiffLoadState>();
  readonly renderClient = input.required<PrRenderClient>();
  readonly selectedThreadId = input<ReviewThreadId | null>(null);
  readonly selectedCheckId = input<CheckRunId | null>(null);
  readonly capabilities = input<HostCapabilities | null>(null);
  readonly readOnly = input(false);
  readonly merging = input(false);
  readonly autoMergeBusy = input(false);
  readonly lastBaseUpdate = input<LocalBaseUpdateResult | null>(null);
  readonly postMergeStatus = input<PostMergeActionsState | null>(null);
  readonly updatingBase = input(false);
  readonly switchingBase = input(false);
  readonly mutating = input<boolean>(false);
  readonly conflictState = input<PrConflictState | null>(null);
  readonly activeTab = input<PrDetailTab>('overview');

  readonly activeTabChange = output<PrDetailTab>();
  readonly activeFileChange = output<string | null>();
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
  readonly referencePr = output<void>();
  readonly startSession = output<void>();
  readonly referenceThread = output<ReviewThread>();
  readonly referenceCheck = output<CheckRun>();
  readonly saveEdit = output<{
    readonly revision: PullRequestRevision;
    readonly patch: PullRequestUpdatePatch;
    readonly baseline: PullRequestUpdatePatch;
  }>();
  readonly clearConflict = output<void>();
  readonly addComment = output<{ readonly body: string; readonly target: AddCommentTarget }>();
  readonly editComment = output<{
    readonly commentId: CommentId;
    readonly kind: PullRequestCommentKind;
    readonly body: string;
  }>();
  readonly deleteComment = output<{
    readonly commentId: CommentId;
    readonly kind: PullRequestCommentKind;
  }>();
  readonly submitReview = output<{
    readonly reviewId?: ReviewId;
    readonly event: ReviewSubmitEvent;
    readonly body: string;
  }>();
  readonly deletePendingReview = output<{ readonly reviewId: ReviewId }>();
  readonly resolveThread = output<{
    readonly threadId: ReviewThreadId;
    readonly resolved: boolean;
  }>();

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

  protected readonly diffFileCount = computed(() => {
    const s = this.diffState();
    return s.status === 'loaded' ? s.diff.files.length : null;
  });

  protected readonly checksExpanded = signal(false);
  private readonly expandedCheckIds = signal<ReadonlySet<string>>(new Set());
  protected readonly markdownMap = signal<ReadonlyMap<string, ReadonlyArray<MarkdownBlock>>>(
    new Map(),
  );
  private markdownGen = 0;

  protected readonly editMode = signal(false);
  protected readonly draftTitle = signal('');
  protected readonly draftBody = signal('');
  protected readonly draftBaseRef = signal('');
  protected readonly draftIsDraft = signal(false);
  protected readonly draftReviewers = signal<ReadonlyArray<string>>([]);
  protected readonly draftAssignees = signal<ReadonlyArray<string>>([]);
  protected readonly draftLabels = signal<ReadonlyArray<string>>([]);
  protected readonly draftMilestoneId = signal<string | null>(null);
  private editBaseline: PullRequestUpdatePatch | null = null;
  private editRevision: PullRequestRevision | null = null;
  protected readonly resolvedConflicts = signal<ReadonlySet<string>>(new Set());

  protected readonly generalCommentBody = signal('');
  protected readonly reviewDialogOpen = signal(false);
  protected readonly editingIssueCommentId = signal<CommentId | null>(null);
  protected readonly editingIssueCommentBody = signal('');
  protected readonly reviewSummaryBody = signal('');
  protected readonly confirmPrompt = signal<ConfirmPrompt | null>(null);

  protected readonly detailsLabel = $localize`Show output`;
  protected readonly hideDetailsLabel = $localize`Hide output`;
  protected readonly resolvedLabel = $localize`Resolved`;
  protected readonly unresolvedLabel = $localize`Unresolved`;
  protected readonly resolveLabel = $localize`Resolve conversation`;
  protected readonly unresolveLabel = $localize`Unresolve conversation`;

  protected readonly pendingReview = computed(() => {
    const d = this.detail();
    const viewer = d.viewerLogin;
    return (
      d.reviews.find(
        (r) =>
          r.state === 'pending' &&
          (viewer === undefined ||
            viewer === null ||
            r.author.login.toLowerCase() === viewer.toLowerCase()),
      ) ?? null
    );
  });

  protected readonly pendingInlineCommentCount = computed(() => {
    const pending = this.pendingReview();
    if (pending === null) return 0;
    let count = 0;
    for (const thread of this.detail().reviewThreads) {
      for (const comment of thread.comments) {
        if (comment.reviewId === pending.id) count += 1;
      }
    }
    return count;
  });

  protected readonly canRequestChanges = computed(
    () => this.reviewSummaryBody().trim().length > 0 || this.pendingInlineCommentCount() > 0,
  );

  protected readonly unresolvedConflictCount = computed(() => {
    const c = this.conflictState();
    if (c === null) return 0;
    const resolved = this.resolvedConflicts();
    return c.conflictingFields.filter((f) => !resolved.has(f)).length;
  });

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

  protected readonly exceptionalChecks = computed(() =>
    this.detail().checks.filter(
      (check) => this.isFailingCheck(check) || check.status !== 'completed',
    ),
  );

  constructor() {
    effect((onCleanup) => {
      if (!this.reviewDialogOpen()) return;
      const release = this.keymap.pushModal({ onEscape: () => this.reviewDialogOpen.set(false) });
      onCleanup(release);
    });

    effect((onCleanup) => {
      if (!this.confirmMergeOpen()) return;
      const release = this.keymap.pushModal({ onEscape: () => this.closeMergeConfirm() });
      onCleanup(release);
    });

    effect(() => {
      const checkId = this.selectedCheckId();
      if (checkId !== null) {
        this.activeTabChange.emit('overview');
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

    effect((onCleanup) => {
      if (this.confirmPrompt() === null) return;
      const release = this.keymap.pushModal({ onEscape: () => this.confirmPrompt.set(null) });
      onCleanup(release);
    });
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

  protected onMergeConfirmDialogStateChange(next: string): void {
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

  protected startEdit(): void {
    this.activeTabChange.emit('overview');
    const d = this.detail();
    this.draftTitle.set(d.title);
    this.draftBody.set(d.body);
    this.draftBaseRef.set(d.baseRef);
    this.draftIsDraft.set(d.state === 'draft');
    this.draftReviewers.set(d.reviewers.map((r) => r.login));
    this.draftAssignees.set(d.assignees.map((a) => a.login));
    this.draftLabels.set(d.labels.map((l) => l.name));
    this.draftMilestoneId.set(d.milestone?.id ?? null);
    this.editBaseline = {
      title: d.title,
      body: d.body,
      baseRef: d.baseRef,
      draft: d.state === 'draft',
      reviewers: d.reviewers.map((r) => r.login),
      assignees: d.assignees.map((a) => a.login),
      labels: d.labels.map((l) => l.name),
      milestoneId: d.milestone?.id ?? null,
    };
    this.editRevision = d.revision;
    this.resolvedConflicts.set(new Set());
    this.clearConflict.emit();
    this.editMode.set(true);
  }

  protected cancelEdit(): void {
    this.editMode.set(false);
    this.clearConflict.emit();
  }

  protected toggleStringSelection(
    sig: ReturnType<typeof signal<ReadonlyArray<string>>>,
    value: string,
  ): void {
    const current = sig();
    if (current.includes(value)) {
      sig.set(current.filter((v) => v !== value));
    } else {
      sig.set([...current, value]);
    }
  }

  protected onMilestoneChange(value: string): void {
    this.draftMilestoneId.set(value.length === 0 ? null : value);
  }

  protected conflictFor(field: string): string | null {
    const c = this.conflictState();
    if (c === null || !c.conflictingFields.includes(field) || this.resolvedConflicts().has(field)) {
      return null;
    }
    switch (field) {
      case 'title':
        return c.latestDetail.title;
      case 'body':
        return c.latestDetail.body;
      case 'baseRef':
        return c.latestDetail.baseRef;
      default:
        return null;
    }
  }

  protected resolveConflict(field: string, choice: 'keep' | 'theirs'): void {
    const c = this.conflictState();
    if (c !== null && choice === 'theirs') {
      if (field === 'title') this.draftTitle.set(c.latestDetail.title);
      if (field === 'body') this.draftBody.set(c.latestDetail.body);
      if (field === 'baseRef') this.draftBaseRef.set(c.latestDetail.baseRef);
    }
    this.resolvedConflicts.update((prev) => {
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  }

  protected submitEdit(): void {
    const base = this.editBaseline;
    const rev = this.conflictState()?.latestDetail.revision ?? this.editRevision;
    if (base === null || rev === null) return;
    const patch: PullRequestUpdatePatch = {
      ...(this.draftTitle() !== base.title ? { title: this.draftTitle() } : {}),
      ...(this.draftBody() !== base.body ? { body: this.draftBody() } : {}),
      ...(this.draftBaseRef() !== base.baseRef ? { baseRef: this.draftBaseRef() } : {}),
      ...(this.draftIsDraft() !== base.draft ? { draft: this.draftIsDraft() } : {}),
      ...(JSON.stringify(this.draftReviewers()) !== JSON.stringify(base.reviewers)
        ? { reviewers: this.draftReviewers() }
        : {}),
      ...(JSON.stringify(this.draftAssignees()) !== JSON.stringify(base.assignees)
        ? { assignees: this.draftAssignees() }
        : {}),
      ...(JSON.stringify(this.draftLabels()) !== JSON.stringify(base.labels)
        ? { labels: this.draftLabels() }
        : {}),
      ...(this.draftMilestoneId() !== base.milestoneId
        ? { milestoneId: this.draftMilestoneId() }
        : {}),
    };
    this.saveEdit.emit({
      revision: rev,
      patch,
      baseline: base,
    });
  }

  public closeEditForm(): void {
    this.editMode.set(false);
  }

  protected isOwnComment(login: string): boolean {
    const viewer = this.detail().viewerLogin;
    return viewer !== undefined && viewer !== null && viewer.toLowerCase() === login.toLowerCase();
  }

  protected startEditComment(commentId: CommentId, body: string): void {
    this.editingIssueCommentId.set(commentId);
    this.editingIssueCommentBody.set(body);
  }

  protected saveIssueCommentEdit(commentId: CommentId): void {
    const body = this.editingIssueCommentBody().trim();
    if (body.length === 0) return;
    this.editComment.emit({ commentId, kind: 'issue', body });
    this.editingIssueCommentId.set(null);
  }

  protected submitGeneralComment(): void {
    const body = this.generalCommentBody().trim();
    if (body.length === 0) return;
    this.addComment.emit({ body, target: { _tag: 'General' } });
    this.generalCommentBody.set('');
  }

  protected onInlineComment(event: {
    readonly path: string;
    readonly line: number;
    readonly side: 'LEFT' | 'RIGHT';
    readonly startLine?: number;
    readonly startSide?: 'LEFT' | 'RIGHT';
    readonly body: string;
    readonly pending: boolean;
  }): void {
    this.addComment.emit({
      body: event.body,
      target: {
        _tag: 'DiffLine',
        path: event.path,
        line: event.line,
        side: event.side,
        ...(event.startLine !== undefined ? { startLine: event.startLine } : {}),
        ...(event.startSide !== undefined ? { startSide: event.startSide } : {}),
        pending: event.pending,
      },
    });
  }

  protected onReplyToThread(event: {
    readonly threadId: ReviewThreadId;
    readonly body: string;
  }): void {
    this.addComment.emit({
      body: event.body,
      target: { _tag: 'ThreadReply', threadId: event.threadId },
    });
  }

  protected submitReviewAction(event: ReviewSubmitEvent): void {
    const pending = this.pendingReview();
    this.submitReview.emit({
      ...(pending !== null ? { reviewId: pending.id } : {}),
      event,
      body: this.reviewSummaryBody().trim(),
    });
    this.reviewSummaryBody.set('');
    this.reviewDialogOpen.set(false);
  }

  protected confirmDeleteComment(
    commentId: CommentId,
    commentKind: PullRequestCommentKind,
    preview: string,
  ): void {
    const trimmed = preview.trim().slice(0, 60);
    this.confirmPrompt.set({
      kind: 'deleteComment',
      commentId,
      commentKind,
      title: $localize`Delete comment?`,
      description:
        trimmed.length > 0
          ? $localize`This will permanently delete "${trimmed}".`
          : $localize`This will permanently delete your comment.`,
      confirmLabel: $localize`Delete`,
    });
  }

  protected confirmDiscardReview(reviewId: ReviewId): void {
    this.confirmPrompt.set({
      kind: 'discardReview',
      reviewId,
      title: $localize`Discard pending review?`,
      description: $localize`This will delete your pending review and its unsubmitted inline comments.`,
      confirmLabel: $localize`Discard`,
    });
  }

  protected onConfirmDialogStateChange(next: string): void {
    if (next === 'closed') this.confirmPrompt.set(null);
  }

  protected runConfirmPrompt(): void {
    const prompt = this.confirmPrompt();
    this.confirmPrompt.set(null);
    if (prompt === null) return;
    if (prompt.kind === 'deleteComment') {
      this.deleteComment.emit({ commentId: prompt.commentId, kind: prompt.commentKind });
    } else {
      this.deletePendingReview.emit({ reviewId: prompt.reviewId });
    }
  }
}
